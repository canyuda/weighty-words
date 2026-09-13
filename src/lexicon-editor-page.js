/**
 * 词库编辑器页面脚本（单窗口页面路由架构）。
 * 词库为全量模型：~/.weighty-words/words.json 四表即全部内容，编辑器
 * 直接增删改词条；撤销按钮逐步回退未保存修改（历史空则置灰）。
 * 布局：左侧分类锚点导航 + 右下角悬浮操作栏（撤销/保存/导入/导出/恢复出厂）。
 */
let lexState = null; // createEditorState 实例
let selfChange = false; // 编辑器自身保存/导入/恢复出厂引发的广播：不作为外部变更处理
const WARN_CLEAR_MS = 2500; // 分区提示自动消退时长（与全局 hintbar 节奏一致）
const warnTimers = {}; // 分区提示的消退定时器

const $lex = (id) => document.getElementById(id);

function showHint(text, isErr) {
  const el = $lex('hintbar');
  el.textContent = text;
  el.className = 'lex-hintbar ' + (isErr ? 'err' : 'ok');
  if (!isErr) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2500);
}

/** 重复词条等分区级提示：就近显示在分区标题旁，短暂展示后自动消退 */
function showSectionWarn(cat, text) {
  const el = $lex(`warn-${cat}`);
  if (!el) return showHint(text, true);
  el.textContent = text;
  clearTimeout(warnTimers[cat]);
  warnTimers[cat] = setTimeout(() => { el.textContent = ''; }, WARN_CLEAR_MS);
}

function chip(label, onRemove) {
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.title = '点击 × 删除词条（撤销可恢复）';
  const text = document.createElement('span');
  text.textContent = label;
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'chip-x';
  x.textContent = '×';
  x.addEventListener('click', () => { onRemove(); renderLex(); });
  chip.appendChild(text);
  chip.appendChild(x);
  return chip;
}

function renderChips(containerId, words, onRemove) {
  const box = $lex(containerId);
  box.innerHTML = '';
  words.forEach((w) => box.appendChild(chip(w, () => onRemove(w))));
}

function renderVague() {
  const box = $lex('vague-list');
  box.innerHTML = '';
  const v = lexState.getEffective('vague');
  Object.keys(v).forEach((w) => {
    const row = document.createElement('div');
    row.className = 'lex-vague-item';
    const word = document.createElement('span');
    word.className = 'lex-vague-word';
    word.textContent = w;
    const alts = document.createElement('span');
    alts.className = 'lex-vague-alts';
    alts.textContent = (v[w] || []).join('、');
    alts.title = '点击内联修改替代词';
    alts.addEventListener('click', () => startInlineEdit(row, w, v[w] || []));
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'lex-item-x';
    x.textContent = '×';
    x.title = `删除「${w}」`;
    x.setAttribute('aria-label', `删除笼统词${w}`);
    x.addEventListener('click', () => { lexState.removeVagueWord(w); renderLex(); });
    row.appendChild(word);
    row.appendChild(alts);
    row.appendChild(x);
    box.appendChild(row);
  });
}

/** 行内编辑：alts 展示态 → 输入态（Enter/blur 提交，Esc 取消） */
function startInlineEdit(row, w, current) {
  if (row.querySelector('input')) return;
  const altsSpan = row.querySelector('.lex-vague-alts');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'lex-vague-edit';
  input.value = current.join(',');
  altsSpan.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const list = input.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const r = lexState.setVagueAlts(w, list);
    if (!r.ok) showHint(r.error, true);
    renderLex();
  };
  const cancel = () => renderLex();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
}

function renderLex() {
  if (!lexState) return;
  renderChips('chips-fillers', lexState.getEffective('fillers'), (w) => lexState.removeWord('fillers', w));
  renderChips('chips-hedges', lexState.getEffective('hedges'), (w) => lexState.removeWord('hedges', w));
  renderChips('chips-emotions', Object.keys(lexState.getEffective('emotions')), (w) => lexState.removeWord('emotions', w));
  renderVague();
  // 区块计数徽标
  const counts = {
    'count-fillers': lexState.getEffective('fillers').length,
    'count-hedges': lexState.getEffective('hedges').length,
    'count-vague': Object.keys(lexState.getEffective('vague')).length,
    'count-emotions': Object.keys(lexState.getEffective('emotions')).length
  };
  for (const [id, n] of Object.entries(counts)) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(n);
  }
  // 撤销按钮：历史空 → 置灰（随每次渲染刷新）
  const undoBtn = $lex('btn-undo-lexicon');
  if (undoBtn) undoBtn.disabled = !lexState.canUndo();
  if (window.api.notifyEditorDirty) window.api.notifyEditorDirty(lexState.isDirty());
}

/** 添加词条：分区级错误（如重复）就近提示，不再挤页尾 hintbar */
function addWithSectionWarn(cat, result) {
  if (result && !result.ok) showSectionWarn(cat, result.error);
}

function bindAdd(inputId, cat, handler) {
  $lex(inputId).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addWithSectionWarn(cat, handler($lex(inputId).value));
    $lex(inputId).value = '';
    renderLex();
  });
}

/** 保存词库全量内容；返回是否成功（三选一确认「保存并离开」与退出编排共用） */
async function saveLexicon() {
  selfChange = true; // 必须在 await 前置位：广播可能在 reset 完成前到达
  const r = await window.api.saveLexiconWords(lexState.toWords());
  if (r.success) {
    showHint('✓ 已保存并生效');
    lexState.reset(lexState.toWords()); // 保存后基准前移，脏标记与撤销历史清空
    renderLex(); // 刷新置灰态（撤销）与芯片
    if (window.api.notifyEditorDirty) window.api.notifyEditorDirty(false);
    return true;
  }
  selfChange = false;
  showHint(r.error || '保存失败', true);
  return false;
}

/** 编辑器内导入：存在未保存修改时先确认（导入将覆盖本地修改） */
async function importLexicon() {
  if (lexState && lexState.isDirty()) {
    const go = await window.appConfirm('导入将覆盖当前未保存的修改。', { title: '导入词库', okText: '继续导入' });
    if (!go) return;
  }
  selfChange = true; // 本编辑器发起：随后的广播不算外部变更（下方已显式重载）
  const r = await window.api.lexiconImport();
  if (r.success) {
    await reloadLexicon();
    showHint('✓ 已导入并全局覆盖生效');
    return;
  }
  selfChange = false; // 导入被取消或失败：保持编辑现场
  if (!r.canceled) showHint(r.error || '导入失败', true);
}

async function exportLexicon() {
  const r = await window.api.lexiconExport();
  if (r.success) showHint('✓ 已导出 words.json');
  else if (!r.canceled) showHint(r.error || '导出失败', true);
}

/** 撤销一步未保存修改；随渲染刷新按钮置灰态 */
function undoLexicon() {
  if (!lexState) return;
  const r = lexState.undo();
  if (!r.ok) showHint(r.error, true);
  renderLex();
}

/** 外部变更（导入/恢复出厂）到达：无修改静默重载；有修改先询问。
 *  编辑器自身保存/导入/恢复出厂引发的广播不算外部变更（selfChange 标记跳过），
 *  否则会重建状态实例，与用户正在编辑的行产生竞态。 */
async function handleExternalChange() {
  if (selfChange) {
    selfChange = false;
    return;
  }
  if (lexState && lexState.isDirty()) {
    const keep = await window.appConfirm('词库已被外部修改（导入或恢复出厂），且本地有未保存修改。\n确定 = 放弃本地修改并重载；取消 = 保留本地修改（保存时将覆盖外部变更）。', { title: '词库已被外部修改', okText: '放弃并重载', cancelText: '保留本地修改', danger: true });
    if (keep) await reloadLexicon();
    return; // 保留本地修改：不重载
  }
  await reloadLexicon();
}

async function reloadLexicon() {
  const { words, error } = await window.api.getLexiconWords();
  lexState = window.LexiconEditorState.createEditorState({ words });
  window.__lexState = lexState; // 调试/测试探针
  if (error) showHint(error, true);
  renderLex();
}

// ===== 左侧分类锚点导航：点击定位 + 滚动高亮 =====

function initLexNav() {
  const nav = document.querySelector('.lex-nav');
  if (!nav) return;
  const items = [...nav.querySelectorAll('.nav-item')];
  items.forEach((item) => {
    item.addEventListener('click', () => {
      const section = document.getElementById(item.dataset.lexTarget);
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  // scroll-spy：以页面滚动容器为根，取最后一个与视口相交的分区为当前项
  const scrollRoot = document.getElementById('page-lexicon');
  const sections = items
    .map((item) => document.getElementById(item.dataset.lexTarget))
    .filter(Boolean);
  if (!('IntersectionObserver' in window) || !scrollRoot || !sections.length) return;
  const visible = new Set();
  const pickActive = () => {
    const last = sections.filter((s) => visible.has(s.id)).pop();
    if (!last) return;
    items.forEach((item) => item.classList.toggle('active', item.dataset.lexTarget === last.id));
  };
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) visible.add(en.target.id);
      else visible.delete(en.target.id);
    });
    pickActive();
  }, { root: scrollRoot, rootMargin: '-20% 0px -60% 0px', threshold: 0 });
  sections.forEach((s) => observer.observe(s));
}

function initLexiconEditorPage() {
  // 返回工作台由路由器统一绑定（btn-lexicon-back）
  $lex('btn-undo-lexicon').addEventListener('click', undoLexicon);
  $lex('btn-save-lexicon').addEventListener('click', saveLexicon);
  $lex('btn-import-lexicon').addEventListener('click', importLexicon);
  $lex('btn-export-lexicon').addEventListener('click', exportLexicon);
  $lex('btn-reset-lexicon').addEventListener('click', async () => {
    if (!(await window.appConfirm('恢复出厂词库？当前词库的全部自定义内容将被出厂词表覆盖（可先导出备份）。', { title: '恢复出厂词库', okText: '恢复出厂', danger: true }))) return;
    selfChange = true; // 必须在 await 前置位：广播可能在 invoke 返回前到达
    const r = await window.api.resetLexicon({ confirmed: true });
    if (r && r.error) {
      selfChange = false;
      showHint(r.error, true);
      return;
    }
    // 广播已被 selfChange 消费：显式重载为出厂词表（words.json 已被重写）
    await reloadLexicon();
    showHint('✓ 已恢复出厂词库');
  });

  bindAdd('add-filler', 'fillers', (v) => lexState && lexState.addSimple('fillers', v));
  bindAdd('add-hedge', 'hedges', (v) => lexState && lexState.addSimple('hedges', v));
  bindAdd('add-emotion', 'emotions', (v) => lexState && lexState.addEmotion(v));

  // 笼统词添加：词与替代词两个输入框回车均可提交
  const addVague = () => {
    if (!lexState) return;
    const r = lexState.addVague($lex('add-vague-word').value, $lex('add-vague-alts').value.split(/[,，]/));
    if (!r.ok) showSectionWarn('vague', r.error);
    else {
      $lex('add-vague-word').value = '';
      $lex('add-vague-alts').value = '';
    }
    renderLex();
  };
  $lex('add-vague-word').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addVague(); } });
  $lex('add-vague-alts').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addVague(); } });

  initLexNav();

  // 脏状态暴露给路由器（离开页面时三选一确认）+ 通知主进程（关闭应用时确认）
  window.__lexiconEditorDirty = () => !!(lexState && lexState.isDirty());
  // 保存出口：路由器「保存并离开」与主进程「保存并退出」编排共用
  window.__lexiconEditorSave = saveLexicon;
  if (window.api.onEditorSaveRequested) {
    window.api.onEditorSaveRequested(async () => {
      const success = await saveLexicon();
      window.api.editorSaveResult({ success });
    });
  }
  window.api.onLexiconChanged(() => handleExternalChange());

  reloadLexicon();
}

document.addEventListener('DOMContentLoaded', initLexiconEditorPage);
