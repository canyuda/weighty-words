/**
 * Feedback line classifier: maps one realtime-feedback line returned by the
 * LLM to a UI semantic type for coloring ('good' | 'filler' | 'hedge' |
 * 'vague' | 'ai').
 *
 * Word sets are caller-supplied merged lexicon lists (the renderer builds
 * them from get-lexicon-lists and rebuilds on lexicon-changed) — this module
 * embeds NO word content, keeping data/emotion-lexicon.json the single
 * builtin lexicon source.
 *
 * Environment-agnostic: CommonJS for tests, browser global for the renderer
 * (loaded via <script>).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const api = factory();
    root.ExpressionFeedbackClassifier = api;
    root.createFeedbackClassifier = api.createFeedbackClassifier; // 裸导出：app.js 直接调用
  }
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * @param {{fillers?: string[], hedges?: string[]}} lists merged lexicon lists
   * @returns {{classify: (text: string) => string}} classifier instance
   */
  function createFeedbackClassifier({ fillers = [], hedges = [] } = {}) {
    // Only 「」-quoted mentions count: feedback lines quote the word they coach
    const quotedFillers = fillers.map((w) => `「${w}」`);
    const quotedHedges = hedges.map((w) => `「${w}」`);

    return {
      classify(text) {
        if (!text) return 'ai';
        if (text.includes('✓')) return 'good';
        if (quotedFillers.some((q) => text.includes(q))) return 'filler';
        if (quotedHedges.some((q) => text.includes(q))) return 'hedge';
        if (text.includes('→')) return 'vague';
        return 'ai';
      }
    };
  }

  return { createFeedbackClassifier };
});
