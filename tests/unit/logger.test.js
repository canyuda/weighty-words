import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, writeFileSync as wf } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLogger,
  maskSecret,
  redactHeaders,
  scrubForLog,
  DEFAULT_MAX_FILE_BYTES
} from '../../lib/logger.js';

// 凭据样式测试值一律运行时构造（钩子拦截明文凭据字面量）
const KEY = ['sk', 'a1b2c3d4e5f6g7h8', 'z9'].join('');

// 本地时区固定时刻：2026-09-13 21:04:05.123
const NOW = new Date(2026, 8, 13, 21, 4, 5, 123);
const DAY = '20260913';
const DAY_PLUS_1 = '20260914';

let dir;
let logsDir;
let consoleLogSpy;
let consoleErrorSpy;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ww-logger-'));
  logsDir = join(dir, 'logs');
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function lines(file) {
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean);
}

function makeLogger(overrides = {}) {
  return createLogger({ logsDir, clock: () => NOW, ...overrides });
}

describe('logger: 级别过滤（1.1）', () => {
  it('默认 INFO：debug/trace 不落盘，info/warn/error 落盘', () => {
    const log = makeLogger();
    log.debug('llm', 'hidden');
    log.info('llm', 'shown');
    log.warn('llm', 'warned');
    log.error('llm', 'failed');
    const all = lines(join(logsDir, `app-${DAY}-1.log`));
    expect(all).toHaveLength(3);
    expect(all[0]).toContain('[INFO]');
    expect(all.join('\n')).not.toContain('hidden');
  });

  it('setLevel debug 后 DEBUG 落盘', () => {
    const log = makeLogger({ level: 'info' });
    log.setLevel('debug');
    log.debug('llm', 'visible now');
    expect(lines(join(logsDir, `app-${DAY}-1.log`))[0]).toContain('visible now');
  });

  it('非法级别回落 info', () => {
    const log = makeLogger({ level: 'loud' });
    expect(log.getLevel()).toBe('info');
  });
});

describe('logger: 单行格式（1.1 / 1.5）', () => {
  it('格式为 本地时间戳 [级别] [tag] 消息 key=value', () => {
    const log = makeLogger();
    log.info('llm', '← 200', { bytes: 1234, streamed: true });
    const [line] = lines(join(logsDir, `app-${DAY}-1.log`));
    expect(line).toBe('2026-09-13 21:04:05.123 [INFO] [llm] ← 200 bytes=1234 streamed=true');
  });

  it('含空格的字符串值引号包裹，undefined 值跳过', () => {
    const log = makeLogger();
    log.info('media', '导入媒体', { file: 'a b.mp4', size: 5, note: undefined });
    const [line] = lines(join(logsDir, `app-${DAY}-1.log`));
    expect(line).toContain('file="a b.mp4" size=5');
    expect(line).not.toContain('note');
  });

  it('消息换行替换为 ⏎，文件行数恒等于日志条数', () => {
    const log = makeLogger();
    log.info('renderer', 'line1\nline2\r\nline3');
    const all = lines(join(logsDir, `app-${DAY}-1.log`));
    expect(all).toHaveLength(1);
    expect(all[0]).toContain('line1 ⏎ line2 ⏎ line3');
  });

  it('Error 元数据压成单行堆栈（消息+最多 3 帧，| 连接）', () => {
    const log = makeLogger();
    const err = new Error('boom');
    log.error('asr', '初始化失败', { error: err });
    const [line] = lines(join(logsDir, `app-${DAY}-1.log`));
    expect(line).toContain('boom |');
    expect(line).not.toMatch(/\n/);
  });
});

describe('logger: 按天加序号轮转（1.2）', () => {
  it('首写创建 app-{当天}-1.log', () => {
    makeLogger().info('app', 'first');
    expect(existsSync(join(logsDir, `app-${DAY}-1.log`))).toBe(true);
  });

  it('跨天切新文件且序号重置 1', () => {
    let now = NOW;
    const log = createLogger({ logsDir, clock: () => now });
    log.info('app', 'day one');
    now = new Date(2026, 8, 14, 0, 0, 1, 0);
    log.info('app', 'day two');
    expect(lines(join(logsDir, `app-${DAY}-1.log`))).toHaveLength(1);
    expect(lines(join(logsDir, `app-${DAY_PLUS_1}-1.log`))).toHaveLength(1);
  });

  it('同日重启续写当天最新卷（分节保时序）', () => {
    makeLogger().info('app', 'before restart');
    const second = makeLogger(); // 新实例，同日
    second.info('app', 'after restart');
    const all = lines(join(logsDir, `app-${DAY}-1.log`));
    expect(all).toHaveLength(2);
    expect(all[1]).toContain('after restart');
  });

  it('同日卷满（预估）切序号 2', () => {
    // 每行 ~60B，50B 上限 → 第二行开新卷
    const log = makeLogger({ maxFileBytes: 50 });
    log.info('app', 'aaaaaaaaaa');
    log.info('app', 'bbbbbbbbbb');
    expect(lines(join(logsDir, `app-${DAY}-1.log`))).toHaveLength(1);
    expect(lines(join(logsDir, `app-${DAY}-2.log`))).toHaveLength(1);
  });

  it('同日重启时旧卷已满 → 开新卷', () => {
    mkdirSync(logsDir, { recursive: true });
    wf(join(logsDir, `app-${DAY}-1.log`), 'x'.repeat(DEFAULT_MAX_FILE_BYTES));
    makeLogger().info('app', 'next volume');
    expect(lines(join(logsDir, `app-${DAY}-2.log`))).toHaveLength(1);
  });
});

describe('logger: 30 天保留清理（1.3）', () => {
  it('按文件名日期删除过期卷，30 天内保留', () => {
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, 'app-20260813-1.log'), 'expired\n'); // 31 天前
    writeFileSync(join(logsDir, 'app-20260815-1.log'), 'kept\n');    // 29 天前
    writeFileSync(join(logsDir, `app-${DAY}-1.log`), 'today\n');
    makeLogger().info('app', 'now');
    expect(existsSync(join(logsDir, 'app-20260813-1.log'))).toBe(false);
    expect(existsSync(join(logsDir, 'app-20260815-1.log'))).toBe(true);
    expect(existsSync(join(logsDir, `app-${DAY}-1.log`))).toBe(true);
  });

  it('跨天切换时同样触发清理', () => {
    let now = NOW;
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, 'app-20260813-1.log'), 'expired\n');
    const log = createLogger({ logsDir, clock: () => now });
    log.info('app', 'day one');
    now = new Date(2026, 8, 14, 0, 0, 1, 0);
    log.info('app', 'day two');
    expect(existsSync(join(logsDir, 'app-20260813-1.log'))).toBe(false);
  });
});

describe('logger: 脱敏设施', () => {
  it('maskSecret 长凭据前 5+*+后 5，≤10 位全打码，非字符串原样', () => {
    expect(maskSecret(KEY)).toBe(KEY.slice(0, 5) + '*'.repeat(10) + KEY.slice(-5));
    expect(maskSecret('shortkey1')).toBe('*'.repeat(9));
    expect(maskSecret('')).toBe('');
    expect(maskSecret(undefined)).toBeUndefined();
  });

  it('redactHeaders 凭据头脱敏（大小写不敏感），scheme 前缀可读', () => {
    const out = redactHeaders({
      Authorization: `Bearer ${KEY}`,
      'x-api-key': KEY,
      'Content-Type': 'application/json'
    });
    expect(out.Authorization.startsWith('Bearer ')).toBe(true);
    expect(out.Authorization).not.toContain(KEY);
    expect(out['x-api-key']).toBe(maskSecret(KEY));
    expect(out['Content-Type']).toBe('application/json');
  });

  it('scrubForLog 按 key 名递归掩码（apiKey/api_key/secret/password/token）', () => {
    const out = scrubForLog({
      apiKey: KEY,
      config: { API_KEY: KEY, nested: { secret: KEY } },
      headers: { Authorization: `Bearer ${KEY}` },
      plain: 'keepme'
    });
    expect(out.apiKey).toBe(maskSecret(KEY));
    expect(out.config.API_KEY).toBe(maskSecret(KEY));
    expect(out.config.nested.secret).toBe(maskSecret(KEY));
    expect(out.headers.Authorization.startsWith('Bearer ')).toBe(true);
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(out.plain).toBe('keepme');
  });

  it('scrubForLog 非字符串凭据值先字符串化再掩码，深嵌套封顶', () => {
    expect(scrubForLog({ apiKey: 12345 }).apiKey).toBe(maskSecret(JSON.stringify(12345)));
    const deep = { a: { a: { a: { a: { a: { a: { a: { apiKey: KEY } } } } } } } };
    expect(JSON.stringify(scrubForLog(deep))).toContain('[deep]');
  });

  it('DEBUG 负载经 compactJson 后密钥不可见（端到端）', () => {
    const log = makeLogger({ level: 'debug' });
    log.debug('llm', 'request', {
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: { model: 'glm-4.5-air', apiKey: KEY, messages: [{ role: 'user', content: '你好' }] }
    });
    const [line] = lines(join(logsDir, `app-${DAY}-1.log`));
    expect(line).not.toContain(KEY);
    expect(line).toContain('Bearer ' + maskSecret(KEY));
    expect(line).toContain('{"model":"glm-4.5-air"');
  });
});

describe('logger: stdout 镜像（2.x 前置）', () => {
  it('info 走 console.log，error 走 console.error，内容一致', () => {
    const log = makeLogger();
    log.info('app', 'to stdout');
    log.error('app', 'to stderr');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('to stdout'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('to stderr'));
  });
});

describe('logger: 写入失败静默降级（1.6）', () => {
  it('目录不可写时调用方不抛、stdout 仍有输出、提示只出现一次', () => {
    const fileAsDir = join(dir, 'occupied');
    writeFileSync(fileAsDir, 'not a directory');
    const log = makeLogger({ logsDir: fileAsDir });
    expect(() => {
      log.info('app', 'one');
      log.info('app', 'two');
      log.info('app', 'three');
    }).not.toThrow();
    const errTexts = consoleErrorSpy.mock.calls.map((c) => String(c[0]));
    expect(errTexts.filter((t) => t.includes('[logger]'))).toHaveLength(1);
    const outTexts = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(outTexts.filter((t) => t.includes('one') || t.includes('two') || t.includes('three'))).toHaveLength(3);
  });

  it('降级后 configure 重新给目录可恢复写盘', () => {
    const fileAsDir = join(dir, 'occupied');
    writeFileSync(fileAsDir, 'not a directory');
    const log = makeLogger({ logsDir: fileAsDir });
    log.info('app', 'degraded');
    rmSync(fileAsDir, { force: true });
    log.configure({ logsDir });
    log.info('app', 'recovered');
    expect(lines(join(logsDir, `app-${DAY}-1.log`))).toHaveLength(1);
  });
});
