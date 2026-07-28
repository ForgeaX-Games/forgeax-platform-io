/**
 * Filesystem browser endpoint — lets the Studio UI walk the server's
 * filesystem to pick a directory as a workspace. Separate from /api/files
 * (which is whitelisted to FORGEAX_PROJECT_ROOT/{games,packages,.forgeax/games}
 * via resolveSafePath) because workspace selection by definition needs to
 * reach OUTSIDE the current project root.
 *
 * Safety:
 *   - tilde expansion (~ / ~/foo) using $HOME
 *   - absolute path required
 *   - reject NUL byte
 *   - directory blocklist (system mounts that have no business being a
 *     ForgeaX workspace and that could surface sensitive content)
 *
 *   GET  /api/fs/browse?dir=<abs|~/foo>
 *   POST /api/fs/pick-directory — native OS folder dialog (local server only)
 */

import { Hono } from 'hono';
import { readdir, stat, access, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, basename } from 'node:path';
import { friendlyPath } from './lib/friendly-path';

const execFileAsync = promisify(execFile);

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

const DIR_BLOCKLIST_PREFIXES = [
  '/proc',
  '/sys',
  '/dev',
  '/etc',
  '/var/run',
  '/var/lib/docker',
  '/run',
  '/boot',
];

function expandTilde(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function isBlocklisted(absPath: string): boolean {
  for (const prefix of DIR_BLOCKLIST_PREFIXES) {
    if (absPath === prefix) return true;
    if (absPath.startsWith(prefix + '/')) return true;
  }
  return false;
}

interface Entry {
  name: string;
  isDir: boolean;
  hasForgeaX: boolean;
  hasGames: boolean;
}

/** PowerShell driver for the Windows folder dialog.
 *
 *  `ShowDialog()` with no owner used to sink the picker to the BOTTOM of the
 *  z-order: `fx start` spawns the stack detached, so the server process owns no
 *  foreground window and Win32's foreground lock refuses to raise an unowned
 *  dialog. The user saw nothing happen while the request hung for 5 minutes.
 *  The fix is a TopMost owner form that first steals foreground (via
 *  AttachThreadInput, the only sanctioned way out of the lock), then owns the
 *  dialog so it inherits the topmost band.
 *
 *  Shipped as a temp .ps1 rather than `-Command`: a here-string this size does
 *  not survive Windows argv quoting. Initial directory arrives via env var for
 *  the same reason. */
const WIN_PICK_DIRECTORY_PS1 = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms

  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ForgeaxFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@

  $owner = New-Object System.Windows.Forms.Form
  $owner.StartPosition = 'CenterScreen'
  $owner.FormBorderStyle = 'FixedToolWindow'
  $owner.Width = 1
  $owner.Height = 1
  $owner.Opacity = 0
  $owner.ShowInTaskbar = $false
  $owner.TopMost = $true
  $owner.Show()
  [System.Windows.Forms.Application]::DoEvents()

  $fgHwnd = [ForgeaxFg]::GetForegroundWindow()
  $fgThread = [ForgeaxFg]::GetWindowThreadProcessId($fgHwnd, [IntPtr]::Zero)
  $selfThread = [ForgeaxFg]::GetCurrentThreadId()
  $attached = $false
  if ($fgThread -ne 0 -and $fgThread -ne $selfThread) {
    $attached = [ForgeaxFg]::AttachThreadInput($fgThread, $selfThread, $true)
  }
  [void][ForgeaxFg]::BringWindowToTop($owner.Handle)
  [void][ForgeaxFg]::SetForegroundWindow($owner.Handle)
  if ($attached) { [void][ForgeaxFg]::AttachThreadInput($fgThread, $selfThread, $false) }

  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'Select a folder'
  $dialog.ShowNewFolderButton = $true
  if ($env:FORGEAX_PICK_INITIAL_DIR) { $dialog.SelectedPath = $env:FORGEAX_PICK_INITIAL_DIR }

  $result = $dialog.ShowDialog($owner)
  $owner.Close()
  $owner.Dispose()
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
  }
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
`;

async function pickDirectoryWin32(initialDir?: string): Promise<{ path: string } | { cancelled: true }> {
  const scriptPath = join(tmpdir(), `forgeax-pick-dir-${randomUUID()}.ps1`);
  await writeFile(scriptPath, WIN_PICK_DIRECTORY_PS1, 'utf8');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        timeout: 300_000,
        maxBuffer: 1024 * 1024,
        env: initialDir ? { ...process.env, FORGEAX_PICK_INITIAL_DIR: initialDir } : process.env,
      },
    );
    const path = stdout.trim();
    if (!path) return { cancelled: true };
    return { path: resolve(path) };
  } catch (e) {
    // execFile's own message is the whole argv incl. the temp path; the script's
    // stderr is the part a user can act on.
    const stderr = String((e as { stderr?: unknown }).stderr ?? '').trim();
    if (stderr) throw new Error(stderr);
    throw e;
  } finally {
    await rm(scriptPath, { force: true }).catch(() => { /* temp file, best-effort */ });
  }
}

/** Open the OS-native folder picker on the machine running the Studio server.
 *  Returns an absolute path, or null when the user cancels.
 *  `initialDir` (already validated absolute) is where the dialog opens. */
async function pickDirectoryNative(initialDir?: string): Promise<{ path: string } | { cancelled: true }> {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      // AppleScript string literal: backslash and quote are the only escapes.
      const location = initialDir
        ? ` default location POSIX file "${initialDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        : '';
      const { stdout } = await execFileAsync('osascript', [
        '-e',
        `POSIX path of (choose folder with prompt "Select a folder"${location})`,
      ], { timeout: 300_000, maxBuffer: 1024 * 1024 });
      const path = stdout.trim().replace(/\/$/, '');
      if (!path) return { cancelled: true };
      return { path: resolve(path) };
    }
    if (platform === 'win32') {
      return await pickDirectoryWin32(initialDir);
    }
    // Linux: prefer zenity, then kdialog.
    try {
      const zenityArgs = ['--file-selection', '--directory', '--title=Select a folder'];
      // zenity only treats --filename as a start directory when it ends in '/'.
      if (initialDir) zenityArgs.push(`--filename=${initialDir.replace(/\/$/, '')}/`);
      const { stdout } = await execFileAsync('zenity', zenityArgs, {
        timeout: 300_000,
        maxBuffer: 1024 * 1024,
      });
      const path = stdout.trim();
      if (!path) return { cancelled: true };
      return { path: resolve(path) };
    } catch (zenityErr) {
      const code = (zenityErr as { code?: number }).code;
      // zenity returns 1 on cancel
      if (code === 1) return { cancelled: true };
      const { stdout } = await execFileAsync('kdialog', ['--getexistingdirectory', initialDir ?? homedir()], {
        timeout: 300_000,
        maxBuffer: 1024 * 1024,
      });
      const path = stdout.trim();
      if (!path) return { cancelled: true };
      return { path: resolve(path) };
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    // AppleScript user cancel: "User canceled."
    if (/User canceled|cancelled|canceled/i.test(msg)) return { cancelled: true };
    const code = (e as { code?: number }).code;
    if (code === 1) return { cancelled: true };
    throw e;
  }
}

export function createFsBrowserRouter(): Hono {
  const r = new Hono();

  r.get('/browse', async (c) => {
    const raw = (c.req.query('dir') ?? '~').trim();
    if (raw.includes('\0')) return c.json({ error: 'invalid path (NUL byte)' }, 400);

    let abs = expandTilde(raw);
    if (!isAbsolute(abs)) return c.json({ error: 'dir must be an absolute path or start with ~' }, 400);
    abs = resolve(abs);

    if (isBlocklisted(abs)) {
      return c.json({ error: `${friendlyPath(abs)} is on the system blocklist` }, 400);
    }

    let st;
    try { st = await stat(abs); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return c.json({ error: `not found: ${friendlyPath(abs)}` }, 404);
      return c.json({ error: (e as Error).message }, 500);
    }
    if (!st.isDirectory()) return c.json({ error: `not a directory: ${friendlyPath(abs)}` }, 400);

    // readdir({withFileTypes:true}) replaces a per-entry statSync — we get
    // dirent.isDirectory() for free. The 3 existsSync probes per dir are
    // launched concurrently with Promise.all so the workspace picker can
    // browse a 100-entry dir without serializing 400 stat calls.
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
    const visibleDirs = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    const entries: Entry[] = await Promise.all(visibleDirs.map(async (d) => {
      const child = join(abs, d.name);
      const [hasForgeaX, hasForgeaxGames, hasGamesTop] = await Promise.all([
        exists(join(child, '.forgeax')),
        exists(join(child, '.forgeax', 'games')),
        exists(join(child, 'games')),
      ]);
      return { name: d.name, isDir: true, hasForgeaX, hasGames: hasForgeaxGames || hasGamesTop };
    }));
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const [selfHasForgeaX, selfHasForgeaxGames, selfHasGamesTop] = await Promise.all([
      exists(join(abs, '.forgeax')),
      exists(join(abs, '.forgeax', 'games')),
      exists(join(abs, 'games')),
    ]);

    const parent = dirname(abs);
    return c.json({
      dir: abs,
      dirDisplay: friendlyPath(abs),
      parent: parent === abs ? null : parent,
      parentDisplay: parent === abs ? null : friendlyPath(parent),
      name: basename(abs) || abs,
      selfHasForgeaX,
      selfHasGames: selfHasForgeaxGames || selfHasGamesTop,
      entries,
    });
  });

  // Native OS folder dialog — used by onboarding "更改" / "打开目录" so we don't
  // force the in-app FsBrowser. Studio server and UI run on the same machine.
  r.post('/pick-directory', async (c) => {
    try {
      // Optional `{ initialDir }` — the in-app browser sends the directory it is
      // currently showing so the native dialog opens there instead of Desktop.
      // Onboarding posts no body at all, so every failure path just drops it.
      let initialDir: string | undefined;
      try {
        const body = await c.req.json<{ initialDir?: unknown }>();
        const raw = typeof body?.initialDir === 'string' ? body.initialDir.trim() : '';
        if (raw && !raw.includes('\0')) {
          const expanded = expandTilde(raw);
          if (isAbsolute(expanded)) {
            const abs = resolve(expanded);
            if (!isBlocklisted(abs)) initialDir = abs;
          }
        }
      } catch { /* absent or malformed body — open at the OS default */ }

      const result = await pickDirectoryNative(initialDir);
      if ('cancelled' in result) return c.json({ ok: false, cancelled: true });
      if (isBlocklisted(result.path)) {
        return c.json({ error: `${friendlyPath(result.path)} is on the system blocklist` }, 400);
      }
      return c.json({ ok: true, path: result.path, pathDisplay: friendlyPath(result.path) });
    } catch (e) {
      return c.json({
        error: (e as Error).message
          || 'Native folder picker unavailable — install zenity/kdialog on Linux, or use a desktop session.',
      }, 500);
    }
  });

  return r;
}
