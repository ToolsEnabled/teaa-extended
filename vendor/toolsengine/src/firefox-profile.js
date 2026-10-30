// Manage only the dedicated browser profile. This module never reads the
// user's everyday Firefox profile, password database, or cookie database.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentFirefoxProfileDir, chooseAgentBrowserSession, bindBrowserActions } from './browser-session.js';

const MARKER = 'ToolsEngine dedicated Firefox profile v1\n';
const PREFS = [
  'user_pref("accessibility.force_disabled", -1);',
  'user_pref("browser.sessionstore.resume_from_crash", false);',
  'user_pref("browser.sessionstore.max_resumed_crashes", 0);',
  'user_pref("browser.sessionstore.resume_session_once", false);',
  'user_pref("browser.startup.page", 0);',
  'user_pref("browser.aboutwelcome.enabled", false);',
  // Dialogs stay in the hidden Firefox, on its private display, never on the
  // desktop portal or notifier (also set in native/firefox-desktop.py).
  'user_pref("widget.use-xdg-desktop-portal.file-picker", 0);',
  'user_pref("widget.use-xdg-desktop-portal.mime-handler", 0);',
  'user_pref("widget.use-xdg-desktop-portal.open-uri", 0);',
  'user_pref("widget.use-xdg-desktop-portal.settings", 0);',
  'user_pref("widget.use-xdg-desktop-portal.location", 0);',
  'user_pref("widget.use-xdg-desktop-portal.native-messaging", 0);',
  'user_pref("alerts.useSystemBackend", false);',
  'user_pref("print.prefer_system_dialog", false);',
  'user_pref("print.tab_modal.enabled", true);',
  'user_pref("network.protocol-handler.external-default", false);',
  'user_pref("browser.download.useDownloadDir", true);',
  'user_pref("browser.download.always_ask_before_handling_new_types", false);',
  'user_pref("browser.download.open_pdf_attachments_inline", true);',
];

export async function ensureAgentFirefoxProfile(profileDir) {
  const absolute = path.resolve(profileDir);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Firefox profile paths must be plain directories without links.');
  }
  const stat = await fs.stat(absolute);
  if (stat.uid !== process.getuid()) throw new Error('The dedicated Firefox profile belongs to another account.');
  const marker = path.join(absolute, '.toolsengine-agent-firefox');
  const entries = await fs.readdir(absolute);
  if (entries.length && !entries.includes('.toolsengine-agent-firefox')) throw new Error('Refusing a nonempty Firefox profile without a dedicated-profile marker.');
  await fs.chmod(absolute, 0o700);
  try { await fs.writeFile(marker, MARKER, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await fs.lstat(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid()) throw new Error('The dedicated Firefox marker is unsafe.');
    const value = await fs.readFile(marker, 'utf8');
    if (![MARKER, 'ToolsEngine agent Firefox profile v1\n'].includes(value)) throw new Error('Unrecognized dedicated Firefox profile marker.');
  }
  const prefs = path.join(absolute, 'user.js');
  let text = '';
  try {
    const info = await fs.lstat(prefs);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid()) throw new Error('The dedicated Firefox preferences are unsafe.');
    text = await fs.readFile(prefs, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (/user_pref\("security\.sandbox\.content\.level",\s*0\)/.test(text)) throw new Error('The dedicated Firefox profile disables its content sandbox. Restore its sandbox before using it.');
  const additions = PREFS.filter(line => !text.includes(line.split('"')[1]));
  if (additions.length) await fs.writeFile(prefs, text + '\n' + additions.join('\n') + '\n', { mode: 0o600 });
  return absolute;
}

export async function startAgentBrowser(options = {}) {
  const session = chooseAgentBrowserSession(options);
  const profileDir = await ensureAgentFirefoxProfile(options.agentProfileDir || agentFirefoxProfileDir(options.home || os.homedir()));
  return { session, agentProfileDir: profileDir, binding: bindBrowserActions(session, undefined, profileDir), importedUserProfile: false };
}
