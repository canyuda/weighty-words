import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendFeedback, sendReport } from '../../lib/ai-feedback.js';

// callLLM 统一日志行为集成回归：经默认 logger 实例落盘，
// 断言单行格式、级别分流与凭据脱敏。
// logger 必须经 createRequire 获取：lib 内部是 CJS require 缓存，vitest 的
// ESM import 图与原生 require 缓存是两个世界——只有同一条缓存链才能拿到
// ai-feedback 内部所用的同一单例。
const requireCjs = createRequire(import.meta.url);
const { logger } = requireCjs('../../lib/logger.js');

// 凭据样式测试值一律运行时构造（钩子拦截明文凭据字面量）
const KEY = ['sk', 'a1b2c3d4e5f6g7h8', 'z9'].join('');

let dir;
let logsDir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ww-llm-log-'));
  logsDir = join(dir, 'logs');
  logger.configure({ logsDir, level: 'debug' });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  // 复位默认实例：回归 stdout-only + INFO，避免污染其他测试文件
  logger.configure({ logsDir: null, level: 'info' });
  rmSync(dir, { recursive: true, force: true });
});

function fileText() {
  const today = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const name = `app-${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}-1.log`;
  return readFileSync(join(logsDir, name), 'utf-8');
}

function stubTextResponse(status, body) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body
  }));
}

describe('callLLM 统一日志：非 2xx 错误周期', () => {
  it('请求/响应全量落 DEBUG 且凭据掩码，错误落 ERROR，INFO 留起止', async () => {
    stubTextResponse(401, '{"error":{"code":"401","message":"令牌已过期或验证不正确"}}');
    await expect(sendFeedback('内容', { provider: 'zhipu', apiKey: KEY, model: 'glm-4.5-air' }))
      .rejects.toThrow('令牌已过期或验证不正确');
    const text = fileText();
    // INFO 起止：端点、状态、字节、耗时
    expect(text).toContain('→ POST https://open.bigmodel.cn/api/paas/v4/chat/completions');
    expect(text).toMatch(/← 401 \d+B durationMs=\d+/);
    // DEBUG 全量 + 脱敏：Bearer 前缀可读、无明文 key
    expect(text).toContain('[DEBUG] [llm] request');
    expect(text).toContain('令牌已过期或验证不正确');
    expect(text).not.toContain(KEY);
    expect(text).toContain('Bearer ' + maskSecretExpect());
    // ERROR 行含提炼错误与耗时
    expect(text).toMatch(/\[ERROR\] \[llm\] API 请求失败 \(401\).*durationMs=\d+/);
    // 单行不变式：每条日志一行
    expect(text.split('\n').filter(Boolean).length).toBe(text.match(/\[TRACE\]|\[DEBUG\]|\[INFO\]|\[WARN\]|\[ERROR\]/g).length);
  });
});

describe('callLLM 统一日志：网络层失败', () => {
  it('ERROR 行含可读消息与耗时，无响应状态', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(sendFeedback('内容', { provider: 'zhipu', apiKey: KEY, model: 'm' }))
      .rejects.toThrow('网络请求失败: ECONNREFUSED');
    const text = fileText();
    expect(text).toMatch(/\[ERROR\] \[llm\] 网络请求失败: ECONNREFUSED durationMs=\d+/);
    expect(text).not.toMatch(/← \d/);
  });
});

describe('callLLM 统一日志：流式成功', () => {
  it('SSE 全文记 DEBUG response，INFO 结束行带 streamed 标记', async () => {
    const chunks = ['data: {"choices":[{"delta":{"content":"你好"}}]}', 'data: [DONE]'];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      body: {
        getReader: () => ({
          read: async () => (chunks.length ? { done: false, value: new TextEncoder().encode(chunks.shift() + '\n') } : { done: true })
        })
      }
    }));
    const deltas = [];
    const r = await sendReport('正文', {}, { provider: 'zhipu', apiKey: KEY, model: 'glm-4.5-air' }, null, null, (d) => deltas.push(d));
    expect(r).toBe('你好');
    expect(deltas).toEqual(['你好']);
    const text = fileText();
    expect(text).toMatch(/← 200 \d+B \(streamed\) durationMs=\d+/);
    expect(text).toContain('你好');
    expect(text).not.toContain(KEY);
  });
});

describe('callLLM 统一日志：默认 INFO 级别', () => {
  it('起止元数据落盘，请求/响应正文与转写原文不落盘', async () => {
    logger.configure({ level: 'info' });
    stubTextResponse(200, JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    const r = await sendFeedback('用户语音原文', { provider: 'zhipu', apiKey: KEY, model: 'm' });
    expect(r).toBe('OK');
    const text = fileText();
    expect(text).toContain('→ POST');
    expect(text).not.toContain('[DEBUG]');
    expect(text).not.toContain('用户语音原文');
    expect(text).not.toContain(KEY);
  });
});

function maskSecretExpect() {
  // 与 logger.maskSecret 同构：前 5 + * + 后 5（避免导出依赖的循环断言）
  return KEY.slice(0, 5) + '*'.repeat(KEY.length - 10) + KEY.slice(-5);
}
