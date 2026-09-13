/**
 * Realtime feedback scheduler: threshold-triggered feedback calls with
 *   - at most one in-flight request (triggers landing mid-flight coalesce
 *     into a pendingAfter re-fire),
 *   - a sliding context window (only the tail is sent),
 *   - a generation token: stop/reset invalidates in-flight responses.
 *
 * Environment-agnostic: CommonJS for tests/main, browser global for the
 * renderer (loaded via <script>).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const api = factory();
    root.ExpressionFeedbackScheduler = api;
    root.createFeedbackScheduler = api.createFeedbackScheduler; // 裸导出：app.js 直接调用
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function clampTriggerChars(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 30;
    return Math.min(200, Math.max(30, Math.round(v)));
  }

  function createFeedbackScheduler({ triggerChars = 30, windowChars = 500, send } = {}) {
    let threshold = clampTriggerChars(triggerChars);
    let fullText = '';
    let lastFedLen = 0;
    let gen = 0;
    let inFlight = false;
    let pendingAfter = false;

    const shouldFire = () => fullText.length - lastFedLen >= threshold;

    async function fire() {
      const myGen = gen;
      inFlight = true;
      const sentLen = fullText.length; // 发送时刻的长度（响应到达前可能继续积累）
      try {
        await send(fullText.slice(-windowChars), myGen);
        if (myGen === gen) lastFedLen = sentLen;
      } catch (_) {
        // send 错误由调用方包装层呈现（如失败提示）；不推进 lastFedLen，
        // 后续积累满阈值自然重试
      } finally {
        inFlight = false;
        if (myGen === gen) {
          if (pendingAfter && shouldFire()) {
            pendingAfter = false;
            fire();
          } else {
            pendingAfter = false;
          }
        }
      }
    }

    return {
      get triggerChars() {
        return threshold;
      },
      set triggerChars(v) {
        threshold = clampTriggerChars(v);
      },
      get generation() {
        return gen;
      },
      get inFlight() {
        return inFlight;
      },

      /** ASR final sentence: append and maybe fire. */
      onFinal(sentence) {
        fullText += sentence || '';
        if (inFlight) {
          if (shouldFire()) pendingAfter = true;
          return;
        }
        if (shouldFire()) fire();
      },

      /** Paste flow: replace state and fire once unconditionally. */
      paste(text) {
        this.reset();
        fullText = text || '';
        if (fullText.length > 0) fire();
      },

      /** New recording / clear all: reset accumulation, invalidate in-flight. */
      reset() {
        gen += 1;
        fullText = '';
        lastFedLen = 0;
        inFlight = false;
        pendingAfter = false;
      },

      /** Recording stopped: invalidate in-flight responses, keep accumulation. */
      stop() {
        gen += 1;
        inFlight = false;
        pendingAfter = false;
      }
    };
  }

  return { createFeedbackScheduler, clampTriggerChars };
});
