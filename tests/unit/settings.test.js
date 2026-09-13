import { describe, it, expect } from 'vitest';
import {
  migrateSettings,
  defaultSettings,
  validateEntry,
  genId,
  SETTINGS_VERSION,
  DEFAULT_ASR_CONFIG,
  DEFAULT_LLM_PARAMS,
  DEFAULT_FEEDBACK_CONFIG
} from '../../lib/settings.js';

// Fixture keys are built at runtime, never written as credential-style literals.
const testKey = (name) => ['test', name, 'token'].join('-');

function validEntry(overrides = {}) {
  return {
    id: 'an-x',
    provider: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: testKey('ds'),
    protocol: 'openai-chat',
    models: ['deepseek-chat'],
    primaryModel: 'deepseek-chat',
    ...overrides
  };
}

describe('settings: v2 默认值', () => {
  it('无输入时返回完整 v2 结构（空分析列表）', () => {
    const s = migrateSettings(null);
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.analysis).toEqual({ activeId: null, entries: [] });
    expect(s.llmParams).toEqual(DEFAULT_LLM_PARAMS);
    expect(s.feedback).toEqual({ triggerChars: 30 });
    expect(s.asr.engine).toBe('auto');
  });

  it('defaultSettings() 每次返回独立深拷贝', () => {
    const a = defaultSettings();
    const b = defaultSettings();
    a.asr.engine = 'local';
    a.analysis.entries.push(validEntry());
    expect(b.asr.engine).toBe('auto');
    expect(b.analysis.entries).toHaveLength(0);
  });
});

describe('settings: v1 → v2 迁移矩阵', () => {
  it('已配置 apiKey 的槽转为条目，未配置槽丢弃', () => {
    const s = migrateSettings({
      provider: 'deepseek',
      providers: {
        deepseek: { apiKey: testKey('ds'), model: 'deepseek-chat' },
        zhipu: { apiKey: '', model: 'glm-4.6' },
        ollama: { ollamaUrl: 'http://localhost:11434', model: 'qwen2.5:7b' }
      }
    });
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.analysis.entries).toHaveLength(1);
    const e = s.analysis.entries[0];
    expect(e.provider).toBe('deepseek');
    expect(e.apiKey).toBe(testKey('ds'));
    expect(e.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(e.models).toEqual(['deepseek-chat']);
    expect(e.primaryModel).toBe('deepseek-chat');
    expect(s.analysis.activeId).toBe(e.id); // 原 provider 选中项 → activeId
    expect(s.provider).toBeUndefined(); // v1 字段移除
    expect(s.providers).toBeUndefined();
  });

  it('custom 槽按 baseUrl+protocol+customModel 转换，缺模型名丢弃', () => {
    const s = migrateSettings({
      provider: 'custom',
      providers: {
        custom: { baseUrl: 'https://api.example.com/v1', apiKey: testKey('c'), customModel: 'my-model', protocol: 'anthropic-messages' }
      }
    });
    expect(s.analysis.entries).toHaveLength(1);
    const e = s.analysis.entries[0];
    expect(e.provider).toBe('custom');
    expect(e.baseUrl).toBe('https://api.example.com/v1');
    expect(e.protocol).toBe('anthropic-messages');
    expect(e.models).toEqual(['my-model']);
    expect(s.analysis.activeId).toBe(e.id);
  });

  it('ollama 仅在为选中 provider 时转换（免 Key 无从区分配置过）', () => {
    const s = migrateSettings({ provider: 'ollama', providers: { ollama: { ollamaUrl: 'http://192.168.1.5:11434', model: 'qwen2.5:7b' } } });
    expect(s.analysis.entries).toHaveLength(1);
    expect(s.analysis.entries[0].baseUrl).toBe('http://192.168.1.5:11434/v1');
    const s2 = migrateSettings({ provider: 'deepseek', providers: { ollama: { ollamaUrl: 'http://192.168.1.5:11434', model: 'qwen2.5:7b' } } });
    expect(s2.analysis.entries).toHaveLength(0);
  });

  it('选中 provider 未转出条目时 activeId 回落第一个条目；无条目为 null', () => {
    const s = migrateSettings({
      provider: 'zhipu', // zhipu 槽未配置 → 不转
      providers: { deepseek: { apiKey: testKey('ds'), model: 'deepseek-chat' }, zhipu: { apiKey: '' } }
    });
    expect(s.analysis.activeId).toBe(s.analysis.entries[0].id);
    const s2 = migrateSettings({ provider: 'deepseek', providers: {} });
    expect(s2.analysis.activeId).toBeNull();
  });

  it('已移除预设（kimi/minimax/mimo）的已配置槽仍转换，未配置丢弃', () => {
    const s = migrateSettings({
      provider: 'zhipu',
      providers: {
        kimi: { apiKey: testKey('k'), model: 'kimi-k2-0905-preview' },
        minimax: { apiKey: '', model: 'MiniMax-Text-01' }
      }
    });
    expect(s.analysis.entries).toHaveLength(1);
    const e = s.analysis.entries[0];
    expect(e.provider).toBe('kimi');
    expect(e.name).toBe('Kimi（Moonshot）');
    expect(e.baseUrl).toBe('https://api.moonshot.cn/v1');
    expect(s.analysis.activeId).toBe(e.id); // zhipu 未配置 → 回落第一个条目
  });

  it('周边节点 llmParams / feedback / asr 原样保留', () => {
    const asr = { engine: 'dashscope', dashscope: { apiKey: testKey('cloud'), model: 'fun-asr-realtime' } };
    const s = migrateSettings({
      provider: 'deepseek',
      providers: { deepseek: { apiKey: testKey('ds'), model: 'deepseek-chat' } },
      llmParams: { temperature: 1.2, realtimeMaxTokens: 200, reportMaxTokens: 4096 },
      feedback: { triggerChars: 80 },
      asr
    });
    expect(s.llmParams).toEqual({ temperature: 1.2, realtimeMaxTokens: 200, reportMaxTokens: 4096 });
    expect(s.feedback).toEqual({ triggerChars: 80 });
    expect(s.asr.engine).toBe('dashscope');
    expect(s.asr.dashscope.model).toBe('fun-asr-realtime');
  });
});

describe('settings: 迁移幂等与 v2 补默认', () => {
  it('v2 结构再次经过迁移零变化（幂等）', () => {
    const once = migrateSettings({
      provider: 'deepseek',
      providers: { deepseek: { apiKey: testKey('ds'), model: 'deepseek-chat' } },
      feedback: { triggerChars: 60 }
    });
    const twice = migrateSettings(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });

  it('v2 缺 analysis/llmParams/feedback 时补默认，已有值不覆盖', () => {
    const s = migrateSettings({
      version: SETTINGS_VERSION,
      llmParams: { temperature: 1.5 },
      feedback: { triggerChars: 100 }
    });
    expect(s.analysis).toEqual({ activeId: null, entries: [] });
    expect(s.llmParams).toEqual({ ...DEFAULT_LLM_PARAMS, temperature: 1.5 });
    expect(s.feedback).toEqual({ triggerChars: 100 });
  });

  it('entries 非数组 / activeId 非字符串等手改脏数据被归位', () => {
    const s = migrateSettings({ version: SETTINGS_VERSION, analysis: { entries: 'oops', activeId: 42 } });
    expect(s.analysis.entries).toEqual([]);
    expect(s.analysis.activeId).toBeNull();
  });

  it('无 version 且无 providers 的手改文件按 v2 补默认', () => {
    const s = migrateSettings({ llmParams: { temperature: 0.2 } });
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.analysis.entries).toEqual([]);
    expect(s.llmParams.temperature).toBe(0.2);
  });

  it('asr 启用开关补全（enabled 缺省启用、已有 false 不覆盖）', () => {
    const s = migrateSettings({ providers: { deepseek: { apiKey: testKey('x'), model: 'm' } }, asr: { dashscope: { apiKey: testKey('c'), enabled: false } } });
    expect(s.asr.dashscope.enabled).toBe(false);
    expect(s.asr.tencent.enabled).toBe(true);
    expect(s.asr.local).toEqual({ enabled: true });
  });
});

describe('settings: validateEntry 条目校验', () => {
  it('合法条目原样返回', () => {
    const e = validEntry();
    expect(validateEntry(e)).toBe(e);
  });

  it('缺 id/名/baseUrl/协议/模型、models 空、primaryModel 不在 models 内均拒绝', () => {
    expect(() => validateEntry({ ...validEntry(), id: '' })).toThrow(/id/);
    expect(() => validateEntry({ ...validEntry(), name: '' })).toThrow(/显示名/);
    expect(() => validateEntry({ ...validEntry(), baseUrl: '' })).toThrow(/BASE URL/);
    expect(() => validateEntry({ ...validEntry(), baseUrl: 'ftp://x' })).toThrow(/http\/https/);
    expect(() => validateEntry({ ...validEntry(), protocol: 'grpc' })).toThrow(/协议/);
    expect(() => validateEntry({ ...validEntry(), models: [] })).toThrow(/至少/);
    expect(() => validateEntry({ ...validEntry(), models: [''] })).toThrow(/模型名/);
    expect(() => validateEntry({ ...validEntry(), models: ['a', 'a'] })).toThrow(/重复/);
    expect(() => validateEntry({ ...validEntry(), primaryModel: 'nope' })).toThrow(/当前使用模型/);
    expect(() => validateEntry({ ...validEntry(), provider: 'nope' })).toThrow(/未知的提供商预设/);
    expect(() => validateEntry('x')).toThrow(/对象/);
    expect(() => validateEntry(null)).toThrow(/对象/);
  });

  it('custom provider 跳过预设表校验；apiKey 允许空串与掩码回显', () => {
    expect(validateEntry(validEntry({ provider: 'custom', name: '自定义接入' }))).toBeTruthy();
    expect(validateEntry(validEntry({ apiKey: '••••••••' }))).toBeTruthy();
    expect(validateEntry(validEntry({ apiKey: '' }))).toBeTruthy();
  });
});

describe('settings: genId', () => {
  it('生成 an- 前缀唯一 id', () => {
    const ids = new Set(Array.from({ length: 200 }, () => genId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id.startsWith('an-')).toBe(true);
  });
});
