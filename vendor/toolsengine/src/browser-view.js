// Showing ToolsEngine's hidden browser to the person, and hiding it again.
//
// The browser runs on a private X display: an Xvfb that only holders of a
// random cookie can use, with no TCP listener. Nothing of it is on the
// person's screen. Showing it starts two programs and nothing else:
//
//   - TigerVNC's scraping server, attached to that private display. It
//     listens only on a Unix socket in a private folder (mode 0700, the
//     socket 0600), on no TCP port, and asks for a random VNC password that
//     is written to a file in the same folder (mode 0600).
//   - TigerVNC's viewer, on the person's own display, connected to that
//     socket with that password. Its window shows the private display live;
//     the person can watch it and click and type in it.
//
// Hiding stops both programs, by the process numbers this module started,
// and removes the folder. The browser itself is never restarted, moved or
// reloaded: its tabs, pages, cookies and sign-ins stay as they are, and the
// browser tools go on acting in it while it is shown and after it is hidden.
// If the person closes the viewer window themselves, that is a hide too.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createCipheriv, randomInt } from 'node:crypto';

// Default programs are taken from these folders, never from PATH, as the trusted
// browser locations are: a PATH entry in the client's environment must not
// decide which program receives the browser's pixels and the person's input.
// A caller can explicitly configure a checked local package prefix instead.
export const TRUSTED_PROGRAM_FOLDERS = Object.freeze(['/usr/bin', '/usr/local/bin', '/bin']);
export const VIEW_SERVERS = Object.freeze(['X0tigervnc', 'x0vncserver']);
export const VIEW_VIEWERS = Object.freeze(['xtigervncviewer', 'vncviewer']);
export const VIEW_TITLE = 'ToolsEngine browser';
export const VIEW_INSTALL = 'Showing the browser needs TigerVNC\'s scraping server (x0vncserver) and viewer (vncviewer); on Debian and Ubuntu they are the packages tigervnc-scraping-server and tigervnc-viewer.';
export const NOTHING_SHOWN = 'Nothing was shown; the browser keeps running hidden.';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- The VNC password file -------------------------------------------------
//
// TigerVNC keeps a password "obfuscated": DES-encrypted with a fixed key,
// whose bits are used in reverse order. Single DES is not offered by every
// OpenSSL build; two-key triple DES with both keys equal is the same cipher.
// This is the format of `vncpasswd -f`, and the password it holds is random
// for each showing.
const VNC_KEY = Object.freeze([23, 82, 107, 6, 35, 78, 88, 7]);
const reverseBits = byte => { let result = 0; for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) result |= 1 << (7 - bit); return result; };
export function obfuscateVncPassword(password) {
  const plain = Buffer.alloc(8);
  Buffer.from(String(password), 'latin1').copy(plain, 0, 0, 8);
  const key = Buffer.from(VNC_KEY.map(reverseBits));
  const cipher = createCipheriv('des-ede-ecb', Buffer.concat([key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}
// Eight characters (the most a VNC password holds) from 56 letters and digits
// that are not easily confused: about 46 bits, new for every showing.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function randomVncPassword() {
  return Array.from({ length: 8 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join('');
}

// --- Displays --------------------------------------------------------------

// The display number of an X display name such as ":1", ":1.0", "unix:1" or
// "localhost:10.0", or null.
export function displayNumber(value) {
  return /^(?:[A-Za-z0-9.-]*):(\d+)(?:\.\d+)?$/.exec(String(value ?? ''))?.[1] ?? null;
}
const LOCAL_DISPLAY = /^(?:unix)?:\d+(?:\.\d+)?$/;
// ssh -X forwards the person's display to a loopback port of this computer.
const FORWARDED_DISPLAY = /^(?:localhost|127\.0\.0\.1):\d+(?:\.\d+)?$/;

// Where the viewer window goes: the display ToolsEngine was started with,
// which is the person's own. Only a display of this computer is used; one
// named on another host would send the browser's pixels and the person's
// keys over the network without encryption.
export function personDisplayFrom({ display, xauthority, wayland, home = os.homedir(), exists = existsSync } = {}) {
  if (!display) {
    if (wayland) throw new Error(`The person's session is Wayland without an X11 (XWayland) display, and the viewer window needs X11. ${NOTHING_SHOWN}`);
    throw new Error(`ToolsEngine was started without the person's screen (no DISPLAY), for example as a background worker, so there is nowhere to show the browser. ${NOTHING_SHOWN}`);
  }
  if (!LOCAL_DISPLAY.test(display) && !FORWARDED_DISPLAY.test(display))
    throw new Error(`DISPLAY (${String(display).slice(0, 80)}) is not a display of this computer; the browser is shown only on a local display or one forwarded by ssh. ${NOTHING_SHOWN}`);
  // The viewer runs with a private home folder (below), where the person's
  // default ~/.Xauthority would not be found: name it.
  const authority = xauthority || (exists(path.join(home, '.Xauthority')) ? path.join(home, '.Xauthority') : undefined);
  return { display: String(display), ...(authority ? { xauthority: authority } : {}) };
}

// --- Finding TigerVNC ------------------------------------------------------

const execFileText = (file, args, options) => new Promise(resolve => {
  execFile(file, args, options, (error, stdout, stderr) => resolve(`${stdout || ''}${stderr || ''}`));
});
// Other programs are called vncviewer and x0vncserver too, with other
// options; only TigerVNC's are used. Each says so in its help text.
export async function isTigerVnc(file, kind, { run = execFileText, env = {} } = {}) {
  const text = await run(file, ['-help'], { timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), ...env }, maxBuffer: 1024 * 1024 });
  return kind === 'server' ? /TigerVNC Server/.test(text) : /TigerVNC Viewer/.test(text);
}
export async function findViewPrograms({ folders = TRUSTED_PROGRAM_FOLDERS, exists = existsSync, probe = isTigerVnc } = {}) {
  const pick = async (names, kind) => {
    for (const folder of folders) for (const name of names) {
      const file = path.join(folder, name);
      if (exists(file) && await probe(file, kind)) return file;
    }
    return null;
  };
  return { server: await pick(VIEW_SERVERS, 'server'), viewer: await pick(VIEW_VIEWERS, 'viewer') };
}

// An explicitly configured, locally unpacked distribution runtime. This is
// never searched through PATH or selected by page content. The same prefix
// supplies both executables and their optional multiarch shared libraries.
export async function viewProgramsFromRuntime(root) {
  const prefix = path.resolve(root);
  const check = async file => {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || ![0, process.getuid()].includes(stat.uid) || (stat.mode & 0o022))
      throw new Error('The browser view runtime must be owned by this account or root, not linked or writable by other accounts.');
    return stat;
  };
  for (const directory of [prefix, path.join(prefix, 'bin')]) {
    if (!(await check(directory)).isDirectory()) throw new Error('The browser view runtime needs a bin directory.');
  }
  const arch = { x64: 'x86_64-linux-gnu', arm64: 'aarch64-linux-gnu' }[process.arch];
  const library = arch && path.join(prefix, 'lib', arch);
  const env = {};
  if (library && existsSync(library)) {
    for (const directory of [path.join(prefix, 'lib'), library]) {
      if (!(await check(directory)).isDirectory()) throw new Error('The browser view runtime library path must be a directory.');
    }
    env.LD_LIBRARY_PATH = library;
  }
  const programs = await findViewPrograms({
    folders: [path.join(prefix, 'bin')],
    probe: async (file, kind) => (await check(file)).isFile() && isTigerVnc(file, kind, { env }),
  });
  if (!programs.server || !programs.viewer) throw new Error('The configured browser view runtime needs both TigerVNC programs.');
  return { ...programs, env };
}

// --- The private folder ----------------------------------------------------

// A folder only this account can enter, for the socket and the password. A
// Unix socket path holds about 100 bytes; past that the socket is named
// through this process's open handle on the folder, as the browser's own
// sockets are (workspaceSocketTemp in browser.js).
export const LONGEST_SOCKET_PATH = 100;
export function socketPathFor(directory, fd, pid = process.pid) {
  const direct = path.join(directory, 'view.sock');
  return Buffer.byteLength(direct) <= LONGEST_SOCKET_PATH ? direct : `/proc/${pid}/fd/${fd}/view.sock`;
}
export async function privateFolder(root, prefix = 'browser-view-') {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('The folder for the browser view is not a plain directory.');
  const directory = await fs.mkdtemp(path.join(root, `${prefix}${process.pid}-`));
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    await fs.rm(directory, { recursive: true, force: true });
    throw new Error('The private folder for the browser view could not be made private.');
  }
  const handle = await fs.open(directory, 'r');
  return {
    directory,
    socketPath: socketPathFor(directory, handle.fd),
    socketFile: path.join(directory, 'view.sock'),
    async close() {
      await handle.close().catch(() => {});
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
// A server that is killed cannot remove its folder. The next one removes
// those whose process is gone: only plain folders of this account named
// <prefix><pid>-XXXXXX.
export async function removeAbandonedFolders(root, prefix) {
  const pattern = new RegExp(`^${prefix.replace(/[^A-Za-z0-9_]/g, c => `\\${c}`)}(\\d+)-[A-Za-z0-9]{6}$`);
  const removed = [];
  for (const name of await fs.readdir(root).catch(() => [])) {
    const match = pattern.exec(name);
    if (!match) continue;
    try { process.kill(Number(match[1]), 0); continue; }
    catch (error) { if (error.code !== 'ESRCH') continue; }
    const target = path.join(root, name);
    try {
      const stat = await fs.lstat(target);
      if (!stat.isDirectory() || stat.uid !== process.getuid()) continue;
      await fs.rm(target, { recursive: true, force: true });
      removed.push(name);
    } catch { /* another server removed it */ }
  }
  return removed;
}

// --- Checks on the running server -------------------------------------------

// TCP sockets that process pid is listening on, from /proc: the server is
// started with no TCP port, and is stopped if it opens one anyway.
export async function tcpListeningSockets(pid, { readdir = fs.readdir, readlink = fs.readlink, readFile = fs.readFile } = {}) {
  const inodes = new Set();
  for (const name of await readdir(`/proc/${pid}/fd`).catch(() => [])) {
    const target = await readlink(`/proc/${pid}/fd/${name}`).catch(() => '');
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (match) inodes.add(match[1]);
  }
  const found = [];
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await readFile(table, 'utf8').catch(() => '');
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      // Field 3 is the state (0A is LISTEN), field 9 the socket's inode.
      if (fields.length > 9 && fields[3] === '0A' && inodes.has(fields[9])) found.push(fields[1]);
    }
  }
  return found;
}

// The socket must be a socket of this account that nobody else can open.
async function privateSocket(file) {
  try {
    const stat = await fs.lstat(file);
    return stat.isSocket() && stat.uid === process.getuid() && !(stat.mode & 0o077);
  } catch { return false; }
}

// --- Arguments -----------------------------------------------------------------

export function serverArguments({ display, socketPath, passwordFile }) {
  return [
    '-display', display,
    // No TCP port at all; the Unix socket alone, for this account only.
    '-rfbport=-1', '-rfbunixpath', socketPath, '-rfbunixmode', '0600', '-localhost=1',
    '-SecurityTypes', 'VncAuth', '-PasswordFile', passwordFile,
    '-desktop', VIEW_TITLE,
    // One viewer at a time: while it is connected, other connections are refused.
    '-NeverShared=1', '-DisconnectClients=0',
    '-AcceptSetDesktopSize=0', '-QueryConnect=0',
    // A server left behind (ToolsEngine killed) ends once no viewer is connected.
    '-MaxDisconnectionTime=30',
    '-Log', '*:stderr:30',
  ];
}
export function viewerArguments({ socketPath, passwordFile, viewOnly = false }) {
  return [
    '-PasswordFile', passwordFile, '-SecurityTypes', 'VncAuth',
    `-ViewOnly=${viewOnly ? 1 : 0}`,
    // The clipboard is not shared in either direction: what the person
    // copies elsewhere does not reach the browser, and the reverse.
    '-SendClipboard=0', '-AcceptClipboard=0', '-SendPrimary=0', '-SetPrimary=0',
    '-Shared=0', '-RemoteResize=0', '-FullScreen=0',
    // When the connection ends, the viewer exits instead of asking.
    '-ReconnectOnError=0', '-AlertOnFatalError=0',
    '-Log', '*:stderr:30',
    socketPath,
  ];
}

// What the two programs write when the viewer has connected and authenticated,
// and when it was refused. Either program's log may say it first.
// Both are written only after the password was accepted and the first
// screen description was exchanged.
const CONNECTED = /Server default pixel format|Using pixel format/;
const REFUSED = /[Aa]uthentication fail|AuthFailure|[Cc]onnection refused|Can't open display|cannot open display/;

// Stop a program this module started, by its own process number: SIGTERM,
// then SIGKILL. A program that never started (no process number) has
// nothing to stop, and no wait is unbounded.
export async function stopChild(child, graceMs = 3000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), delay(graceMs).then(() => false)])) return;
  child.kill('SIGKILL');
  await Promise.race([exited, delay(graceMs)]);
}
const running = child => Boolean(child?.pid) && child.exitCode === null && child.signalCode === null;
const tail = text => String(text || '').trim().split('\n').slice(-3).join(' ').replace(/\s+/g, ' ').slice(0, 400);

// --- The view ------------------------------------------------------------

// privateDisplay: async () => ({ display, xauthority }), the display the
//   browser is on, with the browser running there when it returns.
// personDisplay: () => ({ display, xauthority, wayland }), the person's own.
// runtimeRoot: where the private folder is made.
// programs: { server, viewer, env } to use instead of looking them up (tests).
export function createBrowserView({
  privateDisplay, personDisplay, runtimeRoot, programs, programRoot,
  spawnProgram = spawn, findPrograms = findViewPrograms, listeners = tcpListeningSockets,
  connectTimeoutMs = 15000, settleMs = 500, now = () => new Date(),
} = {}) {
  let current = null;
  let lastHidden = null;
  let closed = false;
  // Counts release(): a showing that was starting when the browser closed
  // must not then appear, showing a display the browser has left.
  let generation = 0;
  let found;
  let chain = Promise.resolve();
  const serialize = operation => { const next = chain.then(operation, operation); chain = next.catch(() => {}); return next; };
  const state = () => current
    ? { visible: true, viewOnly: current.viewOnly, since: current.since, personDisplay: current.personDisplay }
    : { visible: false, lastHidden };

  // Stop one showing: the viewer first (so it shows no error about a server
  // that went away), then the server, then the folder.
  const end = async (entry, reason) => {
    if (entry.ended) return entry.ended;
    entry.ended = (async () => {
      if (current === entry) { current = null; lastHidden = { reason, at: now().toISOString() }; }
      await stopChild(entry.viewer);
      await stopChild(entry.server);
      await entry.folder?.close();
    })();
    return entry.ended;
  };

  const start = async ({ viewOnly, signal }) => {
    const begun = generation;
    const person = personDisplayFrom(personDisplay());
    const tools = programs || (found ||= programRoot ? await viewProgramsFromRuntime(programRoot) : await findPrograms());
    if (!tools.server || !tools.viewer) {
      found = undefined; // installed later: look again next time
      const missing = !tools.server && !tools.viewer ? 'Neither is' : !tools.server ? 'The scraping server is not' : 'The viewer is not';
      throw new Error(`${VIEW_INSTALL} ${missing} installed in ${TRUSTED_PROGRAM_FOLDERS.join(', ')}. ${NOTHING_SHOWN} Installing software is the person's decision.`);
    }
    if (signal?.aborted) throw new Error(`The request was cancelled. ${NOTHING_SHOWN}`);
    const target = await privateDisplay({ signal });
    if (!target?.display || !target?.xauthority) throw new Error(`The browser's private display is not available. ${NOTHING_SHOWN}`);
    if (LOCAL_DISPLAY.test(person.display) && displayNumber(person.display) === displayNumber(target.display))
      throw new Error(`The person's display and the browser's private display are the same display. ${NOTHING_SHOWN}`);
    const entry = { viewOnly, since: now().toISOString(), personDisplay: person.display, log: { server: '', viewer: '' } };
    try {
      entry.folder = await privateFolder(runtimeRoot);
      const passwordFile = path.join(entry.folder.directory, 'passwd');
      await fs.writeFile(passwordFile, obfuscateVncPassword(randomVncPassword()), { mode: 0o600, flag: 'wx' });
      // Both programs get a small environment of their own: a private home
      // (so neither reads or writes the person's settings or history), and
      // only the display each one needs.
      const base = { PATH: '/usr/bin:/bin', HOME: entry.folder.directory, LANG: process.env.LANG || 'C.UTF-8', ...(tools.env || {}) };
      const collect = (child, key) => child.stderr?.on('data', data => { entry.log[key] = (entry.log[key] + data).slice(-8000); });
      entry.server = spawnProgram(tools.server, serverArguments({ display: target.display, socketPath: entry.folder.socketPath, passwordFile }),
        { env: { ...base, DISPLAY: target.display, XAUTHORITY: target.xauthority }, stdio: ['ignore', 'ignore', 'pipe'] });
      collect(entry.server, 'server');
      const serverExited = new Promise(resolve => entry.server.once('exit', resolve));
      entry.server.once('error', error => { entry.log.server += `\n${error.message}`; });
      const deadline = Date.now() + connectTimeoutMs;
      while (!await privateSocket(entry.folder.socketFile)) {
        if (!running(entry.server)) throw new Error(`The view server stopped before it listened: ${tail(entry.log.server) || 'no reason given'}. ${NOTHING_SHOWN}`);
        if (Date.now() > deadline || signal?.aborted) throw new Error(`The view server did not open its private socket. ${NOTHING_SHOWN}`);
        await delay(50);
      }
      const network = await listeners(entry.server.pid);
      if (network.length) throw new Error(`The view server opened a network port (${network.join(', ')}) although it was started without one; it was stopped. ${NOTHING_SHOWN}`);
      entry.viewer = spawnProgram(tools.viewer, viewerArguments({ socketPath: entry.folder.socketPath, passwordFile, viewOnly }),
        { env: { ...base, DISPLAY: person.display, ...(person.xauthority ? { XAUTHORITY: person.xauthority } : {}) }, stdio: ['ignore', 'ignore', 'pipe'] });
      collect(entry.viewer, 'viewer');
      entry.viewer.once('error', error => { entry.log.viewer += `\n${error.message}`; });
      for (;;) {
        const logs = `${entry.log.server}\n${entry.log.viewer}`;
        if (REFUSED.test(logs)) throw new Error(`The viewer could not connect: ${tail(entry.log.viewer) || tail(entry.log.server)}. ${NOTHING_SHOWN}`);
        if (CONNECTED.test(logs)) break;
        if (!running(entry.viewer)) throw new Error(`The viewer stopped before it showed the browser: ${tail(entry.log.viewer) || 'no reason given'}. ${NOTHING_SHOWN}`);
        if (!running(entry.server)) throw new Error(`The view server stopped: ${tail(entry.log.server) || 'no reason given'}. ${NOTHING_SHOWN}`);
        if (Date.now() > deadline) throw new Error(`The viewer did not connect within ${Math.round(connectTimeoutMs / 1000)} seconds. ${NOTHING_SHOWN}`);
        if (signal?.aborted) throw new Error(`The request was cancelled. ${NOTHING_SHOWN}`);
        await delay(50);
      }
      // A viewer that cannot open its window exits right after connecting.
      await delay(settleMs);
      if (!running(entry.viewer) || !running(entry.server)) throw new Error(`The viewer window closed at once: ${tail(entry.log.viewer) || tail(entry.log.server) || 'no reason given'}. ${NOTHING_SHOWN}`);
      if (closed) throw new Error(`ToolsEngine is shutting down. ${NOTHING_SHOWN}`);
      if (generation !== begun) throw new Error(`The browser closed while it was being shown. ${NOTHING_SHOWN}`);
      current = entry;
      // The person closing the window ends the viewer: the browser is hidden.
      entry.viewer.once('exit', () => { end(entry, 'window-closed').catch(() => {}); });
      serverExited.then(() => { end(entry, 'view-server-stopped').catch(() => {}); });
      return state();
    } catch (error) {
      await end(entry, 'show-failed').catch(() => {});
      throw error;
    }
  };

  return {
    state,
    show: ({ viewOnly = false, signal } = {}) => serialize(async () => {
      if (closed) throw new Error(`ToolsEngine is shutting down. ${NOTHING_SHOWN}`);
      if (current) {
        if (running(current.viewer) && running(current.server) && current.viewOnly === viewOnly) return state();
        await end(current, current.viewOnly === viewOnly ? 'view-server-stopped' : 'shown-again');
      }
      return start({ viewOnly, signal });
    }),
    hide: (reason = 'browser.hide') => serialize(async () => {
      if (current) await end(current, reason);
      return state();
    }),
    // For the browser closing or ToolsEngine stopping: ends a showing at
    // once, without waiting for a browser.show that may itself be waiting
    // for the browser being closed. A showing that is still starting then
    // finds the browser gone and fails on its own.
    release: (reason) => { generation++; return current ? end(current, reason) : Promise.resolve(); },
    // For tests and status: the process numbers of a showing.
    processes: () => current ? { server: current.server?.pid, viewer: current.viewer?.pid, folder: current.folder?.directory } : null,
    close: async () => { closed = true; if (current) await end(current, 'server-closed'); },
  };
}

// --- Tools -----------------------------------------------------------------

const SCHEMA = (properties = {}) => ({ type: 'object', properties, additionalProperties: false });
const hints = (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) => ({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });

// The three tools, for a browser called subject ("ToolsEngine's hidden
// browser", "the hidden Firefox window").
export function browserViewTools(view, { subject = 'ToolsEngine\'s hidden browser' } = {}) {
  const named = (name, operation) => async (args, context) => {
    try { return await operation(args, context); }
    catch (error) { error.message = `${name}: ${error.message}`; throw error; }
  };
  return [
    {
      name: 'browser.show', title: 'Show the browser to the person',
      description: `Open a window on the person's screen that shows ${subject} live: the same tabs, pages, cookies and sign-ins the browser tools act in. Nothing is restarted or reloaded. The person can watch and, unless viewOnly is true, click and type in it; their input reaches the same pages the browser tools act on, so take a fresh browser.snapshot before acting. Use it when the person asks to see or use the browser, for example to sign in or answer a check. The window is a local TigerVNC viewer connected over a private, password-protected Unix socket; no network port is opened and the clipboard is not shared. The person can close it; browser.hide closes it too. Starts the browser if it is not running. Needs Linux with an X11 or XWayland display and TigerVNC. Returns whether it is shown.`,
      inputSchema: SCHEMA({ viewOnly: { type: 'boolean', default: false, description: 'Show the browser without letting the person\'s mouse and keyboard reach it.' } }),
      annotations: { title: 'Show the browser to the person', ...hints(false, false, true, false) },
      handler: named('browser.show', ({ viewOnly = false } = {}, { signal } = {}) => view.show({ viewOnly, signal })),
    },
    {
      name: 'browser.hide', title: 'Hide the browser again',
      description: `Close the window that browser.show opened on the person's screen. ${subject[0].toUpperCase()}${subject.slice(1)} keeps running hidden with the same tabs, pages, cookies and sign-ins, and the browser tools go on acting in it. Does nothing when it is not shown. Returns whether it is shown.`,
      inputSchema: SCHEMA(),
      annotations: { title: 'Hide the browser again', ...hints(false, false, true, false) },
      handler: named('browser.hide', () => view.hide('browser.hide')),
    },
    {
      name: 'browser.visibility', title: 'Is the browser shown',
      description: `Report whether ${subject} is shown on the person's screen now (browser.show), with how it was last hidden: browser.hide, the person closing the window, the browser closing, or ToolsEngine stopping. Changes nothing and starts nothing.`,
      inputSchema: SCHEMA(),
      annotations: { title: 'Is the browser shown', ...hints(true, false, true, false) },
      handler: named('browser.visibility', async () => view.state()),
    },
  ];
}

export const VIEW_INSTRUCTIONS = 'browser.show opens a window on the person\'s screen that shows this same browser live, and the person can click and type in it; browser.hide closes that window, and browser.visibility says whether it is open. The browser keeps running hidden either way, with the same pages and sign-ins. Show it only when the person asks to see or use the browser, for example to sign in or to answer a check, and hide it when they are done or ask. While it is shown the person\'s input reaches the same pages: take a fresh browser.snapshot before acting.';
