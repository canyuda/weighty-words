/**
 * Settings-domain IPC: settings read/save (asr-only save), analyzer entry
 * management (multi-instance provider list), inline row operations, official
 * model-list fetching, per-model connectivity tests, and the masked-key
 * reveal whitelist. Pure wiring — logic lives in lib/settings.js,
 * lib/secret-box.js, lib/model-presets.js, lib/ai-feedback.js.
 */

const fs = require('fs');
const { ipcMain } = require('electron');
const { logger } = require('../logger');
const { getSettingsPath, atomicWriteFileSync } = require('../config-paths');
const { migrateSettings, validateEntry, genId } = require('../settings');
const {
  mergeMaskedSecrets,
  mergeMaskedAnalyzerEntry,
  isMasked,
  transformSecrets,
  maskKey
} = require('../secret-box');
const { validateLlmParams, assertPublicHttpUrl, trimBase } = require('../llm-protocol');
const { MODEL_PRESETS, CUSTOM_PROVIDER_ID, modelsRequestInfo } = require('../model-presets');
const { testConnection, resolveAnalyzerConfig, extractApiErrorMessage } = require('../ai-feedback');

const ASR_REVEALABLE_SLOTS = [
  ['asr', 'dashscope', 'apiKey'],
  ['asr', 'tencent', 'secretKey'],
  ['asr', 'volcengine', 'accessKey'],
  ['asr', 'xfyun', 'apiKey']
];

/** 渲染层只见掩码（前5 + •••••••• + 后5）：明文永不主动下发 */
function maskSettingsForRenderer(settings) {
  const copy = JSON.parse(JSON.stringify(settings));
  transformSecrets(copy, (v) => maskKey(v));
  return copy;
}

function loadSettings() {
  const settingsPath = getSettingsPath();
  if (fs.existsSync(settingsPath)) {
    // 明文直读；缺失字段补默认（手改容忍），已有值不覆盖
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return migrateSettings(raw);
  }
  return migrateSettings(null);
}

function saveSettings(settings) {
  // 磁盘与内存同为明文：~/.weighty-words 用户主权文件（0600 保护，透明可备份）
  atomicWriteFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
}

/** 激活条目解析：activeId 悬空回落第一个条目，无条目 null（未配置引导态） */
function getActiveAnalyzer(settings) {
  const analysis = settings && settings.analysis;
  const entries = (analysis && Array.isArray(analysis.entries)) ? analysis.entries : [];
  if (!entries.length) return null;
  return entries.find((e) => e && e.id === analysis.activeId) || entries[0];
}

/** AI 反馈是否已配置（ollama 免 Key，custom 看 baseUrl，其余看 apiKey；纯本地判定） */
function isAIConfigured(settings) {
  const entry = getActiveAnalyzer(settings);
  if (!entry) return false;
  if (entry.provider === 'ollama') return true;
  if (entry.provider === CUSTOM_PROVIDER_ID) return !!(entry.baseUrl && entry.baseUrl.trim());
  return !!(entry.apiKey && entry.apiKey.trim());
}

/** 按白名单槽位从内存真值取明文；路径不合法一律拒绝（fail closed） */
function revealSecretSlot(settingsStore, slot) {
  if (!Array.isArray(slot)) return null;
  if (slot.length === 4 && slot[0] === 'analysis' && slot[1] === 'entries' && slot[3] === 'apiKey') {
    const entry = (settingsStore.get().analysis.entries || []).find((e) => e && e.id === slot[2]);
    return entry && typeof entry.apiKey === 'string' ? entry.apiKey : '';
  }
  const match = ASR_REVEALABLE_SLOTS.find((p) => p.length === slot.length && p.every((seg, i) => seg === slot[i]));
  if (!match) return null;
  let holder = settingsStore.get();
  for (const seg of match) {
    holder = holder && holder[seg];
  }
  return typeof holder === 'string' ? holder : '';
}

/**
 * 注册设置域 handler。deps:
 *   settingsStore          串行化设置仓库
 *   configureModelsDir(dir) 模型根目录跟随设置
 *   broadcastASRAvailability() asr 可用性推送（asr 域提供）
 */
function registerSettingsIpc({ settingsStore, configureModelsDir, broadcastASRAvailability }) {
  ipcMain.handle('get-settings', () => {
    return maskSettingsForRenderer(settingsStore.get());
  });

  // 「语音识别」面板保存：只写 asr 节点（与分析模型面板的保存互相独立）
  ipcMain.handle('save-settings', async (event, incoming) => {
    await settingsStore.update((current) => {
      const merged = mergeMaskedSecrets({ asr: (incoming && incoming.asr) || {} }, current);
      current.asr = merged.asr;
      return current;
    });
    configureModelsDir(settingsStore.get().asr.modelsDir); // dir may be edited then saved elsewhere
    broadcastASRAvailability(); // 引擎/Key 变更 → 录音按钮状态即时刷新
    logger.info('settings', '语音识别配置已保存');
    return { success: true };
  });

  // ===== 分析模型：通用设置 / 条目管理 / 行内操作（全部即时落盘）=====

  // 「分析模型」面板保存：只写 llmParams 与 feedback（全部提供商条目共用）
  ipcMain.handle('save-analyzer-settings', async (event, payload) => {
    const llmParams = payload && payload.llmParams;
    const feedback = payload && payload.feedback;
    const check = validateLlmParams(llmParams);
    if (!check.ok) return { success: false, error: check.error };
    await settingsStore.update((current) => {
      current.llmParams = llmParams;
      current.feedback = feedback;
      return current;
    });
    logger.info('settings', '生成参数已保存');
    return { success: true };
  });

  ipcMain.handle('get-model-presets', () => {
    return { presets: Object.values(MODEL_PRESETS) };
  });

  // 新增/编辑弹窗保存：校验后 upsert 单个条目；列表此前为空时该条目自动激活
  ipcMain.handle('save-analyzer-entry', async (event, rawEntry) => {
    let entry;
    try {
      // 新条目（无 id）由主进程生成；展开顺序保证空串/缺失 id 都被补上
      entry = validateEntry({ ...(rawEntry || {}), id: (rawEntry && rawEntry.id) ? rawEntry.id : genId() });
    } catch (error) {
      return { success: false, error: error.message };
    }
    if (entry.provider === CUSTOM_PROVIDER_ID) {
      try {
        assertPublicHttpUrl(trimBase(entry.baseUrl));
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    try {
      await settingsStore.update((current) => {
        const entries = current.analysis.entries;
        mergeMaskedAnalyzerEntry(entry, entries); // 掩码回显 → 保留存储真值
        const idx = entries.findIndex((e) => e.id === entry.id);
        if (idx >= 0) entries[idx] = entry;
        else entries.push(entry);
        if (!current.analysis.activeId) current.analysis.activeId = entry.id; // 首个条目默认选中
        return current;
      });
      logger.info('settings', '分析模型条目已保存', { provider: entry.provider, name: entry.name });
      return { success: true, id: entry.id };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('set-active-analyzer', async (event, { id } = {}) => {
    return settingsStore.update((current) => {
      if (!current.analysis.entries.some((e) => e.id === id)) {
        throw new Error('条目不存在或已被移除');
      }
      current.analysis.activeId = id;
      return current;
    }).then(() => {
      logger.info('settings', '激活分析模型已切换', { id });
      return { success: true };
    }).catch((error) => ({ success: false, error: error.message }));
  });

  ipcMain.handle('set-analyzer-model', async (event, { entryId, model } = {}) => {
    return settingsStore.update((current) => {
      const entry = current.analysis.entries.find((e) => e.id === entryId);
      if (!entry) throw new Error('条目不存在或已被移除');
      if (!entry.models.includes(model)) throw new Error(`模型「${model}」不在该条目的已配置模型中`);
      entry.primaryModel = model;
      return current;
    }).then(() => {
      logger.info('settings', '当前使用模型已切换', { model });
      return { success: true };
    }).catch((error) => ({ success: false, error: error.message }));
  });

  ipcMain.handle('remove-analyzer', async (event, { id } = {}) => {
    return settingsStore.update((current) => {
      const idx = current.analysis.entries.findIndex((e) => e.id === id);
      if (idx < 0) throw new Error('条目不存在或已被移除');
      current.analysis.entries.splice(idx, 1);
      if (current.analysis.activeId === id) {
        // 激活条目被移除：回落第一个剩余条目（无条目 → null 引导态）
        current.analysis.activeId = current.analysis.entries[0] ? current.analysis.entries[0].id : null;
      }
      return current;
    }).then(() => {
      logger.info('settings', '分析模型条目已删除', { id });
      return { success: true };
    }).catch((error) => ({ success: false, error: error.message }));
  });

  // 官网模型列表拉取：15s 超时，按预设能力/协议归一；结果不落盘
  ipcMain.handle('fetch-analyzer-models', async (event, { provider, baseUrl, apiKey, protocol, entryId } = {}) => {
    try {
      let key = apiKey || '';
      if (typeof key === 'string' && key.includes('•') && entryId) {
        // 掩码回显 ≠ 真实 Key：按正在编辑的条目取存储明文
        const entry = (settingsStore.get().analysis.entries || []).find((e) => e && e.id === entryId);
        if (entry && typeof entry.apiKey === 'string') key = entry.apiKey;
      }
      const info = modelsRequestInfo(provider, baseUrl, key, protocol);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      let response;
      try {
        response = await fetch(info.url, { headers: info.headers, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const rawText = await response.text();
      if (!response.ok) {
        return { success: false, error: `拉取失败 (HTTP ${response.status}): ${extractApiErrorMessage(rawText)}` };
      }
      const models = info.parse(JSON.parse(rawText));
      if (!models.length) return { success: false, error: '接口返回了空模型列表' };
      return { success: true, models };
    } catch (error) {
      const reason = error.name === 'AbortError' ? '请求超时（15 秒）' : error.message;
      return { success: false, error: `拉取失败：${reason}` };
    }
  });

  // 逐模型连通性测试：按条目 id + 指定模型单次最小请求（保存不再自动测试）
  ipcMain.handle('test-analyzer-model', async (event, { entryId, model } = {}) => {
    const settings = settingsStore.get();
    const entry = (settings.analysis.entries || []).find((e) => e.id === entryId);
    if (!entry) return { success: false, name: '', model: model || '', error: '条目不存在或已被移除' };
    try {
      const config = resolveAnalyzerConfig({ ...entry, primaryModel: model });
      const result = await testConnection(config);
      return { ...result, name: entry.name, model };
    } catch (error) {
      return { success: false, name: entry.name, model, error: `连接失败: ${error.message}` };
    }
  });

  // 密钥明文切换（眼睛按钮）：按白名单槽位换取全量明文，渲染层常态只有掩码
  ipcMain.handle('reveal-secret', (event, slot) => {
    return { value: revealSecretSlot(settingsStore, slot) };
  });
}

module.exports = {
  registerSettingsIpc,
  loadSettings,
  saveSettings,
  maskSettingsForRenderer,
  getActiveAnalyzer,
  isAIConfigured
};
