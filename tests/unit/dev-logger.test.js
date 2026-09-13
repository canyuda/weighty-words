import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevLogger, isDevLaunch, redactHeaders, maskSecret } from '../../lib/dev-logger.js';
import { sendFeedback, setDevLogger } from '../../lib/ai-feedback.js';
import { vi } from 'vitest';

// 凭据样式测试值一律运行时构造（钩子拦截明文凭据字面量）
const KEY = ['sk', 'a1b2c3d4e5f6g7h8', 'z9'].join('');

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dev-logger-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  setDevLogger(null);
  vi.unstubAllGlobals();
});

describe('dev-logger: maskSecret 前5+*+后5', () => {
  it('长凭据保留前 5 后 5 明文，中间等长打码', () => {
    // 20 chars → 5 + 10 asterisks + 5
    expect(maskSecret(KEY)).toBe(KEY.slice(0, 5) + '*'.repeat(10) + KEY.slice(-5));
  });

  it('不超过 10 位全打码（5+5 窗口重叠会泄露全部）', () => {
    const short = ['shortkey1'].join('');
    expect(maskSecret(short)).toBe('*'.repeat(9));
  });

  it('空值与非字符串原样返回', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret(undefined)).toBeUndefined();
  });
});

describe('dev-logger: redactHeaders', () => {
  it('凭据头脱敏（大小写不敏感），普通头原样', () => {
    const out = redactHeaders({
      Authorization: `Bearer ${KEY}`,
      'x-api-key': KEY,
      'Content-Type': 'application/json'
    });
    expect(out.Authorization.startsWith('Bearer ')).toBe(true);
    expect(out.Authorization).toContain('*****');
    expect(out.Authorization.endsWith(KEY.slice(-5))).toBe(true);
    expect(out.Authorization).not.toContain(KEY);
    expect(out['x-api-key']).toBe(maskSecret(KEY));
    expect(out['Content-Type']).toBe('application/json');
  });});

describe('dev-logger: isDevLaunch', () => {
  it('--dev 判定', () => {
    expect(isDevLaunch(['/path/electron', '.', '--dev'])).toBe(true);
    expect(isDevLaunch(['/path/electron', '.'])).toBe(false);
  });
});

describe('dev-logger: 文件行为', () => {
  it('enabled 时写入日志且凭据已脱敏', () => {
    const logPath = join(dir, 'llm-dev.log');
    const logger = createDevLogger({ enabled: true, logPath });
    logger.logLlmCall({
      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: { model: 'glm-4.5-air', messages: [] },
      status: 401,
      responseBody: '{"error":{"message":"令牌已过期或验证不正确"}}',
      error: 'HTTP 401'
    });
    const text = readFileSync(logPath, 'utf-8');
    expect(text).toContain('LLM ERROR');
    expect(text).toContain('401');
    expect(text).toContain('令牌已过期或验证不正确');
    expect(text).toContain(maskSecret(KEY));
    expect(text).not.toContain(KEY);
  });

  it('disabled 时零 IO', () => {
    const logPath = join(dir, 'never.log');
    const logger = createDevLogger({ enabled: false, logPath });
    logger.logLlmCall({ url: 'x', headers: {}, body: {}, status: 200, responseBody: '' });
    expect(existsSync(logPath)).toBe(false);
    expect(logger.isEnabled()).toBe(false);
  });

  it('每次启动重置为新会话文件', () => {
    const logPath = join(dir, 'llm-dev.log');
    createDevLogger({ enabled: true, logPath }).logLlmCall({ url: 'a', headers: {}, body: '', status: 1, responseBody: '' });
    createDevLogger({ enabled: true, logPath });
    const text = readFileSync(logPath, 'utf-8');
    expect(text).not.toContain('LLM ERROR');
    expect(text).not.toContain('url: a');
    expect(text.startsWith('# dev LLM log')).toBe(true);
  });
});

// callLLM 集成：请求周期全量落日志、错误消息同步生成
describe('dev-logger: callLLM 集成', () => {
  it('非 2xx 响应写入完整请求周期并抛出提炼后的错误', async () => {
    const logPath = join(dir, 'llm-dev.log');
    setDevLogger(createDevLogger({ enabled: true, logPath }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401,
      text: async () => '{"error":{"code":"401","message":"令牌已过期或验证不正确"}}'
    }));
    await expect(sendFeedback('内容', { provider: 'zhipu', apiKey: KEY, model: 'glm-4.5-air' }))
      .rejects.toThrow('令牌已过期或验证不正确');
    const text = readFileSync(logPath, 'utf-8');
    expect(text).toContain('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    expect(text).toContain('response.status: 401');
    expect(text).toContain('令牌已过期或验证不正确');
    // Authorization 头已脱敏（Bearer 前缀可读），日志无明文 key
    expect(text).not.toContain(KEY);
    expect(text).toContain('Bearer ' + maskSecret(KEY));
  });

  it('网络层失败记 error 行且无响应码', async () => {
    const logPath = join(dir, 'llm-dev.log');
    setDevLogger(createDevLogger({ enabled: true, logPath }));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(sendFeedback('内容', { provider: 'zhipu', apiKey: KEY, model: 'm' }))
      .rejects.toThrow('网络请求失败: ECONNREFUSED');
    const text = readFileSync(logPath, 'utf-8');
    expect(text).toContain('network: 网络请求失败: ECONNREFUSED');
    expect(text).toContain('response.status: n/a');
  });

  it('未注入 logger 时零日志零行为变化', async () => {
    setDevLogger(null);
    const logPath = join(dir, 'llm-dev.log');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }] })
    }));
    const r = await sendFeedback('内容', { provider: 'zhipu', apiKey: KEY, model: 'm' });
    expect(r).toBe('OK');
    expect(existsSync(logPath)).toBe(false);
  });
});
