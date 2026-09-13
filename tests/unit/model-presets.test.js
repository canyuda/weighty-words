import { describe, it, expect } from 'vitest';
import { MODEL_PRESETS, CUSTOM_PROVIDER_ID, modelsRequestInfo } from '../../lib/model-presets.js';

const tk = (n) => ['unit', n, 'token'].join('-');

describe('model-presets: 预设表完整性', () => {
  const REQUIRED = ['id', 'name', 'baseUrl', 'protocol', 'modelsApi', 'defaultModels'];

  it('每个预设字段齐备且协议锁定 openai-chat', () => {
    for (const p of Object.values(MODEL_PRESETS)) {
      for (const key of REQUIRED) expect(p, `${p.id}.${key}`).toHaveProperty(key);
      expect(p.id).toBe(Object.keys(MODEL_PRESETS).find((k) => MODEL_PRESETS[k] === p));
      expect(p.protocol).toBe('openai-chat');
      expect(p.baseUrl).toMatch(/^https?:\/\//);
      expect(p.modelsApi === null || ['openai', 'ollama'].includes(p.modelsApi)).toBe(true);
      expect(p.defaultModels.length).toBeGreaterThan(0);
    }
  });

  it('现役四家 + ollama 在表且智谱居首；custom 与已移除预设不入表', () => {
    const ids = Object.keys(MODEL_PRESETS);
    expect(ids[0]).toBe('zhipu');
    for (const id of ['zhipu', 'openai', 'deepseek', 'ollama']) {
      expect(MODEL_PRESETS[id]).toBeTruthy();
    }
    for (const id of ['kimi', 'minimax', 'mimo', CUSTOM_PROVIDER_ID]) {
      expect(MODEL_PRESETS[id]).toBeUndefined();
    }
  });

  it('模型列表能力表：ollama 走 /api/tags，其余启用 openai 列表接口', () => {
    expect(MODEL_PRESETS.ollama.modelsApi).toBe('ollama');
    for (const id of ['zhipu', 'openai', 'deepseek']) {
      expect(MODEL_PRESETS[id].modelsApi).toBe('openai');
    }
  });
});

describe('model-presets: modelsRequestInfo 请求归一', () => {
  it('openai 型：GET {baseUrl}/models + Bearer，解析 data[].id 并去重排序', () => {
    const info = modelsRequestInfo('deepseek', 'https://api.deepseek.com/v1/', tk('d'), 'openai-chat');
    expect(info.url).toBe('https://api.deepseek.com/v1/models');
    expect(info.headers.Authorization).toBe(`Bearer ${tk('d')}`);
    expect(info.parse({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }, { id: '' }] })).toEqual(['a', 'b']);
  });

  it('ollama：剥 /v1 拼 /api/tags、无鉴权头、解析 models[].name', () => {
    const info = modelsRequestInfo('ollama', 'http://192.168.1.5:11434/v1', '', 'openai-chat');
    expect(info.url).toBe('http://192.168.1.5:11434/api/tags');
    expect(info.headers).toEqual({});
    expect(info.parse({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama3:8b' }] })).toEqual(['llama3:8b', 'qwen2.5:7b']);
  });

  it('anthropic 型（custom 协议推导）：x-api-key + version 头，解析 data[].id', () => {
    const info = modelsRequestInfo('custom', 'https://api.example.com', tk('c'), 'anthropic-messages');
    expect(info.url).toBe('https://api.example.com/models');
    expect(info.headers['x-api-key']).toBe(tk('c'));
    expect(info.headers['anthropic-version']).toBeTruthy();
  });

  it('custom 默认推导 openai 型；baseUrl 缺失抛错', () => {
    expect(modelsRequestInfo('custom', 'https://x.example.com/v1', '', 'openai-chat').url).toBe('https://x.example.com/v1/models');
    expect(() => modelsRequestInfo('custom', '', '', 'openai-chat')).toThrow(/端点地址未配置/);
  });
});
