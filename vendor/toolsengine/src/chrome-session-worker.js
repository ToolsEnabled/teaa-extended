// The approved source connection and its relay live in this disposable thread.
import fs from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { configureBrowserEnvironment } from './config.js';
import { connectThroughExtension } from './browser.js';
import { captureChromeSession } from './chrome-session.js';
let browser, handle;
try {
  configureBrowserEnvironment();
  // Transfer needs the user's selected source tab. The extension token's
  // bypass path selects its connection page, not that signed-in source tab.
  // Require explicit selection in this disposable thread even when ordinary
  // --browser-extension calls were configured with a startup token.
  delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  process.env.PWTEST_SERVER_REGISTRY = workerData.registry;
  handle = process.platform === 'linux' ? await fs.open(workerData.registry, 'r') : undefined;
  process.env.PWTEST_SOCKETS_DIR = handle ? `/proc/${process.pid}/fd/${handle.fd}` : workerData.registry;
  browser = await connectThroughExtension({ channel: 'chrome', workspace: workerData.config.workspace });
  const state = await captureChromeSession(browser, workerData.origins);
  // Close disconnects this approved connection; Chrome and source tabs survive.
  await browser.close(); browser = undefined;
  parentPort.postMessage({ ok: true, state });
} catch (error) {
  const message = String(error.message);
  const failure = message.startsWith('Each requested origin') ? 'missing-tab'
    : /Extension not found|extension is installed/i.test(message) ? 'missing-extension'
      : /Unsupported IndexedDB|transfer (?:storage|record) limit/i.test(message) ? 'unsupported-storage'
        : /Unsupported command|Storage.getCookies/i.test(message) ? 'extension-api'
          : 'source-read';
  parentPort.postMessage({ ok: false, failure });
} finally { await browser?.close().catch(() => {}); await handle?.close(); }
