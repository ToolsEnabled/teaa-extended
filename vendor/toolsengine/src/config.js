import { assertPluginProfile } from './plugin-policy.js';
import fs from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

// The version, read from package.json: the one place where it is written.
// The CLI, the handshake, system.status and the user agent of web.fetch all
// take it from here.
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// The folder this program runs from: bin, src, native and node_modules.
export const PROGRAM_FOLDER = fileURLToPath(new URL('..', import.meta.url));

// The assistant can write anywhere in the workspace. If the workspace held
// the program folder, workspace.write_file could rewrite the server's own
// code and the Windows helper. Standalone workspace tools now exclude the
// program itself, so an ancestor (including the user's home) is usable.
// A workspace inside the program and overlap in the strict plugin remain refused. The
// two arguments are real paths: links and short names are resolved by then.
//
// The paths are compared as text, and then by what the file system says each
// folder is. Text alone can be passed where one folder has two spellings
// that resolving does not bring together: a mount that ignores the case of
// letters (a Windows drive seen from Linux, a case-folding or FAT file
// system, a network share), or a second mount of the same folder. So each
// folder from the inner one up to the root is asked for its device and file
// number, and one that is the outer folder under another name counts.
async function folderIdentity(folder) {
  try {
    const stat = await fs.stat(folder, { bigint: true });
    if (stat.ino === 0n) throw new Error('Filesystem identity unavailable; browser/program separation cannot be proved.');
    return `${stat.dev}:${stat.ino}`;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function physicalChain(target, identify) {
  const rows = [], seen = new Set();
  let suffix = [], folder = path.resolve(target);
  for (;;) {
    const identity = await identify(folder);
    if (identity === null) {
      if (identify !== folderIdentity || path.dirname(folder) === folder || rows.length) throw new Error('Filesystem identity unavailable; separation cannot be proved.');
    } else {
      if (seen.has(identity)) throw new Error('Filesystem identity is ambiguous; separation cannot be proved.');
      seen.add(identity); rows.push({ identity, suffix: [...suffix] });
    }
    if (path.dirname(folder) === folder) break;
    suffix.unshift(path.basename(folder)); folder = path.dirname(folder);
  }
  return rows;
}
export async function folderContains(outer, inner, { identify = folderIdentity } = {}) {
  const relative = path.relative(outer, inner);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return true;
  const a = await physicalChain(outer, identify), b = await physicalChain(inner, identify);
  return a.some(left => b.some(right => left.identity === right.identity && left.suffix.length <= right.suffix.length && left.suffix.every((part,i) => part === right.suffix[i])));
}
export async function foldersOverlap(workspace, program, options = {}) {
  return await folderContains(workspace, program, options) || await folderContains(program, workspace, options);
}

// The browser library reads SELENIUM_REMOTE_URL by itself: with it, "start a
// browser" means "start one on that remote Selenium grid". That browser is
// on another machine, outside the sandbox setting, the profile and the
// temporary folder ToolsEngine arranges, while system.status would go on
// describing a local sandboxed one. A server that offers browser tools does
// not start with it.
export function refuseRemoteGrid(env = process.env) {
  if (!env.SELENIUM_REMOTE_URL) return;
  throw new Error('SELENIUM_REMOTE_URL is set in the environment ToolsEngine was started with. With that variable the browser library starts the browser on a remote Selenium grid instead of on this machine, outside the sandbox and the profile ToolsEngine arranges for its browser. Remove the variable from this server\'s environment, or start ToolsEngine with --no-browser.');
}

// The address of a browser that is already running and offers CDP: loopback
// only, http or ws, no credentials. Checked when the server starts and again
// by the browser bridge, for a caller that does not come through parseConfig.
export const CDP_ENDPOINT_REFUSAL = 'A CDP endpoint must be an explicitly configured loopback HTTP or WebSocket address.';
export function checkCdpEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); }
  catch { throw new Error(`${CDP_ENDPOINT_REFUSAL} Write the full address, for example http://127.0.0.1:9222.`); }
  if (!['http:', 'ws:'].includes(endpoint.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password)
    throw new Error(CDP_ENDPOINT_REFUSAL);
  return value;
}

async function plainDirectory(value, { create = false } = {}) {
  const absolute = path.resolve(value);
  const base = path.parse(absolute).root;
  if (process.platform === 'win32' && base.startsWith('\\\\')) throw new Error('Use a local directory, not a network share.');
  let current = base;
  for (const part of absolute.slice(base.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await fs.mkdir(current);
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Directory paths may not traverse links or junctions.');
  }
  return await fs.realpath(absolute);
}

// Sensitive state must never enter inherited Playwright protocol/file logs.
export function chromeSessionEnvironment(base = process.env) {
  const env = { ...base };
  for (const name of Object.keys(env))
    if (/^(?:DEBUG(?:_.*)?|PWDEBUG.*|PW.*(?:TRACE|DEBUG|LOG).*|PLAYWRIGHT.*(?:TRACE|DEBUG|LOG).*)$/i.test(name)) delete env[name];
  return env;
}

export async function parseConfig(args, { env = process.env } = {}) {
  const config = { headless: true, browser: true, browserSandbox: true, allowLocalNetwork: false };
  const values = new Map([
    ['--plugin-profile', 'pluginProfile'], ['--workspace', 'workspace'], ['--profile-dir', 'profileDir'],
    ['--browser-executable', 'browserExecutable'], ['--browser-channel', 'browserChannel'],
    ['--browser-view-runtime', 'browserViewRuntime'],
    ['--cdp-endpoint', 'cdpEndpoint'],
    ['--desktop-profile-root', 'desktopProfileRoot'], ['--tool-names', 'toolNames'],
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (values.has(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} requires a value.`);
      config[values.get(arg)] = args[++i];
    } else if (arg === '--headless') config.headless = true;
    else if (arg === '--headed') config.headless = false;
    else if (arg === '--no-browser') config.browser = false;
    else if (arg === '--no-browser-sandbox') config.browserSandbox = false;
    else if (arg === '--allow-local-network') config.allowLocalNetwork = true;
    else if (arg === '--desktop-left-half') config.desktopLeftHalf = true;
    else if (arg === '--desktop-allow-sign-in') config.desktopAllowSignIn = true;
    else if (arg === '--browser-extension') config.browserExtension = true;
    else if (arg === '--chrome-hidden') config.chromeHidden = true;
    else if (arg === '--firefox-desktop' || arg === '--firefox-hidden') config.firefoxDesktop = true;
    else if (arg === '--private-display') config.privateDisplay = true;
    else if (arg === '--help' || arg === '-h') config.help = true;
    else if (arg === '--version') config.version = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (config.help || config.version) return config;
  if (config.toolNames !== undefined && !['dotted', 'underscore'].includes(config.toolNames))
    throw new Error('--tool-names must be dotted or underscore.');
  assertPluginProfile(config);
  if (config.browserViewRuntime) {
    if (!config.browser || (!config.privateDisplay && !config.firefoxDesktop))
      throw new Error('--browser-view-runtime requires --private-display or --firefox-hidden.');
    config.browserViewRuntime = await plainDirectory(config.browserViewRuntime);
  }
  if (!config.browser && (config.profileDir || config.cdpEndpoint || config.browserExtension || config.browserExecutable || config.browserChannel || config.firefoxDesktop || config.privateDisplay || config.chromeHidden))
    throw new Error('--no-browser cannot be combined with browser configuration.');
  // --private-display runs ToolsEngine's own Chromium on a private X display
  // that nobody sees, so that browser.show can show it to the person and
  // browser.hide can hide it again (src/private-display.js, browser-view.js).
  if (config.privateDisplay) {
    if (process.platform !== 'linux') throw new Error('--private-display currently requires Linux with X11 (Xvfb). On this system the browser runs headless, or in a window with --headed.');
    if (config.firefoxDesktop) throw new Error('--firefox-hidden already runs Firefox on a private display and offers browser.show and browser.hide there; --private-display is for ToolsEngine\'s own Chromium. Choose one.');
    if (config.cdpEndpoint || config.browserExtension) throw new Error('--private-display applies only to a browser that ToolsEngine starts itself; a browser attached with --cdp-endpoint or --browser-extension keeps its own windows.');
    if (config.chromeHidden) throw new Error('--chrome-hidden runs Chrome headless with no display to show; --private-display is for ToolsEngine\'s own Chromium. Choose one.');
    if (config.headless === false) throw new Error('Choose --headed (the browser in a window on your own screen) or --private-display (hidden, shown on request with browser.show), not both.');
  }
  if (config.chromeHidden) {
    const quiet = chromeSessionEnvironment(env);
    for (const name of Object.keys(env)) if (!Object.hasOwn(quiet, name)) delete env[name];
    if (!['linux', 'win32'].includes(process.platform)) throw new Error('--chrome-hidden requires Linux or native Windows.');
    if (config.headless === false || config.firefoxDesktop || config.cdpEndpoint || config.browserExtension || config.browserExecutable || config.browserChannel || config.desktopProfileRoot || config.browserSandbox === false)
      throw new Error('Chrome hidden mode requires sandboxed headless Chrome and cannot attach to a visible browser or desktop.');
    config.headless = true;
    config.browserChannel = 'chrome';
    config.profileDir ||= process.platform === 'win32'
      ? path.join(userInfo().homedir, 'AppData', 'Local', 'ToolsEngine', 'agent-chrome')
      : path.join(userInfo().homedir, '.local', 'share', 'toolsengine', 'agent-chrome');
  }
  if (config.firefoxDesktop) {
    if (process.platform !== 'linux') throw new Error('--firefox-hidden currently requires Linux.');
    if (config.profileDir || config.cdpEndpoint || config.browserExtension || config.browserExecutable || config.browserChannel || config.desktopProfileRoot || config.browserSandbox === false)
      throw new Error('Firefox hidden mode cannot be combined with another browser mode, a desktop attachment, or a disabled sandbox.');
  }
  // The sandbox option is about a browser this server starts. With no browser,
  // or with one that is already running, it would only look like a setting.
  if (!config.browserSandbox && (!config.browser || config.cdpEndpoint || config.browserExtension))
    throw new Error('--no-browser-sandbox applies only to a browser that ToolsEngine starts itself; it has no meaning with --no-browser, --cdp-endpoint or --browser-extension.');
  // --browser-extension acts in the person's everyday Chrome or Edge, through the
  // Playwright Extension installed there. That browser is found by its channel
  // in its standard place, with its own default profiles: a separate
  // executable would not be the browser the person approves in.
  if (config.browserExtension) {
    if (config.profileDir || config.cdpEndpoint) throw new Error('Choose only one of --profile-dir, --cdp-endpoint or --browser-extension.');
    if (config.browserExecutable) throw new Error('--browser-extension uses the installed Chrome or Edge with its everyday profiles: choose it with --browser-channel chrome or --browser-channel msedge, not --browser-executable.');
    if (config.browserChannel && !['chrome', 'msedge'].includes(config.browserChannel)) throw new Error('--browser-extension works with --browser-channel chrome or msedge.');
  }
  // The two ways of naming the browser to start are alternatives. With both,
  // the channel's executable was used and the named file quietly ignored.
  if (config.browserExecutable && config.browserChannel) throw new Error('Choose only one of --browser-executable or --browser-channel.');
  if (config.browser) refuseRemoteGrid(env);
  if (!config.workspace || !path.isAbsolute(config.workspace)) throw new Error('--workspace must name an existing absolute directory.');
  try { config.workspace = await plainDirectory(config.workspace); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error(`--workspace must name an existing absolute directory. ${path.resolve(config.workspace)} does not exist: create the folder first, or name one that exists.`);
  }
  const program = await fs.realpath(PROGRAM_FOLDER);
  if (config.pluginProfile && await foldersOverlap(config.workspace, program))
    throw new Error('--workspace and the ToolsEngine program folder must not contain one another in a plugin profile. Choose a workspace folder outside it.');
  if (await folderContains(program, config.workspace))
    throw new Error('--workspace must not be the ToolsEngine program folder or a folder inside it. Its parent is supported for standalone MCP; program files remain excluded from workspace tools.');
  if (config.desktopLeftHalf && !config.desktopProfileRoot) throw new Error('--desktop-left-half requires --desktop-profile-root.');
  if (config.desktopAllowSignIn && !config.desktopProfileRoot) throw new Error('--desktop-allow-sign-in requires --desktop-profile-root.');
  if (config.desktopProfileRoot) {
    if (process.platform !== 'win32') throw new Error('--desktop-profile-root requires Windows. Linux supports browser, workspace and web capabilities.');
    if (!path.isAbsolute(config.desktopProfileRoot)) throw new Error('--desktop-profile-root must be absolute.');
    if (path.resolve(config.desktopProfileRoot).toLowerCase() !== path.resolve(userInfo().homedir).toLowerCase()) throw new Error('--desktop-profile-root must equal the current process account profile.');
    config.desktopProfileRoot = await plainDirectory(config.desktopProfileRoot);
  }
  if (config.profileDir && config.cdpEndpoint)
    throw new Error('Choose only one of --profile-dir or --cdp-endpoint.');
  // A browser attached at startup is already running: the options that
  // choose or start one would be accepted for nothing. The address is checked
  // here so that a malformed one is refused with the reason, not with the
  // URL parser's "Invalid URL".
  if (config.cdpEndpoint) {
    if (config.browserExecutable || config.browserChannel || config.headless === false)
      throw new Error('--cdp-endpoint attaches to a browser that is already running: --browser-executable, --browser-channel and --headed have no effect on it.');
    checkCdpEndpoint(config.cdpEndpoint);
  }
  // The browser named by its path is looked for here, at startup, as the one
  // named by its channel is: a wrong path used to be accepted, the client
  // showed the server as connected with all its tools, and the mistake came
  // out on the first browser call as the dependency's own text.
  if (config.browserExecutable) config.browserExecutable = await browserExecutableFile(config.browserExecutable);
  if (config.profileDir) {
    if (!path.isAbsolute(config.profileDir)) throw new Error('--profile-dir must be absolute. Use a dedicated ToolsEngine profile, not an ordinary browser profile.');
    // Checked on the path as given before anything is created, so that a
    // refused folder leaves nothing behind, and again on the real path once
    // it exists, in case links lead elsewhere.
    const intended = path.resolve(config.profileDir);
    if (await folderContains(intended, config.workspace)) throw new Error('The browser profile must not equal or contain the workspace.');
    await validateBrowserLayout(config.workspace, intended);
    config.profileDir = await plainDirectory(config.profileDir, { create: true });
    if (process.platform !== 'win32') await fs.chmod(config.profileDir, 0o700);
    if (await folderContains(config.profileDir, config.workspace)) throw new Error('The browser profile must not equal or contain the workspace.');
    await validateBrowserLayout(config.workspace, config.profileDir);
    const marker = path.join(config.profileDir, '.toolsengine-profile');
    const entries = await fs.readdir(config.profileDir);
    if (entries.length === 0) await fs.writeFile(marker, 'ToolsEngine dedicated profile v1\n', { flag: 'wx', mode: 0o600 });
    else {
      const stat = await fs.lstat(marker).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 100 || await fs.readFile(marker, 'utf8') !== 'ToolsEngine dedicated profile v1\n')
        throw new Error('Profile directory is not a dedicated ToolsEngine profile. Choose a new empty directory.');
    }
  }
  return config;
}

export async function validateBrowserLayout(workspace, profileDir) {
  if (!profileDir) return;
  if (await folderContains(profileDir, workspace)) throw new Error('The browser profile must not equal or contain the workspace.');
  for (const reserved of [path.join(workspace, 'artifacts', 'toolsengine'), path.join(workspace, '.toolsengine-runtime')]) {
    if (await foldersOverlap(profileDir, reserved)) throw new Error('The browser profile must not overlap the implicit artifacts or runtime folder.');
  }
}

export function configureBrowserEnvironment({ env = process.env, platform = process.platform, profile = userInfo().homedir } = {}) {
  for (const name of Object.keys(env)) if (/^(?:(?:npm_config_|npm_package_config_)?(?:PLAYWRIGHT_BROWSERS_PATH|PWDEBUG)|DEBUG_FILE|PWTEST_UNDER_TEST)$/i.test(name)) delete env[name];
  // The extension connection reads these by itself: they would choose another
  // browser, profile or executable than the one the person approves in, or
  // change its protocol or wait. PLAYWRIGHT_MCP_EXTENSION_TOKEN is kept: it is
  // the person's own choice to connect without approving each time, and
  // system.status reports it.
  for (const name of Object.keys(env)) if (/^(?:PLAYWRIGHT_MCP_(?:BROWSER|EXECUTABLE_PATH|PROFILE_DIR_NAME)|PWTEST_EXTENSION_(?:USER_DATA_DIR|PROTOCOL|CONNECT_TIMEOUT))$/i.test(name)) delete env[name];
  const p = platform === 'win32' ? path.win32 : path.posix;
  env.PLAYWRIGHT_BROWSERS_PATH = platform === 'win32' ? p.join(profile,'AppData','Local','ms-playwright') : platform === 'darwin' ? p.join(profile,'Library','Caches','ms-playwright') : p.join(profile,'.cache','ms-playwright');
  if (platform === 'win32') {
    for (const name of Object.keys(env)) if (/^(LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|HOMEDRIVE)$/i.test(name)) delete env[name];
    env.LOCALAPPDATA = p.join(profile,'AppData','Local'); env.PROGRAMFILES = 'C:\\Program Files'; env['PROGRAMFILES(X86)'] = 'C:\\Program Files (x86)'; env.HOMEDRIVE = 'C:';
  }
}
// The program that --browser-executable names: an absolute path to a file
// that exists. The message names the path as given, and the ways out: the
// path corrected where the server is registered, or an installed Chrome or
// Edge by its channel.
export async function browserExecutableFile(given, { stat = fs.stat } = {}) {
  const ways = 'Give the full path of the browser program, or name an installed Google Chrome or Microsoft Edge with --browser-channel chrome or --browser-channel msedge. If the path came from a client registration (claude mcp add, codex mcp add), correct it there.';
  if (!path.isAbsolute(given)) throw new Error(`--browser-executable must be an absolute path; ${given} is not. ${ways}`);
  let found;
  try { found = await stat(given); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw new Error(`--browser-executable names ${given}, which does not exist. ${ways}`);
    throw new Error(`--browser-executable names ${given}, which could not be read (${error?.code || error?.message || error}). ${ways}`);
  }
  if (!found.isFile()) throw new Error(`--browser-executable names ${given}, which is not a file. ${ways}`);
  return given;
}

export function channelExecutable(channel, { platform = process.platform, profile = userInfo().homedir, exists = existsSync } = {}) {
  if (!['chrome','msedge'].includes(channel)) throw new Error('Use --browser-executable for browser channels other than chrome or msedge.');
  const name = channel === 'chrome' ? 'Google/Chrome/Application/chrome.exe' : 'Microsoft/Edge/Application/msedge.exe';
  const candidates = platform === 'win32' ? ['C:\\Program Files','C:\\Program Files (x86)',path.win32.join(profile,'AppData','Local')].map(root => path.win32.join(root,...name.split('/')))
    : platform === 'linux' ? [channel === 'chrome' ? '/opt/google/chrome/chrome' : '/opt/microsoft/msedge/msedge']
    : [channel === 'chrome' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  const selected = candidates.find(exists);
  if (!selected) throw new Error('The selected browser was not found in trusted account/system locations. Give its explicit executable path.');
  return selected;
}

export async function configureProcessTemp(workspace) {
  const temp = await plainDirectory(path.join(workspace, '.toolsengine-runtime', 'tmp'), { create: true });
  // The CLI establishes this before importing Playwright. Elevated launchers
  // may carry another account's TEMP; never use it for browser state.
  process.env.TEMP = temp;
  process.env.TMP = temp;
  process.env.TMPDIR = temp;
  return temp;
}
