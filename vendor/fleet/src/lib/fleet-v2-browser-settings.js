'use strict';
const path = require('node:path');
const CHROME_TRANSFER_SETTING = 'browser.agent_chrome_session_transfer';
// Registration environment for the separate ToolsEngine MCP. Both runtimes
// read this same sparse Fleet values file on the next call. Default true only
// enables the capability; ToolsEngine still requires per-transfer user approval.
function toolsEngineMcpEnvironment(config) {
  if (config?.profile !== 'fleetV2' || config.setupKind === 'plugin' || typeof config.stateRoot !== 'string' || !path.isAbsolute(config.stateRoot))
    throw Object.assign(new Error('The browser settings bridge requires an explicit standalone FleetV2 state root.'), { code: 'FLEET_BROWSER_SETTINGS_INVALID' });
  return Object.freeze({ TOOLSENABLED_SETTINGS: path.join(config.stateRoot, 'services', 'settings.json') });
}
module.exports = { CHROME_TRANSFER_SETTING, toolsEngineMcpEnvironment };
