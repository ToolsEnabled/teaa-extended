// Web navigation check for the Firefox bridge. Kept separate from browser.js
// so the Firefox session can load without starting Playwright.

export function checkBrowserUrl(value) {
  if (value === 'about:blank') return value;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Browser navigation requires an HTTP(S) URL without embedded credentials.');
  return url.href;
}
