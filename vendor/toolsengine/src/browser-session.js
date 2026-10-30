// The Firefox mode uses an owned private display and a dedicated profile.
// No VM or session on the person's visible screen is selected implicitly.
import os from 'node:os';
import path from 'node:path';

export const AGENT_BROWSER_ACTIONS = Object.freeze([
  'browser.windows', 'browser.snapshot', 'browser.tabs', 'browser.navigate',
  'browser.navigate_back', 'browser.click', 'browser.type', 'browser.select_option',
  'browser.file_upload', 'browser.press_key', 'browser.take_screenshot',
  'browser.transfer_firefox_profile',
]);

const displayNumber = value => /^:(\d+)(?:\.\d+)?$/.exec(String(value || ''))?.[1];
export function chooseAgentBrowserSession(input = {}) {
  if (input.hiddenWindow === false || input.hiddenWindow?.available === false)
    throw new Error('Hidden Firefox is unavailable; no virtual-machine backend is configured.');
  const display = typeof input.hiddenWindow?.display === 'string' ? input.hiddenWindow.display : 'hidden';
  const visibleDisplay = input.visibleDisplay ?? null;
  if (display === 'visible' || display === visibleDisplay || displayNumber(display) && displayNumber(display) === displayNumber(visibleDisplay))
    throw new Error('The hidden window display must not be the user visible display.');
  return Object.freeze({target:'hidden-window', display, window:'hidden', usesVisibleScreen:false,
    selectedVisibleDisplay:null, selectedVisibleWindow:null,
    rejectedVisibleDisplay:visibleDisplay, rejectedVisibleWindow:input.visibleWindow ?? null});
}

export function bindBrowserActions(session, actions = AGENT_BROWSER_ACTIONS, profileDir = null) {
  if (!session || session.usesVisibleScreen !== false || session.target !== 'hidden-window' || session.display === 'visible')
    throw new Error('Refusing to bind Firefox actions outside the private hidden window.');
  return Object.freeze(actions.map(name => Object.freeze({name, target:session.target,
    display:session.display, window:session.window, profile:profileDir, usesVisibleScreen:false})));
}

export function agentFirefoxProfileDir(root = os.homedir()) {
  return path.join(root, '.local', 'share', 'toolsengine', 'agent-firefox');
}

export function agentBrowserStatus(config = {}) {
  const session = chooseAgentBrowserSession({...config, visibleDisplay: config.visibleDisplay ?? process.env.DISPLAY ?? null});
  return {browserEnabled:true, browserMode:'firefox-desktop', browserSession:session.target,
    browserLaunchState:'not-probed', headless:false, browserWindowMode:session.target,
    browserWindowVisibility:'hidden', browserAuthSharing:'dedicated-profile-only',
    browserSandbox:true, browserSandboxVerified:false, browserConnectionVerified:false,
    browserAuthenticationVerified:false, browserUsesVisibleScreen:false,
    browserRejectedVisibleDisplay:session.rejectedVisibleDisplay,
    browserRejectedVisibleWindow:session.rejectedVisibleWindow};
}

export function agentFirefoxInstructions() {
  return 'The Firefox tools operate in a private hidden display with a dedicated profile on this computer. They do not attach to the person\'s visible Firefox or automatically inherit its sign-ins. Standalone MCP offers explicit local profile transfer only when the user requests it; fleet settings can disable it. The OpenAI plugin entry offers no browser or credential-transfer tools. Sign-ins and copied credentials in the dedicated profile may remain between sessions. A virtual-machine backend is not configured; failure to create the private display is reported. Firefox\'s own sandbox stays enabled. Read a fresh browser.snapshot after an action. References expire after 90 seconds and after actions. An uncertain result must be checked before retrying an action that could submit twice. Screenshots and page observations can contain private information; password fields are omitted, but other secrets are not reliably detected. The client must enforce task authority and approval.';
}

export function agentBrowserHelperEnv(session, baseEnv, profileDir) {
  const env = {...baseEnv};
  env.TOOLSENGINE_BROWSER_TARGET = session.target;
  env.TOOLSENGINE_BROWSER_DISPLAY = session.display;
  env.TOOLSENGINE_VISIBLE_DISPLAY = baseEnv.DISPLAY || baseEnv.TOOLSENGINE_VISIBLE_DISPLAY || '';
  env.TOOLSENGINE_FIREFOX_PROFILE = profileDir;
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  delete env.XAUTHORITY;
  return env;
}
