/**
 * 分析模型子系统：提供商表格（名称含激活单选 / 模型胶囊下拉 / 操作列 测试·编辑·删除）、
 * 新增/编辑弹窗（预设 → baseUrl 自动填充、协议锁定、Key 掩码组件、模型多选 + 官网拉取、
 * 主模型收敛）、逐模型测试弹窗。行内操作即时落盘。
 * UMD：浏览器挂 window.createAnalyzerSection，供设置页装配；CommonJS 供未来测试。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.createAnalyzerSection = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * @param {Object} page 设置页装配壳：提供 settings 快照（live 引用）、
   *   connectionError / saveSuccess 提示元素
   */
  function createAnalyzerSection(page) {
    const $ = (id) => document.getElementById(id);
    const section = {
      presets: [],
      presetsById: {},
      editingId: null,      // null = 新增
      models: [],           // 有序集合（首项为默认主模型）
      primary: ''
    };

    // 弹窗 Key 字段：槽位按正在编辑的条目动态解析；新增条目（无 id）无明文可换
    const dialogKeyField = window.createSecretField(
      $('analyzer-apikey'),
      () => (section.editingId ? ['analysis', 'entries', section.editingId, 'apiKey'] : null)
    );

    function preset(id) {
      return section.presetsById[id] || null;
    }

    function showError(message) {
      page.connectionError.textContent = `⚠️ ${message}`;
      page.connectionError.classList.add('show');
      setTimeout(() => page.connectionError.classList.remove('show'), 4000);
    }

    /** 拉取最新设置快照并重绘列表（行内操作/弹窗保存后统一走此路径，不维护双写状态） */
    async function pull() {
      page.settings = await window.api.getSettings();
      renderList();
    }

    function renderList() {
      const analysis = (page.settings && page.settings.analysis) || { activeId: null, entries: [] };
      const entries = analysis.entries || [];
      const list = $('analyzer-list');
      list.innerHTML = '';
      if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'analyzer-empty';
        empty.textContent = '尚未配置分析模型：点击「新增」添加一个提供商条目';
        list.appendChild(empty);
        return;
      }
      const table = document.createElement('table');
      table.className = 'analyzer-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const label of ['名称', '模型', '操作']) {
        const th = document.createElement('th');
        th.textContent = label;
        if (label === '操作') th.classList.add('an-col-actions');
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const entry of entries) {
        tbody.appendChild(buildRow(entry, analysis.activeId));
      }
      table.appendChild(tbody);
      list.appendChild(table);
    }

    function buildRow(entry, activeId) {
      const tr = document.createElement('tr');
      tr.className = 'analyzer-row' + (entry.id === activeId ? ' active' : '');

      // 名称列：激活单选框 + 显示名（单选 = 使用该条目）
      const nameCell = document.createElement('td');
      nameCell.className = 'an-col-name';
      const nameWrap = document.createElement('label');
      nameWrap.className = 'an-name-wrap';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'analyzer-active';
      radio.checked = entry.id === activeId;
      radio.title = '设为使用的分析模型';
      radio.setAttribute('aria-label', `使用 ${entry.name}`);
      radio.addEventListener('change', async () => {
        const r = await window.api.setActiveAnalyzer(entry.id);
        if (!r.success) return showError(r.error);
        pull();
      });
      nameWrap.appendChild(radio);
      const nameText = document.createElement('span');
      nameText.className = 'an-row-name';
      nameText.textContent = entry.name;
      nameWrap.appendChild(nameText);
      nameCell.appendChild(nameWrap);
      tr.appendChild(nameCell);

      // 模型列：条目内多选模型的选用入口；单模型置灰，无模型引导编辑
      const modelCell = document.createElement('td');
      const modelSelect = document.createElement('select');
      modelSelect.className = 'an-row-model';
      modelSelect.title = '切换当前使用的模型（即时生效）';
      if (!entry.models.length) {
        const opt = document.createElement('option');
        opt.textContent = '未配置模型';
        modelSelect.appendChild(opt);
        modelSelect.disabled = true;
      } else {
        for (const m of entry.models) {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          if (m === entry.primaryModel) opt.selected = true;
          modelSelect.appendChild(opt);
        }
        modelSelect.disabled = entry.models.length <= 1;
        modelSelect.addEventListener('change', async () => {
          const r = await window.api.setAnalyzerModel(entry.id, modelSelect.value);
          if (!r.success) return showError(r.error);
          pull();
        });
      }
      modelCell.appendChild(modelSelect);
      tr.appendChild(modelCell);

      // 操作列：测试（行内，针对本条目）· 编辑 · 删除
      const actionCell = document.createElement('td');
      actionCell.className = 'an-col-actions';
      const test = document.createElement('button');
      test.type = 'button';
      test.className = 'btn-sm an-test-open';
      test.textContent = '测试';
      test.title = `测试「${entry.name}」的连通性（逐模型）`;
      test.addEventListener('click', () => openTestDialog(entry));
      actionCell.appendChild(test);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn-sm';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => openDialog(entry));
      actionCell.appendChild(edit);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-sm btn-danger';
      remove.textContent = '删除';
      remove.addEventListener('click', async () => {
        if (!(await window.appConfirm(`删除「${entry.name}」？其 API Key 将从配置中删除。`, { title: '删除提供商', okText: '删除', danger: true }))) return;
        const r = await window.api.removeAnalyzer(entry.id);
        if (!r.success) return showError(r.error);
        pull();
      });
      actionCell.appendChild(remove);
      tr.appendChild(actionCell);

      return tr;
    }

    // ===== 新增/编辑弹窗 =====

    function openDialog(entry) {
      section.editingId = entry ? entry.id : null;
      $('analyzer-dialog-title').textContent = entry ? '编辑分析模型' : '新增分析模型';
      $('analyzer-dialog-error').textContent = '';
      section.models = entry ? [...entry.models] : [];
      section.primary = entry ? entry.primaryModel : '';

      // 预设下拉：内置预设 + 自定义接入（编辑时也允许换预设）
      const presetSelect = $('analyzer-preset');
      presetSelect.innerHTML = '';
      for (const p of section.presets) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        presetSelect.appendChild(opt);
      }
      const customOpt = document.createElement('option');
      customOpt.value = 'custom';
      customOpt.textContent = '自定义接入（多协议）';
      presetSelect.appendChild(customOpt);
      presetSelect.value = entry ? entry.provider : (section.presets[0] && section.presets[0].id);

      $('analyzer-name').value = entry ? entry.name : (preset(presetSelect.value) ? preset(presetSelect.value).name : '');
      $('analyzer-base-url').value = entry ? entry.baseUrl : (preset(presetSelect.value) ? preset(presetSelect.value).baseUrl : '');
      dialogKeyField.input.value = entry ? entry.apiKey : '';
      applyProtocolLock();
      renderModelChips();
      renderPrimarySelect();
      $('analyzer-model-candidates').classList.add('hidden');

      // 弹窗 Key 字段掩码基准刷新（编辑已存条目 → 掩码回显）
      dialogKeyField.sync();
      $('analyzer-dialog-mask').classList.remove('hidden');
      $('analyzer-name').focus();
    }

    function closeDialog() {
      $('analyzer-dialog-mask').classList.add('hidden');
      dialogKeyField.input.value = '';
      dialogKeyField.revealed = false;
      dialogKeyField.plaintext = '';
      dialogKeyField.masked = '';
      dialogKeyField.refresh();
    }

    /** 预设切换联动：baseUrl 自动填充可改；协议锁定（custom 手选）；刷新入口显隐 */
    function onPresetChange() {
      const id = $('analyzer-preset').value;
      const p = preset(id);
      $('analyzer-base-url').value = p ? p.baseUrl : '';
      const currentName = $('analyzer-name').value.trim();
      if (!currentName || Object.values(section.presetsById).some((x) => x.name === currentName)) {
        $('analyzer-name').value = p ? p.name : '自定义接入';
      }
      applyProtocolLock();
      updateRefreshVisibility();
    }

    function applyProtocolLock() {
      const protocolSelect = $('analyzer-protocol');
      const isCustom = $('analyzer-preset').value === 'custom';
      protocolSelect.value = isCustom
        ? 'openai-chat'
        : (preset($('analyzer-preset').value) ? preset($('analyzer-preset').value).protocol : 'openai-chat');
      protocolSelect.disabled = !isCustom;
      $('analyzer-protocol-hint').textContent = isCustom ? '按你的端点选择协议' : '内置预设按官方接口自动锁定';
    }

    /** 刷新入口显隐：有官网模型列表接口的预设/协议才显示 */
    function updateRefreshVisibility() {
      const id = $('analyzer-preset').value;
      const p = preset(id);
      const isCustom = id === 'custom';
      const capable = isCustom
        ? true // custom 按所选协议推导（openai 系/anthropic 均有 /models）
        : !!(p && p.modelsApi);
      $('btn-analyzer-refresh').classList.toggle('hidden', !capable);
    }

    function addModelFromInput() {
      const input = $('analyzer-model-input');
      const v = input.value.trim();
      if (!v) return;
      if (section.models.includes(v)) {
        $('analyzer-dialog-error').textContent = `模型「${v}」已在列表中`;
        return;
      }
      section.models.push(v);
      if (!section.primary) section.primary = v;
      input.value = '';
      $('analyzer-dialog-error').textContent = '';
      renderModelChips();
      renderPrimarySelect();
    }

    function removeModel(m) {
      section.models = section.models.filter((x) => x !== m);
      if (!section.models.includes(section.primary)) {
        // 主模型不变量：被删时自动回落到剩余第一个
        section.primary = section.models[0] || '';
      }
      renderModelChips();
      renderPrimarySelect();
    }

    function renderModelChips() {
      const box = $('analyzer-model-chips');
      box.innerHTML = '';
      for (const m of section.models) {
        const chip = document.createElement('span');
        chip.className = 'an-model-chip';
        const text = document.createElement('span');
        text.textContent = m;
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'chip-x';
        x.textContent = '×';
        x.title = `移除模型 ${m}`;
        x.addEventListener('click', () => removeModel(m));
        chip.appendChild(text);
        chip.appendChild(x);
        box.appendChild(chip);
      }
      if (!section.models.length) {
        const empty = document.createElement('span');
        empty.className = 'an-model-empty';
        empty.textContent = '尚未添加模型';
        box.appendChild(empty);
      }
    }

    function renderPrimarySelect() {
      const select = $('analyzer-primary');
      select.innerHTML = '';
      for (const m of section.models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === section.primary) opt.selected = true;
        select.appendChild(opt);
      }
      select.disabled = section.models.length <= 1;
      if (!section.models.length) {
        const opt = document.createElement('option');
        opt.textContent = '未配置模型';
        select.appendChild(opt);
      }
    }

    /** 官网模型列表拉取：候选区勾选即加入/移出；Key 为掩码回显时主进程按条目取真值 */
    async function refreshModels() {
      const btn = $('btn-analyzer-refresh');
      const original = btn.textContent;
      btn.textContent = '拉取中…';
      btn.disabled = true;
      try {
        const r = await window.api.fetchAnalyzerModels({
          provider: $('analyzer-preset').value,
          baseUrl: $('analyzer-base-url').value.trim(),
          apiKey: dialogKeyField.input.value,
          protocol: $('analyzer-protocol').value,
          entryId: section.editingId
        });
        if (!r.success) {
          $('analyzer-dialog-error').textContent = r.error; // 显式失败原因，已勾选内容不动
          return;
        }
        renderCandidates(r.models);
      } finally {
        btn.textContent = original;
        btn.disabled = false;
      }
    }

    function renderCandidates(models) {
      const box = $('analyzer-model-candidates');
      box.innerHTML = '';
      for (const m of models) {
        const label = document.createElement('label');
        label.className = 'an-candidate';
        const box2 = document.createElement('input');
        box2.type = 'checkbox';
        box2.checked = section.models.includes(m);
        box2.addEventListener('change', () => {
          if (box2.checked) {
            if (!section.models.includes(m)) {
              section.models.push(m);
              if (!section.primary) section.primary = m;
            }
          } else {
            removeModel(m);
          }
          renderModelChips();
          renderPrimarySelect();
        });
        const text = document.createElement('span');
        text.textContent = m;
        label.appendChild(box2);
        label.appendChild(text);
        box.appendChild(label);
      }
      box.classList.remove('hidden');
    }

    async function saveEntry() {
      const providerId = $('analyzer-preset').value;
      const p = preset(providerId);
      const name = $('analyzer-name').value.trim() || (p ? p.name : '自定义接入');
      const baseUrl = $('analyzer-base-url').value.trim();
      const models = [...section.models];
      const primaryModel = section.primary && models.includes(section.primary) ? section.primary : models[0];
      const errBox = $('analyzer-dialog-error');
      errBox.textContent = '';
      if (!baseUrl) { errBox.textContent = '请填写 BASE URL'; return; }
      if (!models.length) { errBox.textContent = '至少需要配置一个模型'; return; }
      const entry = {
        id: section.editingId || '',
        provider: providerId,
        name,
        baseUrl,
        apiKey: dialogKeyField.input.value,
        protocol: $('analyzer-protocol').value,
        models,
        primaryModel
      };
      const r = await window.api.saveAnalyzerEntry(entry);
      if (!r.success) {
        errBox.textContent = r.error || '保存失败';
        return;
      }
      closeDialog();
      await pull();
      page.saveSuccess.textContent = '✓ 已保存并生效';
      page.saveSuccess.classList.add('show');
      setTimeout(() => page.saveSuccess.classList.remove('show'), 2000);
    }

    // ===== 逐模型测试弹窗 =====

    function openTestDialog(entry) {
      const rows = $('analyzer-test-rows');
      rows.innerHTML = '';
      if (!entry || !entry.models.length) {
        $('analyzer-test-empty').style.display = '';
        $('analyzer-test-mask').classList.remove('hidden');
        return;
      }
      $('analyzer-test-title').textContent = `测试分析模型 · ${entry.name}`;
      $('analyzer-test-empty').style.display = 'none';
      for (const model of entry.models) {
        const row = document.createElement('div');
        row.className = 'an-test-row';
        const label = document.createElement('span');
        label.className = 'an-test-label';
        label.textContent = `${entry.name} · ${model}`;
        const status = document.createElement('span');
        status.className = 'an-test-status';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-sm';
        btn.textContent = '测试模型';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          status.textContent = '测试中…';
          status.className = 'an-test-status';
          const r = await window.api.testAnalyzerModel(entry.id, model);
          if (r.success) {
            status.textContent = '✓ 连接正常';
            status.classList.add('ok');
          } else {
            status.textContent = `✗ ${r.error || '连接失败'}`;
            status.classList.add('err');
          }
          btn.disabled = false;
        });
        row.appendChild(label);
        row.appendChild(status);
        row.appendChild(btn);
        rows.appendChild(row);
      }
      $('analyzer-test-mask').classList.remove('hidden');
    }

    function init() {
      section.presets = [];
      section.presetsById = {};
      $('btn-analyzer-add').addEventListener('click', () => openDialog(null));
      $('btn-analyzer-dialog-close').addEventListener('click', closeDialog);
      $('btn-analyzer-cancel').addEventListener('click', closeDialog);
      $('btn-analyzer-save').addEventListener('click', saveEntry);
      $('btn-analyzer-test-close').addEventListener('click', () => $('analyzer-test-mask').classList.add('hidden'));
      $('btn-analyzer-test-done').addEventListener('click', () => $('analyzer-test-mask').classList.add('hidden'));
      $('analyzer-preset').addEventListener('change', onPresetChange);
      $('btn-analyzer-model-add').addEventListener('click', addModelFromInput);
      $('analyzer-model-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addModelFromInput(); }
      });
      $('btn-analyzer-refresh').addEventListener('click', refreshModels);
    }

    /** Esc 分层：弹窗开着 → 关掉并返回 true（页面 Esc 不再触发返回工作台） */
    function handleEscape() {
      if (!$('analyzer-dialog-mask').classList.contains('hidden')) { closeDialog(); return true; }
      if (!$('analyzer-test-mask').classList.contains('hidden')) { $('analyzer-test-mask').classList.add('hidden'); return true; }
      return false;
    }

    return {
      // 预设表由装配壳 loadSettings 赋值：getter/setter 委托到内部 section，
      // 保证闭包内 openDialog 读到的与页面写入的是同一份数据
      get presets() { return section.presets; },
      set presets(v) { section.presets = v; },
      get presetsById() { return section.presetsById; },
      set presetsById(v) { section.presetsById = v; },
      init,
      /** 装配壳 loadSettings 后调用：以新快照重绘列表 */
      refreshFromSettings(settings) {
        // page.settings 已由装配壳更新，此处只重绘
        renderList();
      },
      handleEscape
    };
  }

  return createAnalyzerSection;
});
