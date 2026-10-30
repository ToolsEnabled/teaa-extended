// Can the browser tests run on this machine?
//
// ToolsEngine starts its browser with Chromium's sandbox on, and does not
// start one without. On some systems the Chromium that Playwright downloads
// is not allowed to create its sandbox: Ubuntu 23.10 and later, for one. A
// plain "npm test" there used to fail every test that opens a page, with the
// reason four lines down in the README. Those tests are now skipped there,
// and each skip says why and which variable to set.
//
// This module starts the browser the tests would use once, the way the
// server would, and closes it again. Nothing is opened in it.
//
//   TOOLSENGINE_TEST_BROWSER=PATH   use this browser instead of Playwright's Chromium
//   TOOLSENGINE_TEST_NO_SANDBOX=1   run the browser tests with --no-browser-sandbox
import { chromium } from 'playwright';

const named = process.env.TOOLSENGINE_TEST_BROWSER || '';
const withoutSandbox = process.env.TOOLSENGINE_TEST_NO_SANDBOX === '1';

// The two sentences every skip reason is built from. tools/test-gate.js looks
// for the first words of each to tell a browser test that did not run from a
// test that is skipped for the system it is on.
export const NO_SANDBOX_HERE = 'The browser under test cannot set up its sandbox on this machine';
export const NO_BROWSER_HERE = 'The Chromium build this version is pinned to is not on this machine';
const SET = 'set TOOLSENGINE_TEST_BROWSER to the path of an installed Chrome or Edge (for example TOOLSENGINE_TEST_BROWSER=/opt/google/chrome/chrome)';

async function look() {
  const found = { missing: false, sandbox: false };
  let browser;
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: !withoutSandbox, ...(named ? { executablePath: named } : {}) });
  } catch (error) {
    const text = String(error?.message || error);
    if (!named && /Executable doesn't exist/i.test(text)) found.missing = true;
    else if (!withoutSandbox && /Chromium sandboxing failed|No usable sandbox|sandbox helper binary/i.test(text)) found.sandbox = true;
    // Anything else is for the tests themselves to show.
  } finally {
    await browser?.close().catch(() => {});
  }
  return found;
}
const found = await look();

const missing = `${NO_BROWSER_HERE}. To run the browser tests, ${SET}, or download the build with "npx playwright install chromium".`;
const sandbox = `${NO_SANDBOX_HERE} (${named || 'the Chromium that Playwright downloads'}), and ToolsEngine does not start a browser without one. To run the browser tests, ${SET}, or set TOOLSENGINE_TEST_NO_SANDBOX=1 to run them with --no-browser-sandbox.`;

// For a test in which the server starts the browser: false, or why it is skipped.
export const serverBrowserSkipped = found.missing ? missing : found.sandbox ? sandbox : false;
// For a test that starts a browser itself, without the sandbox, and attaches
// the server to it: only a missing browser stands in the way.
export const ownBrowserSkipped = found.missing ? missing : false;
