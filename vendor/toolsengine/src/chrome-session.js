// Session transfer uses the browser-owned API, never encrypted profile files.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { chromeSessionEnvironment } from './config.js';
import { loadFleetSettings } from './firefox-profile-transfer.js';

export const CHROME_TRANSFER_SETTING = 'browser.agent_chrome_session_transfer';
export const CHROME_TRANSFER_ERROR = 'Chrome session transfer failed. No credential values are returned. Check the approved source connection and supported storage; inspect the hidden browser before retrying.';
export function chromeTransferAllowed(settings = {}) {
  const values = settings?.values || settings;
  return !Object.hasOwn(values, CHROME_TRANSFER_SETTING) || [true, 1, 'true', '1', 'on', 'enabled', 'allow'].includes(values[CHROME_TRANSFER_SETTING]);
}
export function transferOrigins(values) {
  if (!Array.isArray(values) || !values.length || values.length > 20) throw new Error('Name 1 through 20 HTTP(S) site origins explicitly.');
  return [...new Set(values.map(value => {
    let url;
    try { url = new URL(value); } catch { throw new Error('Transfer requires HTTP(S) origins without paths, credentials or queries.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('Transfer requires HTTP(S) origins without paths, credentials or queries.');
    return url.origin;
  }))];
}
// This function runs only in an existing source page. No source tab is opened,
// navigated, focused or closed. IndexedDB values outside JSON fail closed.
export async function collectPageSession() {
  const local = [], session = [], databases = [];
  let remaining = 16 * 1024 * 1024, recordLimit = 10000;
  const charge = value => { remaining -= value.length * 2; if (remaining < 0) throw new Error('Chrome transfer storage limit exceeded.'); return value; };
  const entries = storage => Array.from({ length: storage.length }, (_, i) => {
    const name = storage.key(i); return { name: charge(name), value: charge(storage.getItem(name)) };
  });
  const jsonValue = (value, ancestors = new Set()) => {
    if (typeof value === 'string') return charge(value);
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) { remaining -= 8; if (remaining < 0) throw new Error('Chrome transfer storage limit exceeded.'); return value; }
    if (!value || typeof value !== 'object' || ancestors.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype))
      throw new Error('Unsupported IndexedDB value.');
    ancestors.add(value);
    const result = Array.isArray(value) ? value.map(item => jsonValue(item, ancestors))
      : Object.fromEntries(Object.keys(value).map(key => [charge(key), jsonValue(value[key], ancestors)]));
    ancestors.delete(value); return result;
  };
  local.push(...entries(localStorage)); session.push(...entries(sessionStorage));
  if (!indexedDB.databases) throw new Error('IndexedDB enumeration unavailable.');
  const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(new Error('IndexedDB read failed.')); });
  for (const info of await indexedDB.databases()) {
    if (!info.name) continue;
    const opening = indexedDB.open(info.name);
    // A database removed after enumeration must never be created as a side effect.
    opening.onupgradeneeded = () => opening.transaction.abort();
    const db = await request(opening);
    try {
      const stores = [];
      if (db.objectStoreNames.length) {
        const tx = db.transaction([...db.objectStoreNames], 'readonly');
        const completed = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(new Error('IndexedDB transaction failed.')); });
        completed.catch(() => {}); // Abort can precede the aggregate rejection.
        // Cursors bound memory and record count; getAll could materialize an
        // unrelated, enormous site database before an export limit is checked.
        const reading = [...db.objectStoreNames].map(name => new Promise((resolve, reject) => {
          const store = tx.objectStore(name);
          const info = {
            name, autoIncrement: store.autoIncrement, ...(typeof store.keyPath === 'string' ? { keyPath: store.keyPath } : Array.isArray(store.keyPath) ? { keyPathArray: store.keyPath } : {}),
            indexes: [...store.indexNames].map(name => { const index = store.index(name); return { name, ...(typeof index.keyPath === 'string' ? { keyPath: index.keyPath } : { keyPathArray: index.keyPath }), multiEntry: index.multiEntry, unique: index.unique }; }),
            records: [],
          };
          const cursor = store.openCursor();
          cursor.onerror = () => reject(new Error('IndexedDB read failed.'));
          cursor.onsuccess = () => {
            if (!cursor.result) { resolve(info); return; }
            try {
              if (--recordLimit < 0) throw new Error('Chrome transfer record limit exceeded.');
              info.records.push({ ...(store.keyPath === null ? { key: jsonValue(cursor.result.key) } : {}), value: jsonValue(cursor.result.value) });
              cursor.result.continue();
            } catch (error) { reject(error); tx.abort(); }
          };
        }));
        stores.push(...await Promise.all(reading)); await completed;
      }
      databases.push({ name: db.name, version: db.version, stores });
    } finally { db.close(); }
  }
  return { origin: location.origin, localStorage: local, indexedDB: databases, sessionStorage: session };
}
export async function captureChromeSession(browser, origins) {
  const context = browser.contexts()[0];
  if (!context) throw new Error(CHROME_TRANSFER_ERROR);
  const states = [];
  for (const origin of transferOrigins(origins)) {
    const page = context.pages().find(page => { try { return new URL(page.url()).origin === origin; } catch { return false; } });
    if (!page) throw new Error('Each requested origin must already have a shared, open Chrome tab. No source tab was opened.');
    const state = await page.evaluate(collectPageSession);
    if (state.origin !== origin) throw new Error(CHROME_TRANSFER_ERROR);
    states.push(state);
    if (Buffer.byteLength(JSON.stringify(states)) > 16 * 1024 * 1024) throw new Error(CHROME_TRANSFER_ERROR);
  }
  // Browser APIs enumerate context cookies. Filter by origin domain/scheme,
  // retaining every path (cookies(origin + '/') would silently omit /app).
  const urls = transferOrigins(origins).map(origin => new URL(origin));
  const cookies = (await context.cookies()).filter(cookie => urls.some(url => {
    const domain = cookie.domain?.replace(/^\./, '');
    return domain && (url.hostname === domain || cookie.domain.startsWith('.') && url.hostname.endsWith('.' + domain))
      && (!cookie.secure || url.protocol === 'https:');
  }));
  const state = { cookies, origins: states.map(({ sessionStorage, ...state }) => state),
    sessionStorage: states.map(({ origin, sessionStorage }) => ({ origin, entries: sessionStorage })) };
  if (Buffer.byteLength(JSON.stringify(state)) > 16 * 1024 * 1024) throw new Error(CHROME_TRANSFER_ERROR);
  return state;
}
export async function readApprovedChromeSession(config, origins, { signal, workerFactory = (data, options) => new Worker(new URL('./chrome-session-worker.js', import.meta.url), { ...options, workerData: data }) } = {}) {
  const settings = await loadFleetSettings(config);
  if (!chromeTransferAllowed(settings)) throw new Error('Fleet settings disable Chrome session transfer. No source connection was opened.');
  transferOrigins(origins);
  if (signal?.aborted) throw new Error('Chrome transfer cancelled before source access.');
  const runtime = path.join(config.workspace, '.toolsengine-runtime');
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(runtime)).isDirectory() || (await fs.lstat(runtime)).isSymbolicLink()) throw new Error(CHROME_TRANSFER_ERROR);
  const registry = await fs.mkdtemp(path.join(runtime, 'chrome-transfer-'));
  let worker;
  try {
    return await new Promise((resolve, reject) => {
      worker = workerFactory({ config: { workspace: config.workspace }, origins, registry }, { env: chromeSessionEnvironment(), stdout: true, stderr: true });
      worker.stdout.resume(); worker.stderr.resume(); // Never forward browser diagnostics.
      const timer = setTimeout(() => reject(new Error('Waiting for the person to approve Chrome session transfer. Approve the ToolsEngine connection, then request transfer again. No hidden session was changed.')), 60000);
      const abort = () => { done(); reject(new Error('Chrome transfer cancelled. No credential values are returned.')); };
      signal?.addEventListener('abort', abort, { once: true });
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      worker.on('message', message => {
        done();
        const failures = {
          'missing-tab': 'Each requested origin must already have a shared, open Chrome tab. No source tab was opened.',
          'missing-extension': "Install Microsoft's Playwright Extension in the source Chrome profile, then request transfer again: https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm . No hidden session was changed.",
          'unsupported-storage': 'Source site storage is unsupported or exceeds transfer limits. No hidden session was changed; see docs/hidden-chrome.md.',
          'extension-api': 'The source extension cannot read browser cookies. Update the Playwright Extension and choose an existing source tab. No hidden session was changed.',
        };
        message.ok ? resolve(message.state) : reject(new Error(failures[message.failure] || CHROME_TRANSFER_ERROR));
      });
      worker.once('error', () => { done(); reject(new Error(CHROME_TRANSFER_ERROR)); });
      worker.once('exit', () => { done(); reject(new Error(CHROME_TRANSFER_ERROR)); });
      if (signal?.aborted) abort();
    });
  } finally {
    await worker?.terminate();
    await fs.rm(registry, { recursive: true, force: true });
  }
}
export function sessionReceipt(state) {
  return { imported: true, sourceProfileCopied: false, sourcePagesNavigated: false, sourcePageInput: false, hiddenBrowserUsesVisibleScreen: false, sourceApprovalMayOpenPage: true,
    cookies: state.cookies.length, origins: state.origins.length,
    localStorageEntries: state.origins.reduce((n, origin) => n + origin.localStorage.length, 0),
    indexedDBDatabases: state.origins.reduce((n, origin) => n + origin.indexedDB.length, 0),
    sessionStorageEntries: state.sessionStorage.reduce((n, origin) => n + origin.entries.length, 0),
    sessionStorageLifetime: 'current-hidden-browser-session', authenticationVerified: false,
    excluded: ['saved-passwords', 'passkeys', 'client-certificates', 'service-workers', 'cache-storage', 'origin-private-file-system'],
  };
}
