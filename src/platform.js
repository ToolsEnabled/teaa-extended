// Operating-system details: where TEAA keeps its files, how commands are found and started,
// and how a process tree is stopped. Linux and native Windows (no WSL) are both first-class.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

export const isWindows = process.platform === 'win32';

export function configDir(env = process.env) {
  if (isWindows) return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'ToolsEnabled', 'toolsenabled-agent-kit');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'toolsenabled-agent-kit');
}

export function dataDir(env = process.env) {
  if (isWindows) return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ToolsEnabled', 'toolsenabled-agent-kit');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'toolsenabled-agent-kit');
}

// MCP uses the caller’s working directory unless explicitly configured.
export function defaultWorkFolder() {
  return process.cwd();
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function isProgram(p) {
  if (!isFile(p)) return false;
  if (isWindows || /\.(m?js|cjs)$/i.test(p)) return true;
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
}

// Find a program on PATH. On Windows the PATHEXT extensions are tried in order.
export function which(name, env = process.env) {
  if (typeof name !== 'string' || !name || name.includes('\0')) return null;
  if (isAbsolute(name) || name.includes('/') || (isWindows && name.includes('\\'))) {
    if (isProgram(name)) return resolve(name);
    if (isWindows) for (const ext of pathExts(env)) if (isFile(name + ext)) return resolve(name + ext);
    return null;
  }
  const dirs = (env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  const exts = isWindows ? ['', ...pathExts(env)] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir.replace(/^"|"$/g, ''), name + ext);
      if (isWindows && ext === '' && !/\.[A-Za-z0-9]+$/.test(name)) continue;
      if (isProgram(candidate)) return candidate;
    }
  }
  return null;
}

// Find a usable Python 3.11+ runtime without invoking shell aliases. On Windows,
// `python.exe` is the standard python.org/Store package name while `python3.exe`
// is common on Unix and some Windows installs. Never execute the WindowsApps
// Store alias: it can open UI or prompt for an install instead of running Python.
export function python311(env = process.env) {
  const dirs = (env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  const names = isWindows ? ['python.exe', 'python3.exe'] : ['python3'];
  const seen = new Set();
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = which(name, { ...env, PATH: dir, Path: '' });
      if (!candidate) continue;
      if (isWindows && /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(candidate)) continue;
      const key = isWindows ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      const result = spawnSync(candidate, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'], {
        encoding: 'utf8', windowsHide: true, timeout: 15_000, shell: false,
      });
      if (!result.error && result.status === 0) return candidate;
    }
  }
  return null;
}

export function requirePython311(env = process.env) {
  const python = python311(env);
  if (!python) throw new Error('Python 3.11 or newer was not found on PATH. Knowledge MCP needs Python 3.11 or newer.');
  return python;
}

function pathExts(env) {
  return (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
}

// npm puts a .cmd shim on Windows for every package binary. Running a .cmd needs cmd.exe,
// whose quoting is unsafe for free text, so look inside the shim for the script it starts
// and run that script with Node directly.
export function shimTarget(cmdPath) {
  let text;
  try { text = readFileSync(cmdPath, 'utf8'); } catch { return null; }
  const m = /"(?:%dp0%|%~dp0)\\?([^"]+?\.(?:js|cjs|mjs))"/i.exec(text) || /%~dp0\\?([^\s"]+?\.(?:js|cjs|mjs))/i.exec(text);
  if (!m) return null;
  const script = join(dirname(cmdPath), m[1].replace(/\\/g, '/'));
  return isFile(script) ? script : null;
}

// Turn a configured { command, args } into something child_process.spawn can run without a shell.
export function resolveCommand(command, args = [], env = process.env) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Program arguments must be strings without NUL characters');
  if (command === 'node' || command === process.execPath) return { file: process.execPath, args, shell: false };
  const found = which(command, env);
  if (!found) return { file: null, args, shell: false, missing: command };
  if (isWindows && /\.(cmd|bat)$/i.test(found)) {
    const script = shimTarget(found);
    if (script) return { file: process.execPath, args: [script, ...args], shell: false, via: found };
    throw new Error(`Cannot safely launch this Windows batch file: ${found}. Configure the executable or JavaScript entry point instead.`);
  }
  if (isWindows && /\.ps1$/i.test(found)) {
    return { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', found, ...args], shell: false };
  }
  if (/\.(m?js|cjs)$/i.test(found)) return { file: process.execPath, args: [found, ...args], shell: false };
  return { file: found, args, shell: false };
}

// Native terminal commands keep their own executable/shim behavior. MCP discovery above
// may unwrap a known Node shim; foreground commands must execute the actual user command.
const cmdMeta = /([()\][%!^"`<>&|;, *?])/g;
export function cmdQuote(arg, doubleEscape = false) {
  // Windows argv quoting, then cmd metacharacter escaping. Batch forwarding parses twice.
  let quoted = '"' + String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  quoted = quoted.replace(cmdMeta, '^$1');
  return doubleEscape ? quoted.replace(cmdMeta, '^$1') : quoted;
}
export function resolveTerminalCommand(command, args = [], env = process.env) {
  if (typeof command !== 'string' || !command || command.includes('\0')) throw new Error('Command must be a non-empty string without NUL characters');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Program arguments must be strings without NUL characters');
  if (!isWindows) return { file: command, args: [...args] };
  const file = which(command, env) || command;
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args: [...args] };
  if ([file, ...args].some(value => /[\r\n]/.test(value))) throw new Error('Windows batch files cannot safely receive multiline arguments; launch the underlying executable instead.');
  // A literal quote would change the batch's quote state when %* is expanded.
  // Protect those arguments through both parses, wherever the shim is installed.
  // Ordinary arguments need one pass so native batch %~1/IF handling still works.
  // Batch scripts can explicitly re-expand text with CALL/delayed expansion; no
  // argv encoder can undo arbitrary script evaluation without changing the script.
  const line = [file.replace(cmdMeta, '^$1'), ...args.map(arg => cmdQuote(arg, arg.includes('"')))].join(' ');
  return {
    file: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/v:off', '/c', `"${line}"`], windowsVerbatimArguments: true,
  };
}

export function spawnResolved(resolved, options = {}) {
  if (!resolved.file) throw new Error(`Program not found: ${resolved.missing}`);
  if (resolved.shell || options.shell) throw new Error('TEAA launches programs without a command shell; configure an executable or JavaScript entry point.');
  return spawn(resolved.file, resolved.args, { ...options, shell: false, detached: !isWindows && options.detached !== false, windowsHide: options.windowsHide ?? true });
}

export function spawnResolvedSync(resolved, options = {}) {
  if (!resolved.file) throw new Error(`Program not found: ${resolved.missing}`);
  if (resolved.shell || options.shell) throw new Error('TEAA launches programs without a command shell; configure an executable or JavaScript entry point.');
  return spawnSync(resolved.file, resolved.args, { ...options, shell: false, windowsHide: options.windowsHide ?? true });
}

// Stop a child and everything it started.
export function killTree(child, signal = 'SIGTERM', { drain = false } = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0 || child.teaaClosed) return;
  if ((child.exitCode !== null || child.signalCode) && (isWindows || !drain)) return;
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    return;
  }
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

export function osLabel() {
  if (isWindows) return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return 'Linux';
}

export function exists(p) {
  return !!p && existsSync(p);
}
