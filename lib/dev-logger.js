/**
 * Dev-only request logger for LLM traffic (--dev launches).
 *
 * Enabled when the app is launched with --dev; writes each LLM request/response
 * cycle to <userData>/logs/llm-dev.log and mirrors it to stdout. Credential
 * header values are masked before anything hits disk: first 5 + asterisks +
 * last 5 chars (short values fully masked) — the log file must never carry a
 * usable API key.
 *
 * Disabled builds (npm start / packaged) are zero-IO: logLlmCall returns
 * without touching the filesystem.
 */

const fs = require('fs');
const path = require('path');

const REDACTED_HEADER_NAMES = new Set(['authorization', 'x-api-key', 'api-key', 'token']);

/**
 * Mask a credential value: first 5 + middle asterisks + last 5 in plaintext.
 * Values no longer than 10 chars are fully masked (their 5+5 windows overlap).
 */
function maskSecret(value) {
  if (typeof value !== 'string' || !value) return value;
  if (value.length <= 10) return '*'.repeat(value.length);
  return value.slice(0, 5) + '*'.repeat(value.length - 10) + value.slice(-5);
}

/** Mask credential header values, leave other headers untouched. */
function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (REDACTED_HEADER_NAMES.has(String(name).toLowerCase()) && typeof value === 'string' && value.length > 0) {
      // Keep the auth scheme prefix ("Bearer ") readable, mask only the token
      const sp = value.indexOf(' ');
      out[name] = sp > 0
        ? value.slice(0, sp + 1) + maskSecret(value.slice(sp + 1))
        : maskSecret(value);
    } else {
      out[name] = value;
    }
  }
  return out;
}

function createDevLogger({ enabled, logPath }) {
  if (enabled && logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // Fresh file per launch: a dev session reads as one coherent transcript
    fs.writeFileSync(logPath, `# dev LLM log — ${new Date().toISOString()}\n`);
  }

  return {
    isEnabled: () => Boolean(enabled && logPath),
    logPath: () => (enabled ? logPath : null),

    /**
     * Append one request cycle. Entry shape:
     * { url, headers, body, status, responseBody, error }
     * body/responseBody may be objects (pretty-printed) or strings (as-is).
     */
    logLlmCall(entry) {
      if (!this.isEnabled()) return;
      const lines = [`[${new Date().toISOString()}] LLM ${entry.error ? 'ERROR' : 'DONE'}`];
      lines.push(`  url: ${entry.url}`);
      lines.push(`  request.headers: ${JSON.stringify(redactHeaders(entry.headers))}`);
      lines.push(`  request.body: ${typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body, null, 2)}`);
      lines.push(`  response.status: ${entry.status ?? 'n/a'}`);
      lines.push(`  response.body: ${typeof entry.responseBody === 'string' ? entry.responseBody : JSON.stringify(entry.responseBody, null, 2)}`);
      if (entry.error) lines.push(`  error: ${entry.error}`);
      try {
        fs.appendFileSync(logPath, lines.join('\n') + '\n\n');
      } catch (e) {
        console.warn('[dev-log] 写入失败:', e.message);
      }
      console.log(lines.join('\n'));
    }
  };
}

/** True when the app was launched via `npm run dev` (electron . --dev). */
function isDevLaunch(argv) {
  return (argv || process.argv).includes('--dev');
}

module.exports = { createDevLogger, isDevLaunch, redactHeaders, maskSecret };
