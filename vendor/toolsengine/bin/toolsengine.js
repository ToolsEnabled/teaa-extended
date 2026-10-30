#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseConfig, configureProcessTemp, configureBrowserEnvironment, VERSION } from '../src/config.js';

try {
  const config = await parseConfig(process.argv.slice(2));
  if (config.help) {
    console.log('ToolsEngine: --workspace ABSOLUTE_DIRECTORY [--headed|--headless] [--profile-dir ABSOLUTE_DEDICATED_PROFILE|--cdp-endpoint LOOPBACK_URL|--browser-extension|--firefox-hidden (Linux)|--chrome-hidden (Linux/Windows)] [--private-display (Linux)] [--browser-view-runtime ABSOLUTE_PREFIX] [--browser-executable PATH|--browser-channel CHANNEL] [--no-browser] [--no-browser-sandbox (unsafe: see README)] [--allow-local-network] [--desktop-profile-root WINDOWS_OWNER_PROFILE] [--desktop-left-half] [--desktop-allow-sign-in] [--tool-names dotted|underscore]');
  } else if (config.version) console.log(`ToolsEngine ${VERSION}`);
  else {
    process.chdir(config.workspace);
    // server.js imports the browser library even when browser tools are off.
    configureBrowserEnvironment();
    if (config.browser) await configureProcessTemp(config.workspace);
    const { createToolsEngine } = await import('../src/server.js');
    const engine = await createToolsEngine(config);
    const transport = new StdioServerTransport();
    let closing;
    const close = () => closing ||= engine.close();
    engine.server.onclose = () => { close().catch(error => { console.error(error.message); process.exitCode = 1; }); };
    await engine.server.connect(transport);
    process.stdin.once('end', () => { close().catch(error => { console.error(error.message); process.exitCode = 1; }); });
    const stop = () => close().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
} catch (error) {
  process.stderr.write(`ToolsEngine: ${String(error.message || error).slice(0, 2000)}\n`);
  process.exitCode = 1;
}
