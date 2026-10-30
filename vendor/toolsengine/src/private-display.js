// A private X display for ToolsEngine's own Chromium (--private-display).
//
// The browser runs headed, with real windows, on an Xvfb that nobody sees:
// nothing appears on the person's screen, nothing takes their focus, and the
// browser tools work as they do headless. browser.show can then show that
// display to the person (browser-view.js).
//
// The display is private by construction:
//   - a new random cookie (MIT-MAGIC-COOKIE-1) in a file only this account can
//     read; a client without it is refused;
//   - no TCP listener (-nolisten tcp) and no abstract socket (-nolisten local),
//     only the ordinary socket file;
//   - a display number that is not the person's, and that no other X server
//     holds;
//   - it ends by itself once its last client has gone (-terminate), so it does
//     not outlive the browser if ToolsEngine is killed.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { TRUSTED_PROGRAM_FOLDERS, displayNumber, stopChild } from './browser-view.js';

// Wide enough for Chromium's window around the default 1280x720 page.
export const PRIVATE_SCREEN = Object.freeze({ width: 1300, height: 820 });
// Chromium options for this display: X11 only (never the person's Wayland
// compositor), its window at the top left, and no sound on the person's
// speakers, as a headless browser makes none.
export const PRIVATE_DISPLAY_BROWSER_ARGS = Object.freeze(['--ozone-platform=x11', '--window-position=0,0', '--mute-audio']);
// Display numbers tried, highest first, away from the low numbers desktops use
// and from the range the hidden Firefox takes (97 down to 81).
export const DISPLAY_NUMBERS = Object.freeze(Array.from({ length: 80 }, (_, index) => 199 - index));

export function trustedProgram(names, { folders = TRUSTED_PROGRAM_FOLDERS, exists = existsSync } = {}) {
  for (const folder of folders) for (const name of names) {
    const file = path.join(folder, name);
    if (exists(file)) return file;
  }
  return null;
}

// One Xauthority entry: family "wild" (any address), the display number, the
// cookie. This is what xauth writes, without passing the cookie through
// another program.
export function xauthorityEntry(number, cookie) {
  const field = value => { const length = Buffer.alloc(2); length.writeUInt16BE(value.length); return Buffer.concat([length, value]); };
  const family = Buffer.alloc(2); family.writeUInt16BE(0xffff);
  return Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.from(String(number))), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]);
}

// Wait until Xvfb writes its display number to fd 3, which it does once it
// accepts connections; or until it exits.
function readiness(child, timeoutMs) {
  return new Promise(resolve => {
    let stderr = '';
    child.stderr?.on('data', data => { stderr = (stderr + data).slice(-2000); });
    const timer = setTimeout(() => finish({ ready: false, error: 'it did not start in time' }), timeoutMs);
    const finish = outcome => { clearTimeout(timer); resolve(outcome); };
    child.stdio?.[3]?.on('data', data => { if (/\d/.test(String(data))) finish({ ready: true }); });
    child.once('exit', code => finish({ ready: false, error: (stderr.trim().split('\n').filter(line => /Fatal|already active|error/i.test(line)).pop() || `exit ${code}`).slice(0, 300) }));
    child.once('error', error => finish({ ready: false, error: error.message }));
  });
}

// directory: a private folder (0700) for the cookie file.
// visibleDisplay: the person's display, whose number is never taken.
export async function startPrivateDisplay({
  directory, visibleDisplay, screen = PRIVATE_SCREEN, xvfb, numbers = DISPLAY_NUMBERS,
  spawnProgram = spawn, exists = existsSync, timeoutMs = 10000,
} = {}) {
  const program = xvfb || trustedProgram(['Xvfb'], { exists });
  if (!program) throw new Error('--private-display needs Xvfb (on Debian and Ubuntu, the package xvfb). The browser was not started; no visible display was used.');
  const avoid = displayNumber(visibleDisplay);
  let lastError = '';
  for (const number of numbers) {
    if (String(number) === avoid || exists(`/tmp/.X11-unix/X${number}`) || exists(`/tmp/.X${number}-lock`)) continue;
    const xauthority = path.join(directory, `xauthority-${number}`);
    await fs.rm(xauthority, { force: true });
    await fs.writeFile(xauthority, xauthorityEntry(number, randomBytes(16)), { mode: 0o600, flag: 'wx' });
    const child = spawnProgram(program, [`:${number}`, '-screen', '0', `${screen.width}x${screen.height}x24`,
      '-nolisten', 'tcp', '-nolisten', 'local', '-auth', xauthority, '-terminate', '-displayfd', '3'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    const outcome = await readiness(child, timeoutMs);
    if (outcome.ready) {
      const display = `:${number}`;
      return {
        display, xauthority, pid: child.pid,
        alive: () => Boolean(child.pid) && child.exitCode === null && child.signalCode === null,
        async close() { await stopChild(child); await fs.rm(xauthority, { force: true }); },
      };
    }
    await stopChild(child);
    await fs.rm(xauthority, { force: true });
    lastError = outcome.error;
  }
  throw new Error(`A private display for the browser could not be started${lastError ? ` (${lastError})` : ''}. The browser was not started; no visible display was used.`);
}

// The browser's environment on that display: its DISPLAY and cookie, and none
// of the person's Wayland compositor or session bus. Without the bus, a page
// cannot raise a desktop notification on the person's screen, and the browser
// does not reach their keyring or portals.
export function privateDisplayEnvironment(env, { display, xauthority }) {
  const result = { ...env, DISPLAY: display, XAUTHORITY: xauthority, DBUS_SESSION_BUS_ADDRESS: 'disabled:' };
  delete result.WAYLAND_DISPLAY;
  return result;
}
