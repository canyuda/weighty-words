/**
 * Lexicon editor state machine: word-level add/remove/edit over the FULL
 * words document (single-track — there is no builtin/overlay split anymore;
 * ~/.weighty-words/words.json is the one source the editor reads and writes).
 *
 * Undo (design D10): snapshot-based — every mutating operation deep-clones
 * the state BEFORE the change onto a bounded stack. undo() pops one step
 * back; an empty stack means the button greys out and the editor is back at
 * its baseline (dirty = false). The stack lives in memory only: save,
 * import, factory reset and external reload all clear it — saved states can
 * never be undone into.
 *
 * Invariants:
 *   - no redo (out of scope); undo steps straight back to the baseline
 *   - a word never sits in two categories' pending edits inconsistently —
 *     each mutation is validated BEFORE its snapshot is pushed, so a failed
 *     operation never pollutes history
 *
 * Environment-agnostic: CommonJS for tests, browser global for the editor page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const api = factory();
    root.LexiconEditorState = api;
    root.createEditorState = api.createEditorState;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const UNDO_LIMIT = 50;

  function clone(x) {
    return JSON.parse(JSON.stringify(x));
  }

  /** Tolerant normalize: trimmed, deduped lists; trimmed map keys. */
  function normalizeWords(raw) {
    const out = { fillers: [], hedges: [], vague: {}, emotions: {} };
    if (!raw || typeof raw !== 'object') return out;
    const asList = (v) => (Array.isArray(v)
      ? [...new Set(v.map((w) => String(w).trim()).filter(Boolean))]
      : []);
    out.fillers = asList(raw.fillers);
    out.hedges = asList(raw.hedges);
    for (const cat of ['vague', 'emotions']) {
      const src = raw[cat];
      if (src && typeof src === 'object' && !Array.isArray(src)) {
        for (const [w, def] of Object.entries(src)) {
          if (String(w).trim()) out[cat][String(w).trim()] = def;
        }
      }
    }
    return out;
  }

  function createEditorState({ words } = {}) {
    // Structure is validated upstream by the store; normalize absorbs
    // hand-edited drift (whitespace, duplicates) without dropping content.
    // _meta rides along untouched and is written back verbatim on save.
    let state = normalizeWords(words);
    if (words && words._meta && typeof words._meta === 'object') {
      state._meta = clone(words._meta);
    }
    let initial = clone(state);
    let undoStack = []; // snapshots of state BEFORE each mutation

    const pushUndo = () => {
      undoStack.push(clone(state));
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    };

    const exists = (cat, w) => {
      if (cat === 'vague' || cat === 'emotions') return state[cat][w] !== undefined;
      return state[cat].includes(w);
    };

    function removeWord(cat, w) {
      if (!exists(cat, w)) return { ok: false, error: `词条「${w}」不存在` };
      pushUndo();
      if (Array.isArray(state[cat])) {
        state[cat] = state[cat].filter((x) => x !== w);
      } else {
        delete state[cat][w];
      }
      return { ok: true };
    }

    return {
      /** 简单类目（填充词/犹豫词）新增 */
      addSimple(cat, w) {
        w = String(w || '').trim();
        if (!w) return { ok: false, error: '词条不能为空' };
        if (exists(cat, w)) return { ok: false, error: `「${w}」已在词表中` };
        pushUndo();
        state[cat].push(w);
        return { ok: true };
      },

      /** 情绪词新增（默认元数据） */
      addEmotion(w, info) {
        w = String(w || '').trim();
        if (!w) return { ok: false, error: '词条不能为空' };
        if (exists('emotions', w)) return { ok: false, error: `「${w}」已在词表中` };
        pushUndo();
        state.emotions[w] = info || { category: '自定义', polarity: 'neutral' };
        return { ok: true };
      },

      /** 通用移除（vague 用 removeVagueWord 亦可） */
      removeWord,

      /** 设置笼统词替代列表（词条须已存在） */
      setVagueAlts(w, alts) {
        w = String(w || '').trim();
        if (!w) return { ok: false, error: '词条不能为空' };
        if (!Array.isArray(alts) || alts.filter((x) => String(x).trim()).length === 0) {
          return { ok: false, error: '替代词不能为空' };
        }
        if (state.vague[w] === undefined) {
          return { ok: false, error: `词条「${w}」不存在，请先添加` };
        }
        pushUndo();
        state.vague[w] = alts.map((x) => String(x).trim()).filter(Boolean);
        return { ok: true };
      },

      removeVagueWord(w) {
        return removeWord('vague', w);
      },

      /** 新增笼统词（词条 + 替代列表） */
      addVague(w, alts) {
        w = String(w || '').trim();
        alts = Array.isArray(alts) ? alts.map((x) => String(x).trim()).filter(Boolean) : [];
        if (!w || !alts.length) return { ok: false, error: '需要笼统词与替代词' };
        if (exists('vague', w)) return { ok: false, error: `「${w}」已在词表中` };
        pushUndo();
        state.vague[w] = alts;
        return { ok: true };
      },

      /** 当前词表：simple 类目为数组，vague/emotions 为对象 */
      getEffective(cat) {
        return state[cat];
      },

      /** 是否可撤销（撤销按钮置灰依据） */
      canUndo() {
        return undoStack.length > 0;
      },

      /** 回退一步；无可撤销时 no-op 并返回失败 */
      undo() {
        if (!undoStack.length) return { ok: false, error: '没有可撤销的修改' };
        state = undoStack.pop();
        return { ok: true };
      },

      isDirty() {
        return JSON.stringify(state) !== JSON.stringify(initial);
      },

      /** 保存载荷：全量四表 + _meta 透传 */
      toWords() {
        return clone(state);
      },

      /** 保存/导入/恢复出厂/外部重载：以新状态为基准，撤销历史清空 */
      reset(newWords) {
        state = normalizeWords(newWords);
        if (newWords && newWords._meta && typeof newWords._meta === 'object') {
          state._meta = clone(newWords._meta);
        }
        initial = clone(state);
        undoStack = [];
      }
    };
  }

  return { createEditorState, UNDO_LIMIT };
});
