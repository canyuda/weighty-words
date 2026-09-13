import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendFeedback, sendReport, testConnection, resolveAnalyzerConfig, extractApiErrorMessage } from '../../lib/ai-feedback.js';

// 凭据样式测试值一律运行时构造
const tk = (name) => ['llm', name, 'token'].join('-');

function okFetch(content = 'OK') {
  return vi.fn().mockResolvedValue({
    ok: true,
    // callLLM 统一以 text() 读 body 后自行 parse
    text: async () => JSON.stringify({ choices: [{ message: { content } }] })
  });
}

function lastCall(mock) {
  const call = mock.mock.calls[mock.mock.calls.length - 1];
  return { url: call[0], init: call[1], body: JSON.parse(call[1].body) };
}

beforeEach(() => {
  vi.stubGlobal('fetch', okFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ai-feedback: 各 provider 端点解析', () => {
  const cases = [
    ['openai', { provider: 'openai', apiKey: tk('o') }, 'https://api.openai.com/v1/chat/completions', 'gpt-4o-mini'],
    ['deepseek', { provider: 'deepseek', apiKey: tk('d'), model: 'deepseek-reasoner' }, 'https://api.deepseek.com/v1/chat/completions', 'deepseek-reasoner'],
    ['zhipu', { provider: 'zhipu', apiKey: tk('z') }, 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'glm-4.6'],
    // 已移除预设的存量条目：自带 baseUrl 仍可用（条目主权）
    ['kimi(存量条目)', { provider: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', apiKey: tk('k'), model: 'kimi-k2-0905-preview' }, 'https://api.moonshot.cn/v1/chat/completions', 'kimi-k2-0905-preview'],
    ['minimax(存量条目)', { provider: 'minimax', baseUrl: 'https://api.minimaxi.com/v1', apiKey: tk('m'), model: 'MiniMax-Text-01' }, 'https://api.minimaxi.com/v1/chat/completions', 'MiniMax-Text-01'],
    ['mimo(存量条目)', { provider: 'mimo', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: tk('mm'), model: 'mimo-v2.5-pro' }, 'https://api.xiaomimimo.com/v1/chat/completions', 'mimo-v2.5-pro']
  ];

  for (const [name, settings, url, model] of cases) {
    it(`${name} 端点与默认模型正确`, async () => {
      const mock = okFetch();
      vi.stubGlobal('fetch', mock);
      const result = await sendFeedback('内容', settings);
      expect(result).toBe('OK');
      const { url: gotUrl, body } = lastCall(mock);
      expect(gotUrl).toBe(url);
      expect(body.model).toBe(model);
    });
  }

  it('ollama 走自定义本地地址且免真实 Key', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    await sendFeedback('内容', { provider: 'ollama', ollamaUrl: 'http://192.168.1.5:11434' });
    const { url, init, body } = lastCall(mock);
    expect(url).toBe('http://192.168.1.5:11434/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer ollama');
    expect(body.model).toBe('qwen2.5:7b');
  });

  it('custom 端点为 baseUrl 去尾斜杠后拼接 /chat/completions', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    await sendFeedback('内容', { provider: 'custom', baseUrl: 'https://api.example.com/v1///', apiKey: tk('c'), model: 'my-model' });
    const { url, init, body } = lastCall(mock);
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe(`Bearer ${tk('c')}`);
    expect(body.model).toBe('my-model');
  });

  it('resolveAnalyzerConfig：custom 携带协议字段（缺省 openai-chat），内置固定 openai-chat；条目 baseUrl 优先', () => {
    expect(resolveAnalyzerConfig({ provider: 'custom', baseUrl: 'https://api.example.com/v1' }).protocol).toBe('openai-chat');
    expect(
      resolveAnalyzerConfig({ provider: 'custom', baseUrl: 'https://api.example.com/v1', protocol: 'anthropic-messages' }).protocol
    ).toBe('anthropic-messages');
    expect(resolveAnalyzerConfig({ provider: 'deepseek', apiKey: tk('k') }).protocol).toBe('openai-chat');
    // 已移除预设且无 baseUrl 的存量形态 → 显式报错
    expect(() => resolveAnalyzerConfig({ provider: 'kimi', apiKey: tk('k') })).toThrow(/未知/);
    // 条目自带 baseUrl 优先于预设（支撑中转地址）
    expect(resolveAnalyzerConfig({ provider: 'deepseek', baseUrl: 'https://relay.example.com/v1' }).baseUrl).toBe('https://relay.example.com/v1');
  });

  it('custom 端点命中私有/保留地址时直接抛错（不发请求）', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    await expect(
      sendFeedback('内容', { provider: 'custom', baseUrl: 'http://192.168.1.10/v1', apiKey: tk('c') })
    ).rejects.toThrow(/私有|保留/);
    expect(mock).not.toHaveBeenCalled();
  });

  it('ollama 内置 provider 的本地地址豁免端点校验', () => {
    expect(() => resolveAnalyzerConfig({ provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434' })).not.toThrow();
  });

  it('未知 provider 抛错', async () => {
    await expect(sendFeedback('内容', { provider: 'nope', apiKey: 'x' })).rejects.toThrow(/未知/);
  });
});

describe('ai-feedback: 请求体契约', () => {
  it('实时反馈：system+user 两条消息，max_tokens=150，temperature=0.7，带 Bearer 头', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    await sendFeedback('内容', { provider: 'deepseek', apiKey: 'sk', model: 'deepseek-chat' });
    const { init, body } = lastCall(mock);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Authorization).toBe('Bearer sk');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('内容');
    expect(body.max_tokens).toBe(150);
    expect(body.temperature).toBe(0.7);
  });

  it('报告：max_tokens=8192 且 user 含统计', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    const stats = { duration: 30, totalWords: 50, fillers: 2, hedges: 1, vagueWords: 3 };
    await sendReport('全文', stats, { provider: 'deepseek', apiKey: 'sk', model: 'm' });
    const { body } = lastCall(mock);
    expect(body.max_tokens).toBe(8192);
    expect(body.messages[1].content).toContain('30秒');
    expect(body.messages[1].content).toContain('50字');
  });
});

describe('ai-feedback: 错误分支', () => {
  it('非 2xx 抛出含状态码的错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }));
    await expect(sendFeedback('内容', { provider: 'deepseek', apiKey: 'k', model: 'm' })).rejects.toThrow(/500/);
  });

  it('testConnection 成功', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    const r = await testConnection({ provider: 'deepseek', apiKey: 'k', model: 'm' });
    expect(r.success).toBe(true);
    const { body } = lastCall(mock);
    expect(body.max_tokens).toBe(2);
    expect(body.temperature).toBe(0);
  });

  it('testConnection 失败返回 success:false 与状态码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' }));
    const r = await testConnection({ provider: 'deepseek', apiKey: 'k', model: 'm' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('401');
  });

  it('testConnection 网络异常返回 success:false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await testConnection({ provider: 'deepseek', apiKey: 'k', model: 'm' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('连接失败');
  });

  it('testConnection 缺端点直接失败不发请求', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    const r = await testConnection({ provider: 'custom', baseUrl: '' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('端点地址未配置');
    expect(mock).not.toHaveBeenCalled();
  });
});

// 错误 body 提炼：只留人类可读 message，避免整段 JSON 灌进设置页错误条
describe('ai-feedback: extractApiErrorMessage', () => {
  it('openai 风格 {"error":{"message"}} 取内层 message', () => {
    expect(extractApiErrorMessage('{"error":{"code":"401","message":"令牌已过期或验证不正确"}}')).toBe('令牌已过期或验证不正确');
  });

  it('anthropic 风格顶层 {"message"} 直接取', () => {
    expect(extractApiErrorMessage('{"type":"error","message":"invalid x-api-key"}')).toBe('invalid x-api-key');
  });

  it('未知 JSON 结构与非 JSON body 回退截断原文', () => {
    expect(extractApiErrorMessage('{"foo":1}')).toBe('{"foo":1}');
    expect(extractApiErrorMessage('<html>Bad Gateway</html>')).toBe('<html>Bad Gateway</html>');
    expect(extractApiErrorMessage('x'.repeat(300)).length).toBe(160);
  });

  it('内层 message 超长同样截断', () => {
    const long = 'm'.repeat(300);
    expect(extractApiErrorMessage(JSON.stringify({ error: { message: long } }))).toBe('m'.repeat(160));
  });

  it('callLLM 非 2xx 错误消息为提炼后的短句', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401,
      text: async () => '{"error":{"code":"401","message":"令牌已过期或验证不正确"}}'
    }));
    await expect(sendFeedback('内容', { provider: 'zhipu', apiKey: 'k', model: 'm' }))
      .rejects.toThrow('API 请求失败 (401): 令牌已过期或验证不正确');
  });
});

describe('ai-feedback: 请求超时保护（报告卡死根因回归）', () => {
  /** 永不自行完成的 fetch：仅响应 signal 中断（连接挂起形态） */
  function hangingFetch() {
    return vi.fn((url, init) => new Promise((_, reject) => {
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      }
      // 无 signal：永远悬着，正好暴露回归
    }));
  }

  afterEach(() => { vi.useRealTimers(); });

  it('sendFeedback/sendReport 缺省注入 AbortSignal，llmParams 可覆盖', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    await sendFeedback('内容', { provider: 'zhipu', apiKey: tk('a'), model: 'm' });
    expect(lastCall(mock).init.signal).toBeInstanceOf(AbortSignal);

    const mock2 = okFetch();
    vi.stubGlobal('fetch', mock2);
    await sendReport('全文', { totalWords: 10 }, { provider: 'zhipu', apiKey: tk('b'), model: 'm' }, { reportTimeoutMs: 1234 });
    expect(lastCall(mock2).init.signal).toBeInstanceOf(AbortSignal);
  });

  it('端点挂起时按超时中断并抛人话错误（连接期挂起）', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    await expect(sendReport('全文', {}, { provider: 'zhipu', apiKey: tk('c'), model: 'm' }, { reportTimeoutMs: 50 }))
      .rejects.toThrow(/超时/);
  });

  it('响应体读取挂起同样被 signal 中断', async () => {
    vi.stubGlobal('fetch', vi.fn((url, init) => Promise.resolve({
      ok: true,
      status: 200,
      text: () => new Promise((_, reject) => {
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          });
        }
      })
    })));
    await expect(sendFeedback('内容', { provider: 'zhipu', apiKey: tk('d'), model: 'm' }, { realtimeTimeoutMs: 50 }))
      .rejects.toThrow(/超时/);
  });

  it('未传 timeoutMs 时不带 signal（向后兼容）', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    // testConnection 固定 15s 上限，设置页测试按钮不会无限转圈
    await testConnection({ provider: 'zhipu', apiKey: tk('e'), model: 'm' });
    expect(lastCall(mock).init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('ai-feedback: 思考型模型请求策略（空 content / 1210 根因回归）', () => {
  it('zhipu glm-4.6（可关闭思考）→ thinking:{type:disabled}', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    await sendFeedback('内容', { provider: 'zhipu', apiKey: tk('z1'), model: 'glm-4.6' });
    expect(lastCall(mock).body.thinking).toEqual({ type: 'disabled' });
    expect(lastCall(mock).body.reasoning_effort).toBeUndefined();
    expect(lastCall(mock).body.max_tokens).toBe(150);
  });

  it('zhipu glm-5.3（始终思考）→ enabled + reasoning_effort:low，实时预算抬到下限 1024', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    await sendFeedback('内容', { provider: 'zhipu', apiKey: tk('z2'), model: 'glm-5.3' });
    expect(lastCall(mock).body.thinking).toEqual({ type: 'enabled' });
    expect(lastCall(mock).body.reasoning_effort).toBe('low');
    expect(lastCall(mock).body.max_tokens).toBe(1024);
  });

  it('glm-5.3 用户显式调大实时预算时取更大者', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    await sendFeedback('内容', { provider: 'zhipu', apiKey: tk('z3'), model: 'glm-5.3' }, { realtimeMaxTokens: 2048 });
    expect(lastCall(mock).body.max_tokens).toBe(2048);
  });

  it('报告 glm-5.3 沿用 8192 预算（effort low 下推理很短）', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    await sendReport('全文', {}, { provider: 'zhipu', apiKey: tk('z4'), model: 'glm-5.3' });
    expect(lastCall(mock).body.reasoning_effort).toBe('low');
    expect(lastCall(mock).body.max_tokens).toBe(8192);
  });

  it('openai/ollama 请求体不带 thinking 字段（参数仅确认支持的端点使用）', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    await sendFeedback('内容', { provider: 'openai', apiKey: tk('o1'), model: 'gpt-4o-mini' });
    expect(lastCall(mock).body.thinking).toBeUndefined();

    const mock2 = okFetch();
    vi.stubGlobal('fetch', mock2);
    await sendFeedback('内容', { provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434' });
    expect(lastCall(mock2).body.thinking).toBeUndefined();
  });
});

describe('ai-feedback: SSE 流式报告（onDelta 回调）', () => {
  /** SSE 响应桩：body 为 web ReadableStream，按块输出 data: 行 */
  function sseFetch(events, { chunkSize = 1 } = {}) {
    const encoder = new TextEncoder();
    const sseText = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
    let offset = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (offset >= sseText.length) { controller.close(); return; }
        const slice = sseText.slice(offset, offset + chunkSize);
        offset += chunkSize;
        controller.enqueue(encoder.encode(slice));
      }
    });
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      body: stream,
      text: async () => { throw new Error('should not read whole text in stream mode'); }
    });
  }

  it('sendReport 流式：增量逐段回调，返回累积全文，请求体带 stream:true', async () => {
    const mock = sseFetch([
      { choices: [{ delta: { content: '## 总评\n' } }] },
      { choices: [{ delta: { reasoning_content: '思考（不上屏）' } }] },
      { choices: [{ delta: { content: '结构清晰' } }] },
      { choices: [{ delta: {} }] }
    ], { chunkSize: 7 }); // 强制跨块切分 SSE 行，验证缓冲拼行
    vi.stubGlobal('fetch', mock);
    const pieces = [];
    const result = await sendReport('全文', {}, { provider: 'zhipu', apiKey: tk('sse'), model: 'm' }, {}, null, (d) => pieces.push(d));
    expect(result).toBe('## 总评\n结构清晰');
    expect(pieces).toEqual(['## 总评\n', '结构清晰']);
    const { init, body } = lastCall(mock);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(body.stream).toBe(true);
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('服务端忽略 stream 返回整包 JSON：回退非流式解析，onDelta 不触发', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ choices: [{ message: { content: '整包报告' } }] })
    }));
    const pieces = [];
    const result = await sendReport('全文', {}, { provider: 'zhipu', apiKey: tk('sse2'), model: 'm' }, {}, null, (d) => pieces.push(d));
    expect(result).toBe('整包报告');
    expect(pieces).toEqual([]);
  });

  it('实时反馈路径不传 onDelta：不带 stream，行为不变', async () => {
    const mock = okFetch();
    vi.stubGlobal('fetch', mock);
    await sendFeedback('内容', { provider: 'zhipu', apiKey: tk('sse3'), model: 'm' });
    expect(lastCall(mock).body.stream).toBeUndefined();
  });
});
