/**
 * Unified application logger — the single home of all file logging.
 *
 * Single writer = main process (renderer logs arrive via the console-message
 * forwarder in main.js). Five levels (trace/debug/info/warn/error, default
 * info), one line per entry:
 *
 *   2026-09-13 21:04:05.123 [INFO] [llm] ← 200 bytes=1234 durationMs=2300
 *
 * Daily files `app-YYYYMMDD-<seq>.log` under <configDir>/logs/ (resolved by
 * lib/config-paths.js, so EXPRESSION_TRAINER_CONFIG_DIR isolates them for
 * automation). A volume rolls over when its estimated size exceeds ~200MB
 * (startup statSync once + in-memory accumulation — estimate by design) and
 * files older than 30 days are pruned at startup and on day rollover, based
 * on the date embedded in the file name (mtime-immune).
 *
 * Every entry is mirrored to stdout: `npm start` keeps its one-terminal
 * two-process view and e2e scripts keep grepping [tag]s.
 *
 * Redaction is two-layered: INFO entries carry metadata only (no secrets by
 * construction); DEBUG payloads go through header redaction (redactHeaders)
 * plus key-name scrubbing (scrubForLog) — maskSecret keeps the first 5 and
 * last 5 chars, fully masks values ≤10. By policy user speech transcripts
 * and LLM request/response bodies are DEBUG-only (never at default INFO).
 *
 * Write failures degrade to stdout-only after a single console.error — the
 * one sanctioned swallow-and-continue in this app: the logger must never
 * take the application down.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
const DEFAULT_LEVEL = 'info';
const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024; // ~200MB, estimate by design
const DEFAULT_RETENTION_DAYS = 30;
const LOG_NAME_RE = /^app-(\d{8})-(\d+)\.log$/;

// Header names whose values must never hit the log in plaintext.
const REDACTED_HEADER_NAMES = new Set(['authorization', 'x-api-key', 'api-key', 'token']);
// Object key names scrubbed recursively wherever a payload is logged.
const REDACT_KEY_NAMES = new Set(['apikey', 'api_key', 'token', 'secret', 'password', 'authorization']);

/**
 * Mask a credential value: first 5 + middle asterisks + last 5 in plaintext.
 * Values no longer than 10 chars are fully masked (their 5+5 windows overlap).
 */
function maskSecret(value) {
  if (typeof value !== 'string' || !value) return value;
  if (value.length <= 10) return '*'.repeat(value.length);
  return value.slice(0, 5) + '*'.repeat(value.length - 10) + value.slice(-5);
}

/** Mask a credential, keeping any leading scheme prefix ("Bearer ") readable. */
function maskCredentialValue(value) {
  const sp = value.indexOf(' ');
  return sp > 0 ? value.slice(0, sp + 1) + maskSecret(value.slice(sp + 1)) : maskSecret(value);
}

/** Mask credential header values, leave other headers untouched. */
function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (REDACTED_HEADER_NAMES.has(String(name).toLowerCase()) && typeof value === 'string' && value.length > 0) {
      out[name] = maskCredentialValue(value);
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** Recursive key-name scrubber: masks values under credential-ish keys. */
function scrubForLog(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => scrubForLog(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (REDACT_KEY_NAMES.has(String(k).toLowerCase()) && v !== null && typeof v !== 'object') {
        // Non-string credential values get stringified first so they can't sneak through
        out[k] = typeof v === 'string' ? maskCredentialValue(v) : maskSecret(JSON.stringify(v));
      } else {
        out[k] = scrubForLog(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** Force anything onto one line: newlines become a visible ⏎ marker. */
function singleLine(text) {
  return String(text).replace(/\r?\n/g, ' ⏎ ');
}

/** Error → single-line "message | frame | frame" (message + up to 3 frames). */
function formatStack(err) {
  const raw = err && err.stack ? String(err.stack) : String(err && err.message ? err.message : err);
  return singleLine(raw.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 4).join(' | '));
}

/** Compact, scrubbed, single-line JSON — the DEBUG payload shape. */
function compactJson(value) {
  try {
    return JSON.stringify(scrubForLog(value));
  } catch (_) {
    return '"[unserializable]"';
  }
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/** Local wall-clock timestamp, what a human reading the file expects. */
function formatLocalTimestamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Local date as YYYYMMDD — matches the log file name stamp. */
function dateStamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function normalizeLevel(value) {
  const key = String(value || '').toLowerCase();
  return LEVELS[key] !== undefined ? key : DEFAULT_LEVEL;
}

function formatMetaValue(v) {
  if (v instanceof Error) return formatStack(v);
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v;
  if (v && typeof v === 'object') return compactJson(v);
  return String(v);
}

function formatLine({ now, level, tag, message, meta }) {
  let line = `${formatLocalTimestamp(now)} [${level.toUpperCase()}] [${tag}] ${singleLine(message)}`;
  if (meta && typeof meta === 'object') {
    const parts = [];
    for (const [k, v] of Object.entries(meta)) {
      if (v === undefined) continue;
      parts.push(`${k}=${formatMetaValue(v)}`);
    }
    if (parts.length) line += ' ' + parts.join(' ');
  }
  return line;
}

/**
 * Factory. `clock` is injectable for rollover/retention tests; `logsDir`
 * null means stdout-only (the default instance before main.js configures it).
 */
function createLogger({
  level = DEFAULT_LEVEL,
  logsDir = null,
  clock = () => new Date(),
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  retentionDays = DEFAULT_RETENTION_DAYS
} = {}) {
  let currentLevel = normalizeLevel(level);
  // day/seq/bytes describe the active volume; file is its cached full path
  const state = { day: null, seq: 1, bytes: 0, file: null, degraded: false };

  function enabledFor(lv) {
    return LEVELS[lv] >= LEVELS[currentLevel];
  }

  function ensureDir() {
    fs.mkdirSync(logsDir, { recursive: true });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(logsDir, 0o700); } catch (_) { /* best effort on odd filesystems */ }
    }
  }

  /** Delete app-*.log files whose name date is older than retentionDays. */
  function pruneExpired(now) {
    let names;
    try { names = fs.readdirSync(logsDir); } catch (_) { return; }
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    for (const name of names) {
      const m = LOG_NAME_RE.exec(name);
      if (!m) continue;
      const fileDay = Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8));
      if (today - fileDay > retentionDays * 86400000) {
        try { fs.unlinkSync(path.join(logsDir, name)); } catch (_) { /* best effort */ }
      }
    }
  }

  /**
   * Same-day restart keeps one coherent timeline: adopt today's newest
   * volume and seed `bytes` from its real size so the 200MB estimate stays
   * honest across restarts. A full volume leads to the next sequence.
   */
  function adoptTodayVolume() {
    let maxSeq = 0;
    let maxBytes = 0;
    try {
      for (const name of fs.readdirSync(logsDir)) {
        const m = new RegExp(`^app-${state.day}-(\\d+)\\.log$`).exec(name);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        if (n >= maxSeq) {
          maxSeq = n;
          try { maxBytes = fs.statSync(path.join(logsDir, name)).size; } catch (_) { maxBytes = 0; }
        }
      }
    } catch (_) { /* dir missing — ensureDir creates it below */ }
    if (maxSeq > 0) {
      if (maxBytes >= maxFileBytes) {
        state.seq = maxSeq + 1;
        state.bytes = 0;
      } else {
        state.seq = maxSeq;
        state.bytes = maxBytes;
      }
    }
  }

  function updateFilePath() {
    state.file = path.join(logsDir, `app-${state.day}-${state.seq}.log`);
  }

  /** Day rollover (or first write): reset, adopt, create dir, prune. */
  function rollIfNeeded(now, incomingBytes) {
    const day = dateStamp(now);
    if (state.day !== day) {
      state.day = day;
      state.seq = 1;
      state.bytes = 0;
      ensureDir();
      adoptTodayVolume();
      pruneExpired(now);
      updateFilePath();
    } else if (state.bytes + incomingBytes > maxFileBytes) {
      // Estimate: this write would overflow the volume — start the next one
      state.seq += 1;
      state.bytes = 0;
      updateFilePath();
    }
  }

  function mirror(level, line) {
    if (level === 'warn' || level === 'error') console.error(line);
    else console.log(line);
  }

  function write(level, tag, message, meta) {
    if (!enabledFor(level)) return;
    const now = clock();
    const line = formatLine({ now, level, tag, message, meta });
    mirror(level, line);
    if (!logsDir || state.degraded) return;
    try {
      const payload = line + '\n';
      rollIfNeeded(now, Buffer.byteLength(payload));
      fs.appendFileSync(state.file, payload);
      state.bytes += Buffer.byteLength(payload);
    } catch (err) {
      // The one sanctioned swallow: logging must never take the app down
      state.degraded = true;
      console.error('[logger] 写入失败，已降级为仅终端输出:', err && err.message ? err.message : err);
    }
  }

  return {
    trace: (tag, message, meta) => write('trace', tag, message, meta),
    debug: (tag, message, meta) => write('debug', tag, message, meta),
    info: (tag, message, meta) => write('info', tag, message, meta),
    warn: (tag, message, meta) => write('warn', tag, message, meta),
    error: (tag, message, meta) => write('error', tag, message, meta),
    setLevel(value) {
      currentLevel = normalizeLevel(value);
    },
    getLevel: () => currentLevel,
    /**
     * main.js bootstrap: point the logger at the real logs dir and apply the
     * settings-driven level. `logsDir: null` reverts to stdout-only (tests
     * use this to reset the shared instance); `undefined` leaves it alone.
     * Any dir change resets volume state so the next write re-adopts there.
     */
    configure({ level: newLevel, logsDir: dir } = {}) {
      if (dir !== undefined) {
        logsDir = dir;
        state.day = null;
        state.seq = 1;
        state.bytes = 0;
        state.file = null;
        state.degraded = false;
      }
      if (newLevel !== undefined) currentLevel = normalizeLevel(newLevel);
    }
  };
}

// Default instance: stdout-only until main.js configures it in whenReady.
// lib modules require this directly — no injection point needed anymore.
const logger = createLogger();

module.exports = {
  LEVELS,
  DEFAULT_LEVEL,
  DEFAULT_MAX_FILE_BYTES,
  createLogger,
  logger,
  maskSecret,
  redactHeaders,
  scrubForLog
};
