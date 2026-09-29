#if defined(__linux__)
#define _GNU_SOURCE 1
#endif
#define _POSIX_C_SOURCE 200809L
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE 1
#endif

#include "protocol.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#if defined(__linux__)
#include <sys/syscall.h>
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0U)
#endif
#endif

#if !defined(__APPLE__) && !defined(__linux__)
#error "forgeax secure-store-fs is POSIX-only"
#endif

#ifdef FORGEAX_SECURE_STORE_TEST_BARRIERS
static const char BUILD_MARKER[] = "forgeax-secure-store-fs:test-barriers";
#else
static const char BUILD_MARKER[] = "forgeax-secure-store-fs:release";
#endif

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif
#ifndef O_DIRECTORY
#define O_DIRECTORY 0
#endif
#ifndef O_NOFOLLOW
#error "forgeax secure-store-fs requires O_NOFOLLOW"
#endif
#ifndef AT_SYMLINK_NOFOLLOW
#define AT_SYMLINK_NOFOLLOW 0x100
#endif
#ifndef AT_REMOVEDIR
#define AT_REMOVEDIR 0x200
#endif

/*
 * Linux uses the component-walk fallback here instead of relying on a
 * particular openat2 header/kernel combination.  Every component is opened
 * with O_NOFOLLOW and the final binding is re-walked before each transaction.
 * macOS uses the same openat/fstatat/renameat/unlinkat/mkdirat/linkat path.
 */

static const char *LOCK_NAME = ".writer-lock";
static const char *LOCK_OWNER_NAME = "owner.json";
static const char *BLOBS_NAME = "blobs";
static const char *RESERVATIONS_NAME = ".reservations";
static const char *WIRE_INDEX_NAME = "index.jsonl";
static const char *MODEL_MANIFEST_NAME = "manifest.jsonl";
static const char *WIRE_QUOTA_NAME = "quota.json";
static const char *MODEL_QUOTA_NAME = "quota-state.json";

enum secure_profile {
  PROFILE_WIRE = 1,
  PROFILE_MODEL = 2,
};

struct root_component {
  dev_t dev;
  ino_t ino;
};

static enum secure_profile selected_profile = PROFILE_MODEL;
static int root_fd = -1;
static int root_parent_fd = -1;
static int blobs_fd = -1;
static int reservations_fd = -1;
static char root_path[FORGEAX_SECURE_STORE_FS_MAX_ROOT_BYTES + 1U];
static char root_basename[NAME_MAX + 1U];
static struct root_component root_components[FORGEAX_SECURE_STORE_FS_MAX_ROOT_COMPONENTS];
static size_t root_component_count = 0U;
static unsigned long long temp_counter = 0ULL;
static unsigned char input_buffer[4096U];
static size_t input_offset = 0U;
static size_t input_length = 0U;

#ifdef FORGEAX_SECURE_STORE_TEST_BARRIERS
static char armed_barrier[FORGEAX_SECURE_STORE_FS_MAX_BARRIER_NAME_BYTES + 1U];
#endif

static void close_fd(int *fd) {
  if (fd != NULL && *fd >= 0) {
    (void)close(*fd);
    *fd = -1;
  }
}

static int fail_errno(int value) {
  errno = value;
  return -1;
}

static bool same_file(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static int renameat_noreplace(int old_parent, const char *old_name, int new_parent, const char *new_name) {
#if defined(__APPLE__)
  return renameatx_np(old_parent, old_name, new_parent, new_name, RENAME_EXCL);
#elif defined(__linux__) && defined(SYS_renameat2)
  return (int)syscall(SYS_renameat2, old_parent, old_name, new_parent, new_name, RENAME_NOREPLACE);
#else
  (void)old_parent;
  (void)old_name;
  (void)new_parent;
  (void)new_name;
  return fail_errno(ENOTSUP);
#endif
}

static bool owned_by_process(const struct stat *stats) {
  return stats->st_uid == getuid();
}

static bool private_directory_stat(const struct stat *stats) {
  return S_ISDIR(stats->st_mode) && owned_by_process(stats) && (stats->st_mode & 0777U) == 0700U;
}

static bool regular_file_stat(const struct stat *stats) {
  return S_ISREG(stats->st_mode) && owned_by_process(stats) && stats->st_nlink == 1 && (stats->st_mode & 0777U) == 0600U;
}

static int sync_file(int fd) {
  if (fsync(fd) < 0) return -1;
  return 0;
}

static int sync_directory(int fd) {
  if (fsync(fd) < 0 && errno != EINVAL && errno != EROFS) return -1;
  return 0;
}

static bool safe_token(const char *value, size_t max_bytes) {
  if (value == NULL || value[0] == '\0') return false;
  size_t length = strlen(value);
  if (length > max_bytes || strcmp(value, ".") == 0 || strcmp(value, "..") == 0) return false;
  for (size_t index = 0U; index < length; index++) {
    unsigned char byte = (unsigned char)value[index];
    if (byte < 0x20U || byte == 0x7fU || byte == '/' || byte == '\\') return false;
  }
  return true;
}

static bool safe_name(const char *value) {
  return safe_token(value, FORGEAX_SECURE_STORE_FS_MAX_NAME_BYTES);
}

static const char *manifest_name(void);
static const char *quota_name(void);

static bool lowercase_hex_prefix(const char *value, size_t length) {
  if (value == NULL) return false;
  for (size_t index = 0U; index < length; index++) {
    if (!((value[index] >= '0' && value[index] <= '9') || (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  return true;
}

static bool blob_name_allowed(const char *name) {
  return name != NULL && strlen(name) == 69U && lowercase_hex_prefix(name, 64U) && strcmp(name + 64U, ".json") == 0;
}

static bool reservation_name_allowed(const char *name) {
  if (name == NULL) return false;
  size_t length = strlen(name);
  const size_t suffix_length = 8U;
  if (selected_profile != PROFILE_WIRE || length <= suffix_length || strcmp(name + length - suffix_length, ".reserve") != 0) return false;
  size_t prefix_length = length - suffix_length;
  return prefix_length >= 32U && prefix_length <= 128U && lowercase_hex_prefix(name, prefix_length);
}

static bool named_capability_allowed(const char *operation, char parent_code, const char *name) {
  if (operation == NULL || name == NULL) return false;
  if (parent_code == 'B') {
    if (!blob_name_allowed(name)) return false;
    return strcmp(operation, "READ") == 0 || strcmp(operation, "WRITE_ATOMIC") == 0 ||
      strcmp(operation, "CREATE_IF_ABSENT") == 0 || strcmp(operation, "REMOVE") == 0;
  }
  if (parent_code == 'S') {
    if (!reservation_name_allowed(name)) return false;
    return strcmp(operation, "READ") == 0 || strcmp(operation, "WRITE_EXCLUSIVE") == 0 || strcmp(operation, "REMOVE") == 0;
  }
  if (parent_code != 'R') return false;
  if (strcmp(name, manifest_name()) == 0) {
    return strcmp(operation, "READ") == 0 || strcmp(operation, "APPEND") == 0 || strcmp(operation, "WRITE_ATOMIC") == 0;
  }
  if (strcmp(name, quota_name()) == 0) {
    return strcmp(operation, "READ") == 0 || strcmp(operation, "WRITE_ATOMIC") == 0 ||
      (selected_profile == PROFILE_MODEL && strcmp(operation, "CREATE_IF_ABSENT") == 0);
  }
  return false;
}

static bool safe_nonce(const char *value) {
  if (value == NULL) return false;
  size_t length = strlen(value);
  if (length < 8U || length > FORGEAX_SECURE_STORE_FS_MAX_NAME_BYTES) return false;
  for (size_t index = 0U; index < length; index++) {
    const char byte = value[index];
    if (!((byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'z') ||
          (byte >= 'A' && byte <= 'Z') || byte == '_' || byte == '-')) return false;
  }
  return true;
}

static bool safe_decimal(const char *value) {
  if (value == NULL || value[0] == '\0') return false;
  for (size_t index = 0U; value[index] != '\0'; index++) {
    if (value[index] < '0' || value[index] > '9') return false;
  }
  return true;
}

static bool safe_request_id(const char *value) {
  return safe_decimal(value) && strlen(value) <= 10U && strcmp(value, "0") != 0;
}

static bool hex_byte(char value, unsigned char *out) {
  if (value >= '0' && value <= '9') *out = (unsigned char)(value - '0');
  else if (value >= 'a' && value <= 'f') *out = (unsigned char)(value - 'a' + 10);
  else if (value >= 'A' && value <= 'F') *out = (unsigned char)(value - 'A' + 10);
  else return false;
  return true;
}

static bool decode_hex(const char *encoded, unsigned char **bytes, size_t *length, size_t max_bytes) {
  if (encoded == NULL || bytes == NULL || length == NULL) return false;
  if (strcmp(encoded, "-") == 0) {
    *bytes = NULL;
    *length = 0U;
    return true;
  }
  size_t encoded_length = strlen(encoded);
  if ((encoded_length & 1U) != 0U || encoded_length / 2U > max_bytes) return false;
  unsigned char *result = NULL;
  if (encoded_length > 0U) {
    result = (unsigned char *)malloc(encoded_length / 2U);
    if (result == NULL) return false;
  }
  for (size_t index = 0U; index < encoded_length / 2U; index++) {
    unsigned char high = 0U;
    unsigned char low = 0U;
    if (!hex_byte(encoded[index * 2U], &high) || !hex_byte(encoded[index * 2U + 1U], &low)) {
      free(result);
      return false;
    }
    result[index] = (unsigned char)((high << 4U) | low);
  }
  *bytes = result;
  *length = encoded_length / 2U;
  return true;
}

static char hex_digit(unsigned char value) {
  return value < 10U ? (char)('0' + value) : (char)('a' + value - 10U);
}

static size_t encoded_hex_length(size_t bytes) {
  return bytes > (SIZE_MAX - 1U) / 2U ? SIZE_MAX : bytes * 2U;
}

static bool append_text(char *destination, size_t capacity, size_t *length, const char *value) {
  size_t value_length = strlen(value);
  if (*length > capacity - 1U || value_length > capacity - 1U - *length) return false;
  memcpy(destination + *length, value, value_length);
  *length += value_length;
  destination[*length] = '\0';
  return true;
}

static bool append_hex(char *destination, size_t capacity, size_t *length, const unsigned char *bytes, size_t count) {
  if (count == 0U) return append_text(destination, capacity, length, "-");
  size_t needed = encoded_hex_length(count);
  if (needed == SIZE_MAX || *length > capacity - 1U || needed > capacity - 1U - *length) return false;
  for (size_t index = 0U; index < count; index++) {
    destination[*length + index * 2U] = hex_digit((unsigned char)(bytes[index] >> 4U));
    destination[*length + index * 2U + 1U] = hex_digit((unsigned char)(bytes[index] & 0x0fU));
  }
  *length += needed;
  destination[*length] = '\0';
  return true;
}

static int compare_names(const void *left, const void *right) {
  const char *const *left_name = (const char *const *)left;
  const char *const *right_name = (const char *const *)right;
  return strcmp(*left_name, *right_name);
}

static void reply_error(const char *request_id, const char *code) {
  if (!safe_request_id(request_id) || !safe_token(code, 64U)) return;
  (void)fprintf(stdout, "%s ERR %s %s\n", FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION, request_id, code);
  (void)fflush(stdout);
}

static void reply_ok(const char *request_id, const char *payload) {
  if (!safe_request_id(request_id)) return;
  if (payload != NULL && strlen(payload) > FORGEAX_SECURE_STORE_FS_MAX_FRAME_BYTES - 128U) {
    reply_error(request_id, "limit");
    return;
  }
  if (payload == NULL || payload[0] == '\0') {
    (void)fprintf(stdout, "%s OK %s\n", FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION, request_id);
  } else {
    (void)fprintf(stdout, "%s OK %s %s\n", FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION, request_id, payload);
  }
  (void)fflush(stdout);
}

static void reply_missing(const char *request_id) {
  if (!safe_request_id(request_id)) return;
  (void)fprintf(stdout, "%s ROOT_MISSING %s\n", FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION, request_id);
  (void)fflush(stdout);
}

static const char *errno_code(int value) {
  if (value == ENOENT) return "not_found";
  if (value == EEXIST) return "exists";
  if (value == EFBIG || value == EOVERFLOW || value == ENOMEM) return "limit";
  if (value == ENOTSUP || value == ENOSYS) return "unsupported";
  if (value == EINVAL || value == EPROTO) return "bad_request";
  return "unsafe";
}

/* Read one bounded line.  It is also used by the compile-guarded barrier gate. */
static int read_frame(char *buffer, size_t capacity, bool *eof) {
  size_t used = 0U;
  *eof = false;
  while (true) {
    if (input_offset == input_length) {
      ssize_t count = read(STDIN_FILENO, input_buffer, sizeof(input_buffer));
      if (count < 0) {
        if (errno == EINTR) continue;
        return -1;
      }
      if (count == 0) {
        *eof = true;
        return used == 0U ? 0 : -1;
      }
      input_offset = 0U;
      input_length = (size_t)count;
    }
    while (input_offset < input_length) {
      unsigned char byte = input_buffer[input_offset++];
      if (byte == '\n') {
        buffer[used] = '\0';
        return 1;
      }
      if (byte == '\0' || used + 1U >= capacity) return -1;
      buffer[used++] = (char)byte;
    }
  }
}

/* Strict single-space tokenization rejects empty/trailing/trailing-field input. */
static int split_tokens(char *line, char **tokens, size_t capacity, size_t *count) {
  size_t length = strlen(line);
  if (length == 0U || line[0] == ' ' || line[length - 1U] == ' ') return -1;
  size_t token_count = 0U;
  size_t start = 0U;
  for (size_t index = 0U; index <= length; index++) {
    if (index < length && line[index] != ' ') {
      if (line[index] == '\t' || (unsigned char)line[index] < 0x20U || (unsigned char)line[index] == 0x7fU) return -1;
      continue;
    }
    if (index == start || token_count >= capacity) return -1;
    line[index] = '\0';
    tokens[token_count++] = line + start;
    start = index + 1U;
  }
  *count = token_count;
  return 0;
}

#ifdef FORGEAX_SECURE_STORE_TEST_BARRIERS
static bool known_barrier(const char *name) {
  static const char *const names[] = {
    "root-before-operation", "open-read", "open-append", "open-create",
    "atomic-replace", "atomic-replace-published", "atomic-create", "atomic-create-published", "unlink", "mkdir", "rmdir",
    "rename-dir", "lock-acquire", "lock-acquire-published", "lock-reclaim", "lock-heartbeat", "lock-release",
    "lock-remove-before-unpublish", "lock-release-unpublished", "writer-sequence-contended",
  };
  for (size_t index = 0U; index < sizeof(names) / sizeof(names[0]); index++) {
    if (strcmp(name, names[index]) == 0) return true;
  }
  return false;
}

static int arm_barrier(const char *name) {
  if (!safe_token(name, FORGEAX_SECURE_STORE_FS_MAX_BARRIER_NAME_BYTES) || !known_barrier(name)) return fail_errno(EINVAL);
  if (armed_barrier[0] != '\0') return fail_errno(EBUSY);
  (void)strncpy(armed_barrier, name, sizeof(armed_barrier) - 1U);
  armed_barrier[sizeof(armed_barrier) - 1U] = '\0';
  return 0;
}

static int wait_barrier(const char *name) {
  if (armed_barrier[0] == '\0' || strcmp(armed_barrier, name) != 0) return 0;
  (void)fprintf(stdout, "%s BARRIER %s\n", FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION, name);
  (void)fflush(stdout);
  char control[256U];
  bool eof = false;
  int result = read_frame(control, sizeof(control), &eof);
  if (result != 1 || eof) return fail_errno(EPROTO);
  size_t length = strlen(control);
  if (length > 0U && control[length - 1U] == '\r') control[--length] = '\0';
  char *tokens[4U];
  size_t count = 0U;
  if (split_tokens(control, tokens, 4U, &count) < 0 || count != 3U ||
      strcmp(tokens[0], FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION) != 0 ||
      strcmp(tokens[1], "RELEASE") != 0 || strcmp(tokens[2], name) != 0) return fail_errno(EPROTO);
  armed_barrier[0] = '\0';
  return 0;
}
#else
static int wait_barrier(const char *name) {
  (void)name;
  return 0;
}
#endif

static bool path_component(const char *path, size_t path_length, size_t *cursor, char *component, size_t capacity, bool *is_last) {
  if (*cursor >= path_length || path[*cursor] != '/') return false;
  (*cursor)++;
  size_t start = *cursor;
  while (*cursor < path_length && path[*cursor] != '/') (*cursor)++;
  size_t length = *cursor - start;
  if (length == 0U || length >= capacity) return false;
  memcpy(component, path + start, length);
  component[length] = '\0';
  if (!safe_name(component)) return false;
  *is_last = *cursor == path_length;
  return true;
}

static bool normalize_root(const char *input, char *output, size_t capacity) {
  if (input == NULL) return false;
  size_t length = strlen(input);
  if (length < 2U || length > FORGEAX_SECURE_STORE_FS_MAX_ROOT_BYTES || input[0] != '/' || input[length - 1U] == '/') return false;
  const char *prefix = "";
#if defined(__APPLE__)
  if (strcmp(input, "/tmp") == 0 || strncmp(input, "/tmp/", 5U) == 0) prefix = "/private";
  else if (strcmp(input, "/var") == 0 || strncmp(input, "/var/", 5U) == 0) prefix = "/private";
#endif
  size_t prefix_length = strlen(prefix);
  if (prefix_length + length + 1U > capacity) return false;
  if (prefix_length > 0U) {
    memcpy(output, prefix, prefix_length);
    memcpy(output + prefix_length, input, length + 1U);
    /* /private + /tmp/foo is the intended spelling. */
    if (output[prefix_length] != '/') return false;
  } else {
    memcpy(output, input, length + 1U);
  }
  size_t normalized_length = strlen(output);
  if (normalized_length > FORGEAX_SECURE_STORE_FS_MAX_ROOT_BYTES || normalized_length < 2U) return false;
  for (size_t index = 0U; index + 1U < normalized_length; index++) {
    if (output[index] == '/' && output[index + 1U] == '/') return false;
  }
  size_t cursor = 0U;
  size_t components = 0U;
  char component[NAME_MAX + 1U];
  while (cursor < normalized_length) {
    bool is_last = false;
    if (!path_component(output, normalized_length, &cursor, component, sizeof(component), &is_last)) return false;
    if (components++ >= FORGEAX_SECURE_STORE_FS_MAX_ROOT_COMPONENTS) return false;
  }
  return components > 0U;
}

/*
 * Bind the root one component at a time.  The held final parent and root
 * descriptors are never replaced by a later string-path mutation.
 */
static int open_authority_root(const char *input_path, bool create_missing, bool *missing) {
  if (missing != NULL) *missing = false;
  char path[FORGEAX_SECURE_STORE_FS_MAX_ROOT_BYTES + 1U];
  if (!normalize_root(input_path, path, sizeof(path))) return fail_errno(EINVAL);

  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (current < 0) return -1;
  size_t path_length = strlen(path);
  size_t cursor = 0U;
  size_t component_index = 0U;
  char component[NAME_MAX + 1U];
  while (cursor < path_length) {
    bool is_last = false;
    if (!path_component(path, path_length, &cursor, component, sizeof(component), &is_last) ||
        component_index >= FORGEAX_SECURE_STORE_FS_MAX_ROOT_COMPONENTS) {
      close_fd(&current);
      return fail_errno(EINVAL);
    }
    int next = openat(current, component, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (next < 0 && errno == ENOENT && create_missing) {
      if (mkdirat(current, component, 0700) < 0 && errno != EEXIST) {
        close_fd(&current);
        return -1;
      }
      next = openat(current, component, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    }
    if (next < 0) {
      int saved = errno;
      close_fd(&current);
      if (saved == ENOENT && missing != NULL) *missing = true;
      errno = saved;
      return -1;
    }
    struct stat stats;
    if (fstat(next, &stats) < 0 || !S_ISDIR(stats.st_mode)) {
      close_fd(&next);
      close_fd(&current);
      return fail_errno(EACCES);
    }
    root_components[component_index].dev = stats.st_dev;
    root_components[component_index].ino = stats.st_ino;
    component_index++;
    if (is_last) {
      if (!private_directory_stat(&stats)) {
        close_fd(&next);
        close_fd(&current);
        return fail_errno(EACCES);
      }
      root_fd = next;
      root_parent_fd = current;
      root_component_count = component_index;
      (void)strncpy(root_path, path, sizeof(root_path) - 1U);
      root_path[sizeof(root_path) - 1U] = '\0';
      (void)strncpy(root_basename, component, sizeof(root_basename) - 1U);
      root_basename[sizeof(root_basename) - 1U] = '\0';
      return 0;
    }
    close_fd(&current);
    current = next;
  }
  close_fd(&current);
  return fail_errno(EINVAL);
}

/* Re-walk only for identity verification; no operation below mutates a path. */
static bool launch_path_is_bound(void) {
  if (root_path[0] != '/' || root_component_count == 0U) return false;
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (current < 0) return false;
  size_t path_length = strlen(root_path);
  size_t cursor = 0U;
  size_t component_index = 0U;
  char component[NAME_MAX + 1U];
  bool matched = true;
  while (cursor < path_length && component_index < root_component_count) {
    bool is_last = false;
    if (!path_component(root_path, path_length, &cursor, component, sizeof(component), &is_last)) {
      matched = false;
      break;
    }
    int next = openat(current, component, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (next < 0) {
      matched = false;
      break;
    }
    struct stat stats;
    if (fstat(next, &stats) < 0 || !S_ISDIR(stats.st_mode) ||
        stats.st_dev != root_components[component_index].dev ||
        stats.st_ino != root_components[component_index].ino ||
        (is_last && !private_directory_stat(&stats))) matched = false;
    close_fd(&current);
    current = next;
    component_index++;
    if (!matched) break;
  }
  close_fd(&current);
  return matched && cursor == path_length && component_index == root_component_count;
}

static bool root_is_still_bound(void) {
  if (root_fd < 0 || root_parent_fd < 0 || root_basename[0] == '\0') return false;
  struct stat expected;
  struct stat named;
  if (fstat(root_fd, &expected) < 0 || !private_directory_stat(&expected)) return false;
  if (root_component_count > 1U) {
    struct stat parent_stats;
    if (fstat(root_parent_fd, &parent_stats) < 0 ||
        parent_stats.st_dev != root_components[root_component_count - 2U].dev ||
        parent_stats.st_ino != root_components[root_component_count - 2U].ino) return false;
  }
  if (fstatat(root_parent_fd, root_basename, &named, AT_SYMLINK_NOFOLLOW) < 0 || !same_file(&expected, &named)) return false;
  return launch_path_is_bound();
}

/* All cooperating helpers serialize writer-lock state transitions on the
 * already-open, inode-bound root directory.  The kernel releases this lock if
 * a helper exits or is killed, so a stale remover cannot interleave its final
 * name mutation with another release/reclaim/acquire sequence. */
static int writer_sequence_enter(void) {
  if (!root_is_still_bound()) return fail_errno(EACCES);
#ifdef FORGEAX_SECURE_STORE_TEST_BARRIERS
  bool acquired = false;
  if (strcmp(armed_barrier, "writer-sequence-contended") == 0) {
    int nonblocking;
    do {
      nonblocking = flock(root_fd, LOCK_EX | LOCK_NB);
    } while (nonblocking < 0 && errno == EINTR);
    if (nonblocking == 0) acquired = true;
    else if (errno == EWOULDBLOCK || errno == EAGAIN) {
      if (wait_barrier("writer-sequence-contended") < 0) return -1;
    } else return -1;
  }
  if (!acquired) {
#endif
  while (flock(root_fd, LOCK_EX) < 0) {
    if (errno != EINTR) return -1;
  }
#ifdef FORGEAX_SECURE_STORE_TEST_BARRIERS
  }
#endif
  if (root_is_still_bound()) return 0;
  (void)flock(root_fd, LOCK_UN);
  return fail_errno(EACCES);
}

static int writer_sequence_finish(int result) {
  int saved_errno = errno;
  if (flock(root_fd, LOCK_UN) < 0 && result >= 0) return -1;
  errno = saved_errno;
  return result;
}

static int begin_transaction(void) {
  if (!root_is_still_bound()) return fail_errno(EACCES);
  if (wait_barrier("root-before-operation") < 0) return -1;
  if (!root_is_still_bound()) return fail_errno(EACCES);
  return 0;
}

static const char *profile_name(void) {
  return selected_profile == PROFILE_WIRE ? FORGEAX_SECURE_STORE_FS_PROFILE_WIRE : FORGEAX_SECURE_STORE_FS_PROFILE_MODEL;
}

static const char *manifest_name(void) {
  return selected_profile == PROFILE_WIRE ? WIRE_INDEX_NAME : MODEL_MANIFEST_NAME;
}

static const char *quota_name(void) {
  return selected_profile == PROFILE_WIRE ? WIRE_QUOTA_NAME : MODEL_QUOTA_NAME;
}

static bool parent_allowed(char code) {
  if (code == 'R' || code == 'B') return true;
  return code == 'S' && selected_profile == PROFILE_WIRE;
}

static const char *parent_name(char code) {
  if (code == 'B') return BLOBS_NAME;
  if (code == 'S') return RESERVATIONS_NAME;
  return NULL;
}

static bool parent_binding_is_current(char code, int fd) {
  if (!root_is_still_bound()) return false;
  struct stat held;
  if (fstat(fd, &held) < 0) return false;
  if (code == 'R') {
    struct stat root_stats;
    return fstat(root_fd, &root_stats) == 0 && same_file(&held, &root_stats) && private_directory_stat(&held);
  }
  const char *name = parent_name(code);
  if (name == NULL) return false;
  struct stat named;
  return fstatat(root_fd, name, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
    private_directory_stat(&held) && same_file(&held, &named);
}

static int open_private_child(const char *name, int *held_fd, bool create) {
  if (name == NULL || held_fd == NULL || !root_is_still_bound()) return fail_errno(EACCES);
  if (*held_fd >= 0) {
    struct stat held;
    struct stat named;
    if (fstat(*held_fd, &held) < 0 || !private_directory_stat(&held) ||
        fstatat(root_fd, name, &named, AT_SYMLINK_NOFOLLOW) < 0 || !same_file(&held, &named)) return fail_errno(EACCES);
    int duplicate = dup(*held_fd);
    if (duplicate < 0) return -1;
    return duplicate;
  }
  int child = openat(root_fd, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (child < 0 && errno == ENOENT && create) {
    if (mkdirat(root_fd, name, 0700) < 0 && errno != EEXIST) return -1;
    child = openat(root_fd, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  }
  if (child < 0) return -1;
  struct stat stats;
  struct stat named;
  if (fstat(child, &stats) < 0 || !private_directory_stat(&stats) ||
      fstatat(root_fd, name, &named, AT_SYMLINK_NOFOLLOW) < 0 || !same_file(&stats, &named)) {
    close_fd(&child);
    return fail_errno(EACCES);
  }
  *held_fd = child;
  int duplicate = dup(child);
  if (duplicate < 0) return -1;
  return duplicate;
}

static int open_parent(char code) {
  if (!parent_allowed(code)) return fail_errno(EINVAL);
  if (code == 'R') return dup(root_fd);
  if (code == 'B') return open_private_child(BLOBS_NAME, &blobs_fd, false);
  return open_private_child(RESERVATIONS_NAME, &reservations_fd, false);
}

static int stat_named(int parent_fd, const char *name, struct stat *stats, bool allow_missing) {
  if (!safe_name(name) || stats == NULL) return fail_errno(EINVAL);
  if (fstatat(parent_fd, name, stats, AT_SYMLINK_NOFOLLOW) == 0) return 0;
  if (allow_missing && errno == ENOENT) return 1;
  return -1;
}

static int validate_new_file_fd(int fd) {
  struct stat stats;
  if (fstat(fd, &stats) < 0 || !S_ISREG(stats.st_mode) || !owned_by_process(&stats) || stats.st_nlink != 1) return fail_errno(EACCES);
  if (fchmod(fd, 0600) < 0) return -1;
  if (fstat(fd, &stats) < 0 || !regular_file_stat(&stats)) return fail_errno(EACCES);
  return 0;
}

static int validate_existing_file_fd(int fd) {
  struct stat stats;
  if (fstat(fd, &stats) < 0 || !regular_file_stat(&stats)) return fail_errno(EACCES);
  return 0;
}

static int write_all(int fd, const unsigned char *bytes, size_t length) {
  size_t written = 0U;
  while (written < length) {
    ssize_t count = write(fd, bytes + written, length - written);
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (count == 0) return fail_errno(EIO);
    written += (size_t)count;
  }
  return 0;
}

static int read_fd(int fd, unsigned char **bytes, size_t *length) {
  if (bytes == NULL || length == NULL) return fail_errno(EINVAL);
  struct stat before;
  if (fstat(fd, &before) < 0 || !regular_file_stat(&before)) return fail_errno(EACCES);
  if (before.st_size < 0 || (uintmax_t)before.st_size > FORGEAX_SECURE_STORE_FS_MAX_FILE_BYTES) return fail_errno(EFBIG);
  size_t capacity = (size_t)before.st_size;
  unsigned char *result = NULL;
  if (capacity > 0U) {
    result = (unsigned char *)malloc(capacity);
    if (result == NULL) return fail_errno(ENOMEM);
  }
  size_t used = 0U;
  while (used < capacity) {
    ssize_t count = read(fd, result + used, capacity - used);
    if (count < 0) {
      if (errno == EINTR) continue;
      free(result);
      return -1;
    }
    if (count == 0) {
      free(result);
      return fail_errno(EIO);
    }
    used += (size_t)count;
  }
  struct stat after;
  if (fstat(fd, &after) < 0 || !regular_file_stat(&after) || !same_file(&before, &after) || after.st_size != before.st_size) {
    free(result);
    return fail_errno(EACCES);
  }
  *bytes = result;
  *length = used;
  return 0;
}

static int read_named(int parent_fd, const char *name, unsigned char **bytes, size_t *length) {
  int fd = openat(parent_fd, name, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  int result = read_fd(fd, bytes, length);
  close_fd(&fd);
  return result;
}

static bool destination_same(int parent_fd, const char *name, const struct stat *expected, bool expected_exists) {
  struct stat current;
  if (fstatat(parent_fd, name, &current, AT_SYMLINK_NOFOLLOW) == 0) {
    return expected_exists && regular_file_stat(&current) && same_file(&current, expected);
  }
  return !expected_exists && errno == ENOENT;
}

static bool make_temp_name(char *name, size_t capacity) {
  temp_counter++;
  int written = snprintf(name, capacity, ".secure-store-%ld-%llu.tmp", (long)getpid(), temp_counter);
  return written > 0 && (size_t)written < capacity && safe_name(name);
}

static void cleanup_owned_temp(int parent_fd, const char *name, const struct stat *expected) {
  struct stat current;
  if (fstatat(parent_fd, name, &current, AT_SYMLINK_NOFOLLOW) == 0 && same_file(&current, expected)) {
    (void)unlinkat(parent_fd, name, 0);
  }
}

static int open_unique_temp(int parent_fd, char *name, size_t capacity, int *fd, struct stat *stats) {
  for (size_t attempt = 0U; attempt < 8U; attempt++) {
    if (!make_temp_name(name, capacity)) return fail_errno(EINVAL);
    int opened = openat(parent_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (opened >= 0) {
      bool stats_valid = false;
      int result = validate_new_file_fd(opened);
      if (result == 0 && fstat(opened, stats) == 0 && regular_file_stat(stats)) stats_valid = true;
      int saved_errno = errno;
      if (!stats_valid) {
        close_fd(&opened);
        errno = saved_errno == 0 ? EACCES : saved_errno;
        return -1;
      }
      *fd = opened;
      return 0;
    }
    if (errno != EEXIST) return -1;
  }
  return fail_errno(EEXIST);
}

static int write_exclusive(char parent_code, int parent_fd, const char *name, const unsigned char *bytes, size_t length) {
  if (!safe_name(name) || length > FORGEAX_SECURE_STORE_FS_MAX_CONTENT_BYTES) return fail_errno(EINVAL);
  if (wait_barrier("open-create") < 0 || !parent_binding_is_current(parent_code, parent_fd)) return fail_errno(EACCES);
  int fd = openat(parent_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) return -1;
  struct stat created;
  bool created_valid = false;
  int result = validate_new_file_fd(fd);
  if (result == 0) {
    if (fstat(fd, &created) < 0) result = -1;
    else if (!regular_file_stat(&created)) result = fail_errno(EACCES);
    else created_valid = true;
  }
  if (result == 0) result = write_all(fd, bytes, length);
  if (result == 0) result = sync_file(fd);
  close_fd(&fd);
  if (result < 0) {
    if (result == -1 && errno == 0) errno = EIO;
    int saved_errno = errno;
    if (created_valid) cleanup_owned_temp(parent_fd, name, &created);
    errno = saved_errno;
    return result;
  }
  return sync_directory(parent_fd);
}

static int append_file(char parent_code, int parent_fd, const char *name, const unsigned char *bytes, size_t length) {
  if (!safe_name(name) || length > FORGEAX_SECURE_STORE_FS_MAX_CONTENT_BYTES) return fail_errno(EINVAL);
  struct stat expected;
  int state = stat_named(parent_fd, name, &expected, true);
  if (state < 0) return -1;
  bool existing = state == 0;
  if (existing && !regular_file_stat(&expected)) return fail_errno(EACCES);
  if (wait_barrier("open-append") < 0 || !parent_binding_is_current(parent_code, parent_fd)) return fail_errno(EACCES);
  int flags = O_WRONLY | O_APPEND | O_CLOEXEC | O_NOFOLLOW;
  if (!existing) flags |= O_CREAT | O_EXCL;
  int fd = openat(parent_fd, name, flags, 0600);
  if (fd < 0) return -1;
  struct stat opened;
  bool opened_valid = false;
  int result = existing ? validate_existing_file_fd(fd) : validate_new_file_fd(fd);
  if (result == 0) {
    if (fstat(fd, &opened) < 0) result = -1;
    else if (!regular_file_stat(&opened)) result = fail_errno(EACCES);
    else opened_valid = true;
  }
  if (result == 0 && existing && !same_file(&opened, &expected)) result = fail_errno(EACCES);
  if (result == 0) {
    struct stat named;
    if (fstatat(parent_fd, name, &named, AT_SYMLINK_NOFOLLOW) < 0 || !same_file(&opened, &named)) result = fail_errno(EACCES);
  }
  if (result == 0) result = write_all(fd, bytes, length);
  if (result == 0) result = sync_file(fd);
  close_fd(&fd);
  if (result < 0) {
    int saved_errno = errno == 0 ? EIO : errno;
    if (!existing && opened_valid) cleanup_owned_temp(parent_fd, name, &opened);
    errno = saved_errno;
    return result;
  }
  return sync_directory(parent_fd);
}

static int atomic_replace(char parent_code, int parent_fd, const char *name, const unsigned char *bytes, size_t length) {
  if (!safe_name(name) || length > FORGEAX_SECURE_STORE_FS_MAX_CONTENT_BYTES) return fail_errno(EINVAL);
  struct stat expected;
  int state = stat_named(parent_fd, name, &expected, true);
  if (state < 0) return -1;
  bool expected_exists = state == 0;
  if (expected_exists && !regular_file_stat(&expected)) return fail_errno(EACCES);

  char temporary[NAME_MAX + 1U];
  int fd = -1;
  struct stat temporary_stats;
  if (open_unique_temp(parent_fd, temporary, sizeof(temporary), &fd, &temporary_stats) < 0) return -1;
  int result = write_all(fd, bytes, length);
  if (result == 0) result = sync_file(fd);
  close_fd(&fd);
  if (result == 0 && wait_barrier("atomic-replace") < 0) result = -1;
  if (result == 0 && !parent_binding_is_current(parent_code, parent_fd)) result = fail_errno(EACCES);
  if (result == 0 && !destination_same(parent_fd, name, &expected, expected_exists)) result = fail_errno(EACCES);
  if (result == 0 && renameat(parent_fd, temporary, parent_fd, name) < 0) result = -1;
  if (result == 0 && wait_barrier("atomic-replace-published") < 0) result = -1;
  if (result == 0) {
    struct stat exposed;
    if (fstatat(parent_fd, name, &exposed, AT_SYMLINK_NOFOLLOW) < 0 ||
        !regular_file_stat(&exposed) || !same_file(&exposed, &temporary_stats)) result = fail_errno(EACCES);
  }
  if (result == 0) result = sync_directory(parent_fd);
  if (result < 0) {
    int saved_errno = errno == 0 ? EIO : errno;
    cleanup_owned_temp(parent_fd, temporary, &temporary_stats);
    errno = saved_errno;
  }
  return result;
}

/* Permanent stores use this exact temp-fsync -> linkat -> unlinkat sequence. */
static int atomic_create_if_absent(char parent_code, int parent_fd, const char *name, const unsigned char *bytes, size_t length) {
  if (!safe_name(name) || length > FORGEAX_SECURE_STORE_FS_MAX_CONTENT_BYTES) return fail_errno(EINVAL);
  struct stat existing;
  int state = stat_named(parent_fd, name, &existing, true);
  if (state < 0) return -1;
  if (state == 0) return fail_errno(EEXIST);

  char temporary[NAME_MAX + 1U];
  int fd = -1;
  struct stat temporary_stats;
  if (open_unique_temp(parent_fd, temporary, sizeof(temporary), &fd, &temporary_stats) < 0) return -1;
  int result = write_all(fd, bytes, length);
  if (result == 0) result = sync_file(fd);
  close_fd(&fd);
  bool linked = false;
  if (result == 0 && wait_barrier("atomic-create") < 0) result = -1;
  if (result == 0 && !parent_binding_is_current(parent_code, parent_fd)) result = fail_errno(EACCES);
  if (result == 0 && linkat(parent_fd, temporary, parent_fd, name, 0) < 0) result = -1;
  else if (result == 0) linked = true;
  if (result == 0 && unlinkat(parent_fd, temporary, 0) < 0) result = -1;
  if (result == 0 && wait_barrier("atomic-create-published") < 0) result = -1;
  if (result == 0) {
    struct stat exposed;
    if (fstatat(parent_fd, name, &exposed, AT_SYMLINK_NOFOLLOW) < 0 ||
        !regular_file_stat(&exposed) || !same_file(&exposed, &temporary_stats)) result = fail_errno(EACCES);
  }
  if (result == 0) result = sync_directory(parent_fd);
  if (result < 0) {
    int saved_errno = errno == 0 ? EIO : errno;
    if (!linked) cleanup_owned_temp(parent_fd, temporary, &temporary_stats);
    else {
      /* A failed temp unlink is intentionally not followed by a path mutation. */
      cleanup_owned_temp(parent_fd, temporary, &temporary_stats);
    }
    errno = saved_errno;
  }
  return result;
}

static int remove_file(char parent_code, int parent_fd, const char *name) {
  struct stat expected;
  if (stat_named(parent_fd, name, &expected, false) < 0) return -1;
  if (!regular_file_stat(&expected)) return fail_errno(EACCES);
  if (wait_barrier("unlink") < 0 || !parent_binding_is_current(parent_code, parent_fd)) return fail_errno(EACCES);
  struct stat current;
  if (fstatat(parent_fd, name, &current, AT_SYMLINK_NOFOLLOW) < 0 || !regular_file_stat(&current) || !same_file(&current, &expected)) return fail_errno(EACCES);
  if (unlinkat(parent_fd, name, 0) < 0) return -1;
  return sync_directory(parent_fd);
}

static int remove_directory(char parent_code, int parent_fd, const char *name) {
  struct stat expected;
  if (stat_named(parent_fd, name, &expected, false) < 0) return -1;
  if (!private_directory_stat(&expected)) return fail_errno(EACCES);
  if (wait_barrier("rmdir") < 0 || !parent_binding_is_current(parent_code, parent_fd)) return fail_errno(EACCES);
  struct stat current;
  if (fstatat(parent_fd, name, &current, AT_SYMLINK_NOFOLLOW) < 0 || !private_directory_stat(&current) || !same_file(&current, &expected)) return fail_errno(EACCES);
  if (unlinkat(parent_fd, name, AT_REMOVEDIR) < 0) return -1;
  return sync_directory(parent_fd);
}

static int mkdir_directory(char parent_code, int parent_fd, const char *name) {
  if (!safe_name(name)) return fail_errno(EINVAL);
  if (wait_barrier("mkdir") < 0 || !parent_binding_is_current(parent_code, parent_fd)) return fail_errno(EACCES);
  if (mkdirat(parent_fd, name, 0700) < 0) return -1;
  struct stat created;
  if (fstatat(parent_fd, name, &created, AT_SYMLINK_NOFOLLOW) < 0 || !private_directory_stat(&created)) return fail_errno(EACCES);
  return sync_directory(parent_fd);
}

static int ensure_file(int parent_fd, const char *name) {
  struct stat stats;
  int state = stat_named(parent_fd, name, &stats, true);
  if (state < 0) return -1;
  if (state == 0) return regular_file_stat(&stats) ? 0 : fail_errno(EACCES);
  int fd = openat(parent_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) return -1;
  int result = validate_new_file_fd(fd);
  if (result == 0) result = sync_file(fd);
  close_fd(&fd);
  if (result == 0) result = sync_directory(parent_fd);
  return result;
}

/* dup() shares a directory stream offset with the held descriptor.  Re-open
 * the descriptor-relative dot entry so validation/listing always starts at
 * the beginning without changing the authority descriptor's offset. */
static int open_directory_view(int directory_fd) {
  return openat(directory_fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
}

static int validate_directory_entries(int directory_fd) {
  int duplicate = open_directory_view(directory_fd);
  if (duplicate < 0) return -1;
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) {
    close_fd(&duplicate);
    return -1;
  }
  struct dirent *entry;
  int result = 0;
  size_t count = 0U;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (++count > FORGEAX_SECURE_STORE_FS_MAX_LIST_ENTRIES || !safe_name(entry->d_name)) {
      result = fail_errno(EACCES);
      break;
    }
    struct stat stats;
    if (fstatat(directory_fd, entry->d_name, &stats, AT_SYMLINK_NOFOLLOW) < 0 ||
        (S_ISDIR(stats.st_mode) ? !private_directory_stat(&stats) : !regular_file_stat(&stats))) {
      result = fail_errno(EACCES);
      break;
    }
  }
  closedir(directory);
  return result;
}

static int ensure_layout(void) {
  if (validate_directory_entries(root_fd) < 0) return -1;
  int child = open_private_child(BLOBS_NAME, &blobs_fd, true);
  if (child < 0) return -1;
  close_fd(&child);
  if (selected_profile == PROFILE_WIRE) {
    child = open_private_child(RESERVATIONS_NAME, &reservations_fd, true);
    if (child < 0) return -1;
    close_fd(&child);
  }
  if (validate_directory_entries(blobs_fd) < 0) return -1;
  if (selected_profile == PROFILE_WIRE && validate_directory_entries(reservations_fd) < 0) return -1;
  if (ensure_file(root_fd, manifest_name()) < 0) return -1;
  if (selected_profile == PROFILE_WIRE && ensure_file(root_fd, quota_name()) < 0) return -1;
  if (sync_directory(blobs_fd) < 0 || (selected_profile == PROFILE_WIRE && sync_directory(reservations_fd) < 0)) return -1;
  return sync_directory(root_fd);
}

static int storage_present(bool *present) {
  if (present == NULL) return fail_errno(EINVAL);
  *present = false;
  struct stat stats;
  int state = stat_named(root_fd, manifest_name(), &stats, true);
  if (state < 0) return -1;
  if (state == 0 && !regular_file_stat(&stats)) return fail_errno(EACCES);
  if (state == 0) *present = true;
  state = stat_named(root_fd, quota_name(), &stats, true);
  if (state < 0) return -1;
  if (state == 0 && !regular_file_stat(&stats)) return fail_errno(EACCES);
  if (state == 0) *present = true;
  state = stat_named(root_fd, BLOBS_NAME, &stats, true);
  if (state < 0) return -1;
  if (state == 0 && !private_directory_stat(&stats)) return fail_errno(EACCES);
  if (state == 0) *present = true;
  if (selected_profile == PROFILE_WIRE) {
    state = stat_named(root_fd, RESERVATIONS_NAME, &stats, true);
    if (state < 0) return -1;
    if (state == 0 && !private_directory_stat(&stats)) return fail_errno(EACCES);
    if (state == 0) *present = true;
  }
  return 0;
}

static int list_directory(char parent_code, int directory_fd, char **payload) {
  if (payload == NULL) return fail_errno(EINVAL);
  int duplicate = open_directory_view(directory_fd);
  if (duplicate < 0) return -1;
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) {
    close_fd(&duplicate);
    return -1;
  }
  char **names = NULL;
  size_t count = 0U;
  size_t capacity = 0U;
  struct dirent *entry;
  int result = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (count >= FORGEAX_SECURE_STORE_FS_MAX_LIST_ENTRIES || !safe_name(entry->d_name)) {
      result = fail_errno(EACCES);
      break;
    }
    struct stat stats;
    if (fstatat(directory_fd, entry->d_name, &stats, AT_SYMLINK_NOFOLLOW) < 0 ||
        (S_ISDIR(stats.st_mode) ? !private_directory_stat(&stats) : !regular_file_stat(&stats))) {
      result = fail_errno(EACCES);
      break;
    }
    if (count == capacity) {
      size_t next_capacity = capacity == 0U ? 16U : capacity * 2U;
      char **next = (char **)realloc(names, next_capacity * sizeof(char *));
      if (next == NULL) {
        result = fail_errno(ENOMEM);
        break;
      }
      names = next;
      capacity = next_capacity;
    }
    names[count] = strdup(entry->d_name);
    if (names[count] == NULL) {
      result = fail_errno(ENOMEM);
      break;
    }
    count++;
  }
  closedir(directory);
  if (result != 0) {
    for (size_t index = 0U; index < count; index++) free(names[index]);
    free(names);
    return result;
  }
  qsort(names, count, sizeof(char *), compare_names);
  size_t response_capacity = 4096U;
  char *response = (char *)malloc(response_capacity);
  if (response == NULL) {
    for (size_t index = 0U; index < count; index++) free(names[index]);
    free(names);
    return fail_errno(ENOMEM);
  }
  size_t response_length = 0U;
  char count_text[32U];
  (void)snprintf(count_text, sizeof(count_text), "%zu", count);
  if (!append_text(response, response_capacity, &response_length, "LIST ") || !append_text(response, response_capacity, &response_length, count_text)) result = fail_errno(EOVERFLOW);
  for (size_t index = 0U; result == 0 && index < count; index++) {
    size_t name_length = strlen(names[index]);
    size_t needed = encoded_hex_length(name_length);
    if (needed == SIZE_MAX || response_length > FORGEAX_SECURE_STORE_FS_MAX_FRAME_BYTES - needed - 2U) {
      result = fail_errno(EOVERFLOW);
      break;
    }
    size_t required = 1U + needed;
    if (response_length + required + 1U > response_capacity) {
      size_t next_capacity = response_capacity;
      while (response_length + required + 1U > next_capacity) {
        if (next_capacity > FORGEAX_SECURE_STORE_FS_MAX_FRAME_BYTES / 2U) {
          result = fail_errno(EOVERFLOW);
          break;
        }
        next_capacity *= 2U;
      }
      if (result != 0) break;
      char *next = (char *)realloc(response, next_capacity);
      if (next == NULL) {
        result = fail_errno(ENOMEM);
        break;
      }
      response = next;
      response_capacity = next_capacity;
    }
    if (!append_text(response, response_capacity, &response_length, " ") ||
        !append_hex(response, response_capacity, &response_length, (const unsigned char *)names[index], name_length)) result = fail_errno(EOVERFLOW);
  }
  for (size_t index = 0U; index < count; index++) free(names[index]);
  free(names);
  if (result != 0) {
    free(response);
    return result;
  }
  (void)parent_code;
  *payload = response;
  return 0;
}

static int parse_u64(const char *value, uint64_t *result) {
  if (!safe_decimal(value) || result == NULL) return fail_errno(EINVAL);
  errno = 0;
  char *end = NULL;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == NULL || *end != '\0') return fail_errno(EINVAL);
  *result = (uint64_t)parsed;
  return 0;
}

static int decode_name(const char *encoded, char *name, size_t capacity) {
  unsigned char *bytes = NULL;
  size_t length = 0U;
  if (!decode_hex(encoded, &bytes, &length, FORGEAX_SECURE_STORE_FS_MAX_NAME_BYTES) || length == 0U || length >= capacity) {
    free(bytes);
    return fail_errno(EINVAL);
  }
  memcpy(name, bytes, length);
  name[length] = '\0';
  free(bytes);
  return safe_name(name) ? 0 : fail_errno(EINVAL);
}

static int decode_content(const char *encoded, unsigned char **bytes, size_t *length) {
  if (!decode_hex(encoded, bytes, length, FORGEAX_SECURE_STORE_FS_MAX_CONTENT_BYTES)) return fail_errno(EINVAL);
  return 0;
}

static int lock_open_current(struct stat *stats) {
  if (!root_is_still_bound()) return fail_errno(EACCES);
  int lock = openat(root_fd, LOCK_NAME, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (lock < 0) return -1;
  struct stat current;
  struct stat named;
  if (fstat(lock, &current) < 0 || !private_directory_stat(&current) ||
      fstatat(root_fd, LOCK_NAME, &named, AT_SYMLINK_NOFOLLOW) < 0 || !same_file(&current, &named)) {
    close_fd(&lock);
    return fail_errno(EACCES);
  }
  if (stats != NULL) *stats = current;
  return lock;
}

static int write_owner_exclusive(int lock_fd, const unsigned char *owner, size_t owner_length) {
  if (owner == NULL || owner_length == 0U || owner_length > FORGEAX_SECURE_STORE_FS_MAX_OWNER_BYTES) return fail_errno(EINVAL);
  int fd = openat(lock_fd, LOCK_OWNER_NAME, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) return -1;
  int result = validate_new_file_fd(fd);
  if (result == 0) result = write_all(fd, owner, owner_length);
  if (result == 0) result = sync_file(fd);
  close_fd(&fd);
  if (result == 0) result = sync_directory(lock_fd);
  return result;
}

static bool owner_equals(int lock_fd, const unsigned char *expected, size_t expected_length) {
  unsigned char *actual = NULL;
  size_t actual_length = 0U;
  if (read_named(lock_fd, LOCK_OWNER_NAME, &actual, &actual_length) < 0) return false;
  bool equal = actual_length == expected_length && (expected_length == 0U || memcmp(actual, expected, expected_length) == 0);
  free(actual);
  return equal;
}

static int create_unique_lock_directory(char *name, size_t capacity, struct stat *stats) {
  if (name == NULL || stats == NULL) return fail_errno(EINVAL);
  for (size_t attempt = 0U; attempt < 8U; attempt++) {
    if (!make_temp_name(name, capacity)) return fail_errno(EINVAL);
    if (mkdirat(root_fd, name, 0700) < 0) {
      if (errno == EEXIST) continue;
      return -1;
    }
    int directory = openat(root_fd, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    struct stat opened;
    struct stat named;
    if (directory < 0 || fstat(directory, &opened) < 0 || !private_directory_stat(&opened) ||
        fstatat(root_fd, name, &named, AT_SYMLINK_NOFOLLOW) < 0 || !same_file(&opened, &named)) {
      close_fd(&directory);
      return fail_errno(EACCES);
    }
    *stats = opened;
    return directory;
  }
  return fail_errno(EEXIST);
}

static void cleanup_owned_lock_directory(const char *name, const struct stat *expected,
                                         const unsigned char *owner, size_t owner_length) {
  if (!safe_name(name) || expected == NULL || owner == NULL || owner_length == 0U) return;
  int directory = openat(root_fd, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat opened;
  if (directory < 0 || fstat(directory, &opened) < 0 || !private_directory_stat(&opened) ||
      !same_file(&opened, expected) || !owner_equals(directory, owner, owner_length)) {
    close_fd(&directory);
    return;
  }
  if (unlinkat(directory, LOCK_OWNER_NAME, 0) == 0) {
    struct stat named;
    if (fstatat(root_fd, name, &named, AT_SYMLINK_NOFOLLOW) == 0 && same_file(&named, expected)) {
      (void)unlinkat(root_fd, name, AT_REMOVEDIR);
    }
  }
  close_fd(&directory);
}

static int atomic_replace_no_barrier(int parent_fd, const char *name, const unsigned char *bytes, size_t length) {
  if (!safe_name(name) || length == 0U || length > FORGEAX_SECURE_STORE_FS_MAX_OWNER_BYTES) return fail_errno(EINVAL);
  struct stat expected;
  if (stat_named(parent_fd, name, &expected, false) < 0 || !regular_file_stat(&expected)) return fail_errno(EACCES);
  char temporary[NAME_MAX + 1U];
  int fd = -1;
  struct stat temporary_stats;
  if (open_unique_temp(parent_fd, temporary, sizeof(temporary), &fd, &temporary_stats) < 0) return -1;
  int result = write_all(fd, bytes, length);
  if (result == 0) result = sync_file(fd);
  close_fd(&fd);
  if (result == 0 && !destination_same(parent_fd, name, &expected, true)) result = fail_errno(EACCES);
  if (result == 0 && renameat(parent_fd, temporary, parent_fd, name) < 0) result = -1;
  if (result == 0) {
    struct stat exposed;
    if (fstatat(parent_fd, name, &exposed, AT_SYMLINK_NOFOLLOW) < 0 || !same_file(&exposed, &temporary_stats)) result = fail_errno(EACCES);
  }
  if (result == 0) result = sync_directory(parent_fd);
  if (result < 0) {
    int saved_errno = errno == 0 ? EIO : errno;
    cleanup_owned_temp(parent_fd, temporary, &temporary_stats);
    errno = saved_errno;
  }
  return result;
}

static int lock_acquire(const unsigned char *owner, size_t owner_length, struct stat *created_stats) {
  if (owner == NULL || owner_length == 0U || owner_length > FORGEAX_SECURE_STORE_FS_MAX_OWNER_BYTES) return fail_errno(EINVAL);
  if (writer_sequence_enter() < 0) return -1;
  char staging[NAME_MAX + 1U];
  struct stat staging_stats;
  int lock = create_unique_lock_directory(staging, sizeof(staging), &staging_stats);
  if (lock < 0) return writer_sequence_finish(-1);
  int result = write_owner_exclusive(lock, owner, owner_length);
  if (result == 0) result = sync_directory(lock);
  bool published = false;
  if (result == 0 && wait_barrier("lock-acquire") < 0) result = -1;
  if (result == 0 && !root_is_still_bound()) result = fail_errno(EACCES);
  if (result == 0 && renameat_noreplace(root_fd, staging, root_fd, LOCK_NAME) < 0) result = -1;
  else if (result == 0) published = true;
  if (result == 0) {
    struct stat exposed;
    if (fstatat(root_fd, LOCK_NAME, &exposed, AT_SYMLINK_NOFOLLOW) < 0 ||
        !private_directory_stat(&exposed) || !same_file(&exposed, &staging_stats)) result = fail_errno(EACCES);
  }
  if (result == 0 && sync_directory(root_fd) < 0) result = -1;
  if (result == 0 && wait_barrier("lock-acquire-published") < 0) result = -1;
  if (result == 0) {
    struct stat exposed;
    if (!root_is_still_bound() || fstatat(root_fd, LOCK_NAME, &exposed, AT_SYMLINK_NOFOLLOW) < 0 ||
        !private_directory_stat(&exposed) || !same_file(&exposed, &staging_stats) ||
        !owner_equals(lock, owner, owner_length)) result = fail_errno(EACCES);
  }
  close_fd(&lock);
  if (result < 0) {
    int saved_errno = errno == 0 ? EIO : errno;
    if (!published) cleanup_owned_lock_directory(staging, &staging_stats, owner, owner_length);
    errno = saved_errno;
    return writer_sequence_finish(result);
  }
  if (created_stats != NULL) *created_stats = staging_stats;
  return writer_sequence_finish(0);
}

static int lock_remove_under_sequence(char operation_barrier, uint64_t expected_dev, uint64_t expected_ino, const char *nonce, const unsigned char *owner, size_t owner_length) {
  if (!safe_nonce(nonce) || owner == NULL || owner_length == 0U || owner_length > FORGEAX_SECURE_STORE_FS_MAX_OWNER_BYTES) return fail_errno(EINVAL);
  struct stat first;
  int lock = lock_open_current(&first);
  if (lock < 0) return errno == ENOENT ? 1 : -1;
  bool matches = (uint64_t)first.st_dev == expected_dev && (uint64_t)first.st_ino == expected_ino && owner_equals(lock, owner, owner_length);
  close_fd(&lock);
  if (!matches) return 1;
  const char *barrier = operation_barrier == 'R' ? "lock-reclaim" : "lock-release";
  if (wait_barrier(barrier) < 0 || !root_is_still_bound()) return fail_errno(EACCES);
  struct stat current;
  lock = lock_open_current(&current);
  if (lock < 0) return errno == ENOENT ? 1 : -1;
  if ((uint64_t)current.st_dev != expected_dev || (uint64_t)current.st_ino != expected_ino || !owner_equals(lock, owner, owner_length)) {
    close_fd(&lock);
    return 1;
  }
  struct stat named;
  if (fstatat(root_fd, LOCK_NAME, &named, AT_SYMLINK_NOFOLLOW) < 0 || !same_file(&named, &current)) {
    close_fd(&lock);
    return 1;
  }
  if (wait_barrier("lock-remove-before-unpublish") < 0) {
    close_fd(&lock);
    return -1;
  }
  if (!root_is_still_bound() || fstatat(root_fd, LOCK_NAME, &named, AT_SYMLINK_NOFOLLOW) < 0 ||
      !same_file(&named, &current) || !owner_equals(lock, owner, owner_length)) {
    close_fd(&lock);
    return 1;
  }
  char retired[NAME_MAX + 1U];
  bool unpublished = false;
  int result = 0;
  for (size_t attempt = 0U; attempt < 8U; attempt++) {
    if (!make_temp_name(retired, sizeof(retired))) {
      result = fail_errno(EINVAL);
      break;
    }
    if (renameat_noreplace(root_fd, LOCK_NAME, root_fd, retired) == 0) {
      unpublished = true;
      break;
    }
    if (errno != EEXIST) {
      result = -1;
      break;
    }
  }
  if (!unpublished) {
    close_fd(&lock);
    return result == 0 ? fail_errno(EEXIST) : result;
  }
  if (fstatat(root_fd, retired, &named, AT_SYMLINK_NOFOLLOW) < 0 || !same_file(&named, &current)) result = fail_errno(EACCES);
  if (result == 0 && sync_directory(root_fd) < 0) result = -1;
  if (result == 0 && wait_barrier("lock-release-unpublished") < 0) result = -1;
  if (result == 0 && (!root_is_still_bound() || !owner_equals(lock, owner, owner_length))) result = fail_errno(EACCES);
  if (result == 0 && unlinkat(lock, LOCK_OWNER_NAME, 0) < 0) result = -1;
  if (result == 0) {
    if (fstatat(root_fd, retired, &named, AT_SYMLINK_NOFOLLOW) < 0 || !same_file(&named, &current)) result = fail_errno(EACCES);
    else if (unlinkat(root_fd, retired, AT_REMOVEDIR) < 0) result = -1;
  }
  close_fd(&lock);
  if (result == 0) result = sync_directory(root_fd);
  return result;
}

static int lock_remove(char operation_barrier, uint64_t expected_dev, uint64_t expected_ino, const char *nonce, const unsigned char *owner, size_t owner_length) {
  if (writer_sequence_enter() < 0) return -1;
  return writer_sequence_finish(lock_remove_under_sequence(operation_barrier, expected_dev, expected_ino, nonce, owner, owner_length));
}

static int lock_heartbeat_under_sequence(uint64_t expected_dev, uint64_t expected_ino, const unsigned char *old_owner, size_t old_length, const unsigned char *new_owner, size_t new_length) {
  if (old_owner == NULL || new_owner == NULL || old_length == 0U || new_length == 0U ||
      old_length > FORGEAX_SECURE_STORE_FS_MAX_OWNER_BYTES || new_length > FORGEAX_SECURE_STORE_FS_MAX_OWNER_BYTES) return fail_errno(EINVAL);
  struct stat first;
  int lock = lock_open_current(&first);
  if (lock < 0) return -1;
  bool matches = (uint64_t)first.st_dev == expected_dev && (uint64_t)first.st_ino == expected_ino && owner_equals(lock, old_owner, old_length);
  close_fd(&lock);
  if (!matches) return fail_errno(EACCES);
  if (wait_barrier("lock-heartbeat") < 0 || !root_is_still_bound()) return fail_errno(EACCES);
  struct stat current;
  lock = lock_open_current(&current);
  if (lock < 0) return -1;
  if ((uint64_t)current.st_dev != expected_dev || (uint64_t)current.st_ino != expected_ino || !owner_equals(lock, old_owner, old_length)) {
    close_fd(&lock);
    return fail_errno(EACCES);
  }
  int result = atomic_replace_no_barrier(lock, LOCK_OWNER_NAME, new_owner, new_length);
  close_fd(&lock);
  return result;
}

static int lock_heartbeat(uint64_t expected_dev, uint64_t expected_ino, const unsigned char *old_owner, size_t old_length, const unsigned char *new_owner, size_t new_length) {
  if (writer_sequence_enter() < 0) return -1;
  return writer_sequence_finish(lock_heartbeat_under_sequence(expected_dev, expected_ino, old_owner, old_length, new_owner, new_length));
}

static int lock_inspect(char **payload) {
  if (payload == NULL) return fail_errno(EINVAL);
  struct stat stats;
  int lock = lock_open_current(&stats);
  if (lock < 0) {
    if (errno == ENOENT) {
      *payload = strdup("LOCK_NONE");
      return *payload == NULL ? fail_errno(ENOMEM) : 0;
    }
    return -1;
  }
  unsigned char *owner = NULL;
  size_t owner_length = 0U;
  int result = read_named(lock, LOCK_OWNER_NAME, &owner, &owner_length);
  close_fd(&lock);
  if (result < 0) {
    free(owner);
    return result;
  }
  size_t capacity = 128U + encoded_hex_length(owner_length);
  if (capacity > FORGEAX_SECURE_STORE_FS_MAX_FRAME_BYTES) {
    free(owner);
    return fail_errno(EOVERFLOW);
  }
  char *value = (char *)malloc(capacity);
  if (value == NULL) {
    free(owner);
    return fail_errno(ENOMEM);
  }
  int written = snprintf(value, capacity, "LOCK %llu %llu ", (unsigned long long)stats.st_dev, (unsigned long long)stats.st_ino);
  size_t length = written > 0 ? (size_t)written : 0U;
  if (written <= 0 || !append_hex(value, capacity, &length, owner, owner_length)) {
    free(owner);
    free(value);
    return fail_errno(EOVERFLOW);
  }
  free(owner);
  *payload = value;
  return 0;
}

static int parse_profile(const char *value) {
  if (strcmp(value, FORGEAX_SECURE_STORE_FS_PROFILE_WIRE) == 0) {
    selected_profile = PROFILE_WIRE;
    return 0;
  }
  if (strcmp(value, FORGEAX_SECURE_STORE_FS_PROFILE_MODEL) == 0) {
    selected_profile = PROFILE_MODEL;
    return 0;
  }
  return fail_errno(EINVAL);
}

static int process_request(char *line, bool *should_close) {
  char *tokens[FORGEAX_SECURE_STORE_FS_MAX_TOKENS];
  size_t token_count = 0U;
  size_t line_length = strlen(line);
  if (line_length > 0U && line[line_length - 1U] == '\r') line[--line_length] = '\0';
  if (split_tokens(line, tokens, FORGEAX_SECURE_STORE_FS_MAX_TOKENS, &token_count) < 0 || token_count < 3U ||
      strcmp(tokens[0], FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION) != 0 || !safe_request_id(tokens[1])) return fail_errno(EPROTO);
  const char *request_id = tokens[1];
  const char *operation = tokens[2];

#ifdef FORGEAX_SECURE_STORE_TEST_BARRIERS
  if (strcmp(operation, "TEST_BARRIER_ARM") == 0) {
    if (token_count != 4U || arm_barrier(tokens[3]) < 0) reply_error(request_id, "bad_request");
    else reply_ok(request_id, NULL);
    return 0;
  }
  if (strcmp(operation, "TEST_BARRIER_CLEAR") == 0) {
    if (token_count != 3U) reply_error(request_id, "bad_request");
    else {
      armed_barrier[0] = '\0';
      reply_ok(request_id, NULL);
    }
    return 0;
  }
#else
  if (strcmp(operation, "TEST_BARRIER_ARM") == 0 || strcmp(operation, "TEST_BARRIER_CLEAR") == 0) {
    reply_error(request_id, "unsupported");
    return 0;
  }
#endif

  if (strcmp(operation, "CLOSE") == 0) {
    if (token_count != 3U) return fail_errno(EPROTO);
    reply_ok(request_id, "BYE");
    *should_close = true;
    return 0;
  }
  if (root_fd < 0) {
    reply_missing(request_id);
    return 0;
  }
  if (begin_transaction() < 0) {
    reply_error(request_id, "unsafe");
    return 0;
  }

  if (strcmp(operation, "ENSURE") == 0) {
    if (token_count != 3U || ensure_layout() < 0) reply_error(request_id, errno_code(errno));
    else reply_ok(request_id, NULL);
    return 0;
  }
  if (strcmp(operation, "STORAGE") == 0) {
    if (token_count != 3U) {
      reply_error(request_id, "bad_request");
      return 0;
    }
    bool present = false;
    if (storage_present(&present) < 0) reply_error(request_id, errno_code(errno));
    else reply_ok(request_id, present ? "1" : "0");
    return 0;
  }
  if (strcmp(operation, "SYNC") == 0) {
    if (token_count != 4U || !parent_allowed(tokens[3][0]) || strlen(tokens[3]) != 1U) reply_error(request_id, "bad_request");
    else {
      int parent = open_parent(tokens[3][0]);
      if (parent < 0 || !parent_binding_is_current(tokens[3][0], parent) || sync_directory(parent) < 0) reply_error(request_id, errno_code(errno));
      else reply_ok(request_id, NULL);
      close_fd(&parent);
    }
    return 0;
  }
  if (strcmp(operation, "LOCK_INSPECT") == 0) {
    if (token_count != 3U) {
      reply_error(request_id, "bad_request");
      return 0;
    }
    char *payload = NULL;
    if (lock_inspect(&payload) < 0) reply_error(request_id, errno_code(errno));
    else {
      reply_ok(request_id, payload);
      free(payload);
    }
    return 0;
  }
  if (strcmp(operation, "LOCK_ACQUIRE") == 0) {
    if (token_count != 4U) {
      reply_error(request_id, "bad_request");
      return 0;
    }
    unsigned char *owner = NULL;
    size_t owner_length = 0U;
    if (!decode_hex(tokens[3], &owner, &owner_length, FORGEAX_SECURE_STORE_FS_MAX_OWNER_BYTES) || owner_length == 0U) {
      free(owner);
      reply_error(request_id, "bad_request");
      return 0;
    }
    struct stat stats;
    int result = lock_acquire(owner, owner_length, &stats);
    free(owner);
    if (result < 0) {
      if (errno == EEXIST) reply_ok(request_id, "BUSY");
      else reply_error(request_id, errno_code(errno));
    } else {
      char payload[128U];
      (void)snprintf(payload, sizeof(payload), "ACQUIRED %llu %llu", (unsigned long long)stats.st_dev, (unsigned long long)stats.st_ino);
      reply_ok(request_id, payload);
    }
    return 0;
  }
  if (strcmp(operation, "LOCK_RECLAIM") == 0 || strcmp(operation, "LOCK_RELEASE") == 0) {
    if (token_count != 7U) {
      reply_error(request_id, "bad_request");
      return 0;
    }
    uint64_t expected_dev = 0U;
    uint64_t expected_ino = 0U;
    if (parse_u64(tokens[4], &expected_dev) < 0 || parse_u64(tokens[5], &expected_ino) < 0 || !safe_nonce(tokens[3])) {
      reply_error(request_id, "bad_request");
      return 0;
    }
    unsigned char *owner = NULL;
    size_t owner_length = 0U;
    if (!decode_hex(tokens[6], &owner, &owner_length, FORGEAX_SECURE_STORE_FS_MAX_OWNER_BYTES) || owner_length == 0U) {
      free(owner);
      reply_error(request_id, "bad_request");
      return 0;
    }
    int result = lock_remove(strcmp(operation, "LOCK_RECLAIM") == 0 ? 'R' : 'L', expected_dev, expected_ino, tokens[3], owner, owner_length);
    free(owner);
    if (result < 0) reply_error(request_id, errno_code(errno));
    else reply_ok(request_id, result == 1 ? "NO" : "YES");
    return 0;
  }
  if (strcmp(operation, "LOCK_HEARTBEAT") == 0) {
    if (token_count != 7U) {
      reply_error(request_id, "bad_request");
      return 0;
    }
    uint64_t expected_dev = 0U;
    uint64_t expected_ino = 0U;
    if (parse_u64(tokens[3], &expected_dev) < 0 || parse_u64(tokens[4], &expected_ino) < 0) {
      reply_error(request_id, "bad_request");
      return 0;
    }
    unsigned char *old_owner = NULL;
    unsigned char *new_owner = NULL;
    size_t old_length = 0U;
    size_t new_length = 0U;
    if (!decode_hex(tokens[5], &old_owner, &old_length, FORGEAX_SECURE_STORE_FS_MAX_OWNER_BYTES) ||
        !decode_hex(tokens[6], &new_owner, &new_length, FORGEAX_SECURE_STORE_FS_MAX_OWNER_BYTES) || old_length == 0U || new_length == 0U) {
      free(old_owner);
      free(new_owner);
      reply_error(request_id, "bad_request");
      return 0;
    }
    int result = lock_heartbeat(expected_dev, expected_ino, old_owner, old_length, new_owner, new_length);
    free(old_owner);
    free(new_owner);
    if (result < 0) reply_error(request_id, errno_code(errno));
    else reply_ok(request_id, NULL);
    return 0;
  }

  bool named_operation = strcmp(operation, "READ") == 0 || strcmp(operation, "WRITE_EXCLUSIVE") == 0 ||
    strcmp(operation, "APPEND") == 0 || strcmp(operation, "WRITE_ATOMIC") == 0 ||
    strcmp(operation, "CREATE_IF_ABSENT") == 0 || strcmp(operation, "REMOVE") == 0 ||
    strcmp(operation, "LIST") == 0 || strcmp(operation, "MKDIR") == 0 || strcmp(operation, "RMDIR") == 0;
  if (named_operation) {
    if (token_count < 4U || strlen(tokens[3]) != 1U || !parent_allowed(tokens[3][0])) {
      reply_error(request_id, "bad_request");
      return 0;
    }
    char parent_code = tokens[3][0];
    int parent = open_parent(parent_code);
    if (parent < 0) {
      reply_error(request_id, errno_code(errno));
      return 0;
    }
    if (strcmp(operation, "LIST") == 0) {
      if (token_count != 4U) reply_error(request_id, "bad_request");
      else {
        char *payload = NULL;
        if (list_directory(parent_code, parent, &payload) < 0) reply_error(request_id, errno_code(errno));
        else {
          reply_ok(request_id, payload);
          free(payload);
        }
      }
      close_fd(&parent);
      return 0;
    }
    if (token_count < 5U) {
      close_fd(&parent);
      reply_error(request_id, "bad_request");
      return 0;
    }
    char name[NAME_MAX + 1U];
    if (decode_name(tokens[4], name, sizeof(name)) < 0) {
      close_fd(&parent);
      reply_error(request_id, "bad_request");
      return 0;
    }
    if (!named_capability_allowed(operation, parent_code, name)) {
      close_fd(&parent);
      reply_error(request_id, "bad_request");
      return 0;
    }
    if (strcmp(operation, "READ") == 0) {
      if (token_count != 5U || !parent_binding_is_current(parent_code, parent)) {
        reply_error(request_id, token_count != 5U ? "bad_request" : "unsafe");
      } else {
        struct stat expected;
        int state = stat_named(parent, name, &expected, true);
        if (state < 0) reply_error(request_id, errno_code(errno));
        else if (state == 1) reply_error(request_id, "not_found");
        else if (!regular_file_stat(&expected)) reply_error(request_id, "unsafe");
        else if (wait_barrier("open-read") < 0 || !parent_binding_is_current(parent_code, parent)) reply_error(request_id, "unsafe");
        else {
          int fd = openat(parent, name, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
          if (fd < 0) reply_error(request_id, errno_code(errno));
          else {
            struct stat opened;
            unsigned char *bytes = NULL;
            size_t length = 0U;
            int result = fstat(fd, &opened);
            if (result == 0 && (!regular_file_stat(&opened) || !same_file(&opened, &expected))) result = fail_errno(EACCES);
            if (result == 0) {
              struct stat named;
              if (fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) < 0 || !same_file(&opened, &named)) result = fail_errno(EACCES);
            }
            if (result == 0) result = read_fd(fd, &bytes, &length);
            close_fd(&fd);
            if (result < 0) {
              free(bytes);
              reply_error(request_id, errno_code(errno));
            } else {
              size_t capacity = 32U + encoded_hex_length(length);
              char *payload = (char *)malloc(capacity);
              size_t payload_length = 0U;
              if (payload == NULL || !append_text(payload, capacity, &payload_length, "DATA ") || !append_hex(payload, capacity, &payload_length, bytes, length)) {
                free(payload);
                free(bytes);
                reply_error(request_id, "limit");
              } else {
                reply_ok(request_id, payload);
                free(payload);
                free(bytes);
              }
            }
          }
        }
      }
      close_fd(&parent);
      return 0;
    }
    if (strcmp(operation, "REMOVE") == 0 || strcmp(operation, "RMDIR") == 0 || strcmp(operation, "MKDIR") == 0) {
      if (token_count != 5U) reply_error(request_id, "bad_request");
      else {
        int result = strcmp(operation, "REMOVE") == 0 ? remove_file(parent_code, parent, name) :
          strcmp(operation, "RMDIR") == 0 ? remove_directory(parent_code, parent, name) : mkdir_directory(parent_code, parent, name);
        if (result < 0) reply_error(request_id, errno_code(errno));
        else reply_ok(request_id, NULL);
      }
      close_fd(&parent);
      return 0;
    }
    if (token_count != 6U) {
      close_fd(&parent);
      reply_error(request_id, "bad_request");
      return 0;
    }
    unsigned char *content = NULL;
    size_t content_length = 0U;
    if (decode_content(tokens[5], &content, &content_length) < 0) {
      close_fd(&parent);
      reply_error(request_id, "limit");
      return 0;
    }
    int result = strcmp(operation, "WRITE_EXCLUSIVE") == 0 ? write_exclusive(parent_code, parent, name, content, content_length) :
      strcmp(operation, "APPEND") == 0 ? append_file(parent_code, parent, name, content, content_length) :
      strcmp(operation, "WRITE_ATOMIC") == 0 ? atomic_replace(parent_code, parent, name, content, content_length) :
      strcmp(operation, "CREATE_IF_ABSENT") == 0 ? atomic_create_if_absent(parent_code, parent, name, content, content_length) : fail_errno(EPROTO);
    free(content);
    if (result < 0) reply_error(request_id, errno_code(errno));
    else reply_ok(request_id, NULL);
    close_fd(&parent);
    return 0;
  }

  if (strcmp(operation, "RENAME_DIR") == 0) {
    /* Directory lifecycle is reserved to ENSURE and LOCK_* opcodes. */
    reply_error(request_id, "bad_request");
    return 0;
  }

  reply_error(request_id, "bad_request");
  return 0;
}

static int close_all(void) {
  close_fd(&blobs_fd);
  close_fd(&reservations_fd);
  close_fd(&root_fd);
  close_fd(&root_parent_fd);
  return 0;
}

int main(int argc, char **argv) {
  volatile const char *build_marker = BUILD_MARKER;
  if (build_marker[0] == '\0') return 4;
  if (argc != 4 || argv[1] == NULL || argv[2] == NULL || argv[3] == NULL ||
      (strcmp(argv[2], "create") != 0 && strcmp(argv[2], "existing") != 0) || parse_profile(argv[3]) < 0) {
    (void)fprintf(stdout, "%s FATAL bad_startup\n", FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION);
    return 2;
  }
  bool missing = false;
  if (open_authority_root(argv[1], strcmp(argv[2], "create") == 0, &missing) < 0) {
    if (missing && strcmp(argv[2], "existing") == 0) {
      (void)fprintf(stdout, "%s READY missing\n", FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION);
      (void)fflush(stdout);
    } else {
      (void)fprintf(stdout, "%s FATAL unsafe\n", FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION);
      close_all();
      return 3;
    }
  } else {
    (void)fprintf(stdout, "%s READY ok %s\n", FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION, profile_name());
    (void)fflush(stdout);
  }

  char *frame = (char *)malloc((size_t)FORGEAX_SECURE_STORE_FS_MAX_FRAME_BYTES + 1U);
  if (frame == NULL) {
    close_all();
    return 4;
  }
  bool should_close = false;
  while (!should_close) {
    bool eof = false;
    int frame_result = read_frame(frame, (size_t)FORGEAX_SECURE_STORE_FS_MAX_FRAME_BYTES + 1U, &eof);
    if (frame_result < 0) {
      (void)fprintf(stdout, "%s FATAL protocol\n", FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION);
      (void)fflush(stdout);
      free(frame);
      close_all();
      return 5;
    }
    if (frame_result > 0 && process_request(frame, &should_close) < 0) {
      (void)fprintf(stdout, "%s FATAL protocol\n", FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION);
      (void)fflush(stdout);
      free(frame);
      close_all();
      return 5;
    }
    if (eof) break;
  }
  free(frame);
  close_all();
  return 0;
}
