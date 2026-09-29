#ifndef FORGEAX_SECURE_STORE_FS_PROTOCOL_H
#define FORGEAX_SECURE_STORE_FS_PROTOCOL_H

/*
 * SSF1 is a deliberately closed, line-oriented protocol.  The broker gets
 * the authority root only as an exec-time argument.  After READY, requests
 * contain profile-derived parent slots, one validated basename, bounded
 * scalar fields, and hex bytes; they never contain paths.
 */
#define FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION "SSF1"
#define FORGEAX_SECURE_STORE_FS_ARTIFACT_PROTOCOL_VERSION 1U

#define FORGEAX_SECURE_STORE_FS_PROFILE_WIRE "wire-capture-v1"
#define FORGEAX_SECURE_STORE_FS_PROFILE_MODEL "model-exchange-v1"

#define FORGEAX_SECURE_STORE_FS_MAX_ROOT_BYTES 4096U
#define FORGEAX_SECURE_STORE_FS_MAX_NAME_BYTES 255U
#define FORGEAX_SECURE_STORE_FS_MAX_OWNER_BYTES 4096U
#define FORGEAX_SECURE_STORE_FS_MAX_CONTENT_BYTES (16U * 1024U * 1024U)
#define FORGEAX_SECURE_STORE_FS_MAX_FILE_BYTES (16U * 1024U * 1024U)
#define FORGEAX_SECURE_STORE_FS_MAX_FRAME_BYTES (64U * 1024U * 1024U)
#define FORGEAX_SECURE_STORE_FS_MAX_LIST_ENTRIES 4096U
#define FORGEAX_SECURE_STORE_FS_MAX_ROOT_COMPONENTS 256U
#define FORGEAX_SECURE_STORE_FS_MAX_TOKENS 12U
#define FORGEAX_SECURE_STORE_FS_MAX_BARRIER_NAME_BYTES 64U

/* Release metadata is intentionally closed to these four native targets. */
#define FORGEAX_SECURE_STORE_FS_TARGET_DARWIN_ARM64 "darwin-arm64"
#define FORGEAX_SECURE_STORE_FS_TARGET_DARWIN_X64 "darwin-x64"
#define FORGEAX_SECURE_STORE_FS_TARGET_LINUX_ARM64 "linux-arm64"
#define FORGEAX_SECURE_STORE_FS_TARGET_LINUX_X64 "linux-x64"

#endif
