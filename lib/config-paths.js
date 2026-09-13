/**
 * User config directory (~/.weighty-words): the single home of user-owned
 * config files (settings.json / rules.json / words.json). Plain files by
 * design — transparent, backup-friendly, environment-portable (no
 * safeStorage context binding, so keys survive environment changes).
 *
 * Path resolution: EXPRESSION_TRAINER_CONFIG_DIR (automation/test isolation
 * hook, mirroring MODEL_DIR_OVERRIDE) > ~/.weighty-words. Pure path logic
 * lives here; ensureConfigDir does idempotent first-run creation, and every
 * write to these files goes through atomicWriteFileSync so a crash mid-write
 * can never leave a torn JSON file for users to trip over.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR_NAME = '.weighty-words';

// Recognized config file names — the only files ensureConfigDir manages.
const CONFIG_FILES = ['settings.json', 'rules.json', 'words.json'];

function getConfigDir() {
  if (process.env.EXPRESSION_TRAINER_CONFIG_DIR) {
    return process.env.EXPRESSION_TRAINER_CONFIG_DIR;
  }
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

function getSettingsPath() {
  return path.join(getConfigDir(), 'settings.json');
}

function getRulesPath() {
  return path.join(getConfigDir(), 'rules.json');
}

function getWordsPath() {
  return path.join(getConfigDir(), 'words.json');
}

/** Logs root: <configDir>/logs — rides the same resolution and test hook. */
function getLogsPath() {
  return path.join(getConfigDir(), 'logs');
}

/**
 * Write via temp file + rename in the same directory so rename stays atomic
 * on all platforms.
 */
function atomicWriteFileSync(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, filePath);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* renamed away — nothing to clean */ }
  }
}

/**
 * First-run bootstrap: create the config dir (0700 on POSIX) and any missing
 * config file from `defaults` ({ 'settings.json': obj, ... }), files 0600 on
 * POSIX. Existing files are NEVER overwritten — hand edits and user data
 * outrank defaults. Returns the names of files it created.
 */
function ensureConfigDir({ defaults = {} } = {}) {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); } catch (_) { /* best effort on odd filesystems */ }
  }
  const created = [];
  for (const name of CONFIG_FILES) {
    const filePath = path.join(dir, name);
    if (fs.existsSync(filePath) || defaults[name] === undefined) continue;
    atomicWriteFileSync(filePath, JSON.stringify(defaults[name], null, 2));
    if (process.platform !== 'win32') {
      try { fs.chmodSync(filePath, 0o600); } catch (_) { /* best effort */ }
    }
    created.push(name);
  }
  return created;
}

module.exports = {
  CONFIG_DIR_NAME,
  CONFIG_FILES,
  getConfigDir,
  getSettingsPath,
  getRulesPath,
  getWordsPath,
  getLogsPath,
  atomicWriteFileSync,
  ensureConfigDir
};
