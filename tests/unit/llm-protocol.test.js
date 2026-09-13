import { describe, it, expect } from 'vitest';
import {
  buildRequest,
  parseResponse,
  extractStreamDelta,
  assertPublicHttpUrl,
  isPrivateHost,
  validateLlmParams,
  LLM_PARAM_RANGES
} from '../../lib/llm-protocol.js';

const baseArgs = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'k-test',
  model: 'm-test',
  system: 'SYS',
  user: 'USER',
  maxTokens: 150,
  temperature: 0.7
};

describe('protocol: buildRequest openai-chat（默认）', () => {
  it('URL/头/体符合契约', () => {
    const r = buildRequest(baseArgs);
    expect(r.url).toBe('https://api.example.com/v1/chat/completions');
    expect(r.headers.Authorization).toBe('Bearer k-test');
    expect(r.body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' }
    ]);
    expect(r.body.max_tokens).toBe(150);
    expect(r.body.temperature).toBe(0.7);
  });

  it('baseUrl 尾斜杠被去除', () => {
    const r = buildRequest({ ...baseArgs, baseUrl: 'https://api.example.com/v1///' });
    expect(r.url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('缺省 protocol 视为 openai-chat', () => {
    const r = buildRequest({ ...baseArgs, protocol: undefined });
    expect(r.url).toContain('/chat/completions');
  });
});

describe('protocol: buildRequest openai-responses', () => {
  it('URL/头/体符合契约（input + max_output_tokens）', () => {
    const r = buildRequest({ ...baseArgs, protocol: 'openai-responses' });
    expect(r.url).toBe('https://api.example.com/v1/responses');
    expect(r.headers.Authorization).toBe('Bearer k-test');
    expect(r.body.input).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' }
    ]);
    expect(r.body.max_output_tokens).toBe(150);
    expect(r.body.max_tokens).toBeUndefined();
    expect(r.body.messages).toBeUndefined();
  });
});

describe('protocol: buildRequest anthropic-messages', () => {
  it('system 顶层、messages 不含 system、max_tokens 必填、专用头', () => {
    const r = buildRequest({ ...baseArgs, protocol: 'anthropic-messages' });
    expect(r.url).toBe('https://api.example.com/v1/messages');
    expect(r.headers['x-api-key']).toBe('k-test');
    expect(r.headers['anthropic-version']).toBeTruthy();
    expect(r.headers.Authorization).toBeUndefined();
    expect(r.body.system).toBe('SYS');
    expect(r.body.messages).toEqual([{ role: 'user', content: 'USER' }]);
    expect(r.body.max_tokens).toBe(150);
  });

  it('baseUrl 已含 /v1 时不重复拼接', () => {
    const r = buildRequest({ ...baseArgs, protocol: 'anthropic-messages', baseUrl: 'https://api.example.com/v1/' });
    expect(r.url).toBe('https://api.example.com/v1/messages');
  });
});

describe('protocol: parseResponse', () => {
  it('openai-chat 取 choices[0].message.content', () => {
    expect(parseResponse('openai-chat', { choices: [{ message: { content: 'A' } }] })).toBe('A');
  });

  it('anthropic 拼接 text 块', () => {
    expect(
      parseResponse('anthropic-messages', { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] })
    ).toBe('AB');
  });

  it('responses 优先 output_text，回退遍历 output', () => {
    expect(parseResponse('openai-responses', { output_text: 'FAST' })).toBe('FAST');
    expect(
      parseResponse('openai-responses', {
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'A' }, { type: 'output_text', text: 'B' }] }]
      })
    ).toBe('AB');
  });
});

describe('protocol: 端点校验', () => {
  it('拒绝环回/私有/保留地址与非法协议', () => {
    const bad = [
      'http://localhost:11434',
      'http://127.0.0.1:8080',
      'http://10.1.2.3/v1',
      'http://172.16.0.9/v1',
      'http://192.168.1.10/v1',
      'http://169.254.1.1',
      'http://100.64.0.1',
      'http://0.0.0.0',
      'http://[::1]:9000',
      'http://[fc00::1]',
      'ftp://api.example.com',
      'not a url'
    ];
    for (const url of bad) {
      expect(() => assertPublicHttpUrl(url), url).toThrow();
    }
  });

  it('放行公网 http/https 地址（含公网 IP 与域名）', () => {
    for (const url of ['https://api.example.com/v1', 'http://api.example.com/v1', 'http://8.8.8.8/v1']) {
      expect(() => assertPublicHttpUrl(url), url).not.toThrow();
    }
  });

  it('isPrivateHost 判定 .local/.internal 与 IPv4 映射 IPv6', () => {
    expect(isPrivateHost('nas.local')).toBe(true);
    expect(isPrivateHost('db.internal')).toBe(true);
    expect(isPrivateHost('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateHost('api.example.com')).toBe(false);
  });
});

describe('protocol: 生成参数校验', () => {
  it('缺省参数视为合法（走默认值）', () => {
    expect(validateLlmParams(undefined).ok).toBe(true);
    expect(validateLlmParams({}).ok).toBe(true);
  });

  it('边界值合法', () => {
    expect(
      validateLlmParams({ temperature: 0, realtimeMaxTokens: 32, reportMaxTokens: 1024 }).ok
    ).toBe(true);
    expect(
      validateLlmParams({ temperature: 2, realtimeMaxTokens: 512, reportMaxTokens: 32768 }).ok
    ).toBe(true);
  });

  it('越界/非法类型拒绝并给出范围', () => {
    expect(validateLlmParams({ temperature: 5 }).ok).toBe(false);
    expect(validateLlmParams({ realtimeMaxTokens: 10 }).ok).toBe(false);
    expect(validateLlmParams({ reportMaxTokens: 50000 }).ok).toBe(false);
    expect(validateLlmParams({ temperature: 'hot' }).ok).toBe(false);
    const r = validateLlmParams({ temperature: 5 });
    expect(r.error).toContain(Object.keys(LLM_PARAM_RANGES)[0]);
  });
});

describe('llm-protocol: extraBody 合并', () => {
  const base = { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm', system: 's', user: 'u', maxTokens: 10, temperature: 0.7 };

  it('openai-chat 合并 extraBody（可覆盖默认字段）', () => {
    const { body } = buildRequest({ ...base, extraBody: { thinking: { type: 'disabled' } } });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.max_tokens).toBe(10);
  });

  it('extraBody 缺省时不引入多余字段', () => {
    const { body } = buildRequest(base);
    expect(body.thinking).toBeUndefined();
  });
});

describe('llm-protocol: extractStreamDelta（SSE 增量提取）', () => {
  it('openai-chat 取 delta.content，跳过 reasoning_content 与空段', () => {
    expect(extractStreamDelta('openai-chat', { choices: [{ delta: { content: '你好' } }] })).toBe('你好');
    expect(extractStreamDelta('openai-chat', { choices: [{ delta: { reasoning_content: '思考中' } }] })).toBe('');
    expect(extractStreamDelta('openai-chat', { choices: [{ delta: {} }] })).toBe('');
    expect(extractStreamDelta('openai-chat', null)).toBe('');
  });

  it('anthropic-messages 取 content_block_delta 的 text_delta', () => {
    expect(extractStreamDelta('anthropic-messages', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } })).toBe('Hi');
    expect(extractStreamDelta('anthropic-messages', { type: 'message_start' })).toBe('');
  });

  it('openai-responses 取 response.output_text.delta', () => {
    expect(extractStreamDelta('openai-responses', { type: 'response.output_text.delta', delta: 'ok' })).toBe('ok');
    expect(extractStreamDelta('openai-responses', { type: 'response.created' })).toBe('');
  });

  it('buildRequest stream:true 三协议均写入 body.stream', () => {
    const base = { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm', system: 's', user: 'u', maxTokens: 10, temperature: 0.7 };
    expect(buildRequest({ ...base, stream: true }).body.stream).toBe(true);
    expect(buildRequest({ ...base, stream: true, protocol: 'anthropic-messages' }).body.stream).toBe(true);
    expect(buildRequest(base).body.stream).toBeUndefined();
  });
});
