/**
 * ASR usage tracking: per-engine session totals + in-memory recent sessions.
 *
 * Duration is computed from PCM sample counts (16000 samples = 1 second) and
 * is an estimate aligned with streaming-billing. Data lives in a standalone
 * userData file (asr-usage.json), never in settings.json. A corrupt file
 * resets to empty instead of crashing.
 */

const fs = require('fs');

const RECENT_LIMIT = 20;

function emptyUsage() {
  return { engines: {}, recent: [] };
}

function createUsageTracker({ usagePath }) {
  let cached = null;

  const load = () => {
    if (cached) return cached;
    try {
      if (usagePath && fs.existsSync(usagePath)) {
        const raw = JSON.parse(fs.readFileSync(usagePath, 'utf-8'));
        if (raw && typeof raw === 'object' && raw.engines && Array.isArray(raw.recent)) {
          cached = raw;
          return cached;
        }
      }
    } catch (e) {
      console.warn('[usage] asr-usage.json 损坏，用量已重置:', e.message);
    }
    cached = emptyUsage();
    return cached;
  };

  const persist = () => {
    if (!usagePath) return;
    try {
      fs.writeFileSync(usagePath, JSON.stringify(cached, null, 2));
    } catch (e) {
      console.warn('[usage] 用量写入失败:', e.message);
    }
  };

  return {
    /** Record a finished session (user-ended or errored). */
    recordSession({ engine, seconds, endedAs, category }) {
      const data = load();
      const en = (data.engines[engine] = data.engines[engine] || {
        sessions: 0, seconds: 0, failures: 0, lastError: null
      });
      en.sessions += 1;
      en.seconds += Math.max(0, Math.round(seconds));
      if (endedAs === 'error') {
        en.failures += 1;
        en.lastError = { at: new Date().toISOString(), category: category || 'service' };
      }
      data.recent.unshift({
        at: new Date().toISOString(),
        engine,
        seconds: Math.round(seconds),
        endedAs: endedAs || 'user',
        category: category || null
      });
      if (data.recent.length > RECENT_LIMIT) data.recent.length = RECENT_LIMIT;
      persist();
    },

    /** Aggregated summary for the settings panel. */
    getSummary() {
      const data = load();
      return { engines: data.engines, recent: data.recent.slice(0, RECENT_LIMIT) };
    },

    /** Zero out everything (after user confirmation upstream). */
    reset() {
      cached = emptyUsage();
      persist();
    }
  };
}

module.exports = { createUsageTracker };
