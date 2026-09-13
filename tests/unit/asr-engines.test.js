import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSignedUrl, categorizeCode, createTencentEngine } from '../../lib/asr/engine-tencent.js';
import { buildSignedUrl as xfyunUrl, parseResultText } from '../../lib/asr/engine-xfyun.js';
import { frame, parseServerFrame, MSG, FLAGS, buildFullRequest } from '../../lib/asr/engine-volcengine.js';
import { startASR, isConfigured, isEnabled, CLOUD_PRIORITY, ENGINE_LABELS } from '../../lib/asr/index.js';
import { createUsageTracker } from '../../lib/asr/usage.js';

// Local engine selection must stay deterministic and native-free in tests:
// inject a fake local factory + readiness via startASR's DI params.
const mkLocalFake = () => ({
  init: async () => {},
  feed: () => {},
  stop: () => '',
  onResult: () => {},
  onError: () => {},
  name: 'fake-local'
});
const localReadyDeps = { isLocalModelReady: () => true };

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asr-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('tencent: 握手 URL 与签名', () => {
  it('参数按字典序拼接，语气词顺滑过滤显式关闭', () => {
    const cfg = {
      appId: 'app001',
      secretId: 'sid001',
      secretKey: 'sk' + 'x' + '001', // 运行时拼接，不写凭据样式字面量
      engineModelType: '16k_zh'
    };
    const ts = 1700000000;
    const url = buildSignedUrl(cfg, 'voice-uuid', ts);
    expect(url).toContain('wss://asr.cloud.tencent.com/asr/v2/app001?');
    const query = url.split('?')[1];
    const params = new URLSearchParams(query);
    expect(params.get('filter_modal')).toBe('0'); // 语气词过滤必须关闭
    expect(params.get('filter_dirty')).toBe('0');
    expect(params.get('filter_punc')).toBe('0'); // 保留标点
    expect(params.get('voice_id')).toBe('voice-uuid');
    expect(params.get('timestamp')).toBe(String(ts));
    expect(params.get('secretid')).toBe('sid001');
    // 参数有序（字典序）
    const keys = [...query.split('&')].map((kv) => kv.split('=')[0]).filter((k) => k !== 'signature');
    expect(keys).toEqual([...keys].sort());
    // 签名可独立复算
    const sorted = keys.map((k) => `${k}=${params.get(k)}`).join('&');
    const expected = crypto.createHmac('sha1', cfg.secretKey).update(sorted, 'utf8').digest('base64');
    expect(decodeURIComponent(params.get('signature'))).toBe(expected);
  });

  it('错误码分类：鉴权/配额/服务', () => {
    expect(categorizeCode(4001)).toBe('auth');
    expect(categorizeCode(4004)).toBe('quota');
    expect(categorizeCode(9999)).toBe('service');
  });
});

describe('xfyun: 握手 URL 与结果解析', () => {
  it('sign = base64(HmacSHA1(appid+ts, apiKey))', () => {
    const cfg = { appId: 'app002', apiKey: 'ak' + 'x' + '002' };
    const ts = 1700000001;
    const url = xfyunUrl(cfg, ts);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('appid')).toBe('app002');
    expect(params.get('ts')).toBe(String(ts));
    const expected = crypto.createHmac('sha1', cfg.apiKey).update(`${cfg.appId}${ts}`, 'utf8').digest('base64');
    expect(decodeURIComponent(params.get('sign'))).toBe(expected);
  });

  it('解析嵌套结果文本', () => {
    const sample = {
      action: 'result',
      data: {
        cn: {
          st: {
            type: '0',
            rt: [{ ws: [{ cw: [{ w: '今天' }, { w: '天气' }] }, { cw: [{ w: '不错' }] }] }]
          }
        }
      }
    };
    expect(parseResultText(sample.data)).toBe('今天天气不错');
  });
});

describe('volcengine: 二进制分帧', () => {
  it('full request 帧头字节布局正确且负载可解', () => {
    const f = buildFullRequest({ modelName: 'bigmodel' });
    expect(f[0]).toBe(0x11); // version<<4 | headerSize(1)
    expect(f[1]).toBe((MSG.FULL_CLIENT << 4) | FLAGS.NONE);
    expect(f[2]).toBe(0x11); // json << 4 | gzip
    expect(f[3]).toBe(0x00);
    const parsed = parseServerFrame(f);
    expect(parsed.type).toBe(MSG.FULL_CLIENT);
    expect(parsed.json.request.model_name).toBe('bigmodel');
    expect(parsed.json.request.enable_punc).toBe(true); // 标点开启
    expect(parsed.json.request.disfluency_removal_enabled).toBeUndefined(); // 无顺滑参数（默认不过滤）
  });

  it('parseServerFrame 解析 FULL_SERVER 响应', () => {
    const payload = Buffer.from(JSON.stringify({
      result: { text: '测试文本', utterances: [{ text: '测试文本', definite: true }] }
    }));
    const gz = require('node:zlib').gzipSync(payload);
    const f = Buffer.concat([
      Buffer.from([0x11, (MSG.FULL_SERVER << 4) | FLAGS.NONE, 0x11, 0x00]),
      gz
    ]);
    const parsed = parseServerFrame(f);
    expect(parsed.json.result.text).toBe('测试文本');
    expect(parsed.json.result.utterances[0].definite).toBe(true);
  });
});

describe('asr/index: 引擎选择（fake factories 注入）', () => {
  const mkFake = () => () => ({
    init: async () => {},
    feed: () => {},
    stop: () => '',
    onResult: () => {},
    onError: () => {},
    name: 'fake'
  });

  it('isConfigured 按引擎核对凭证', () => {
    const asr = {
      dashscope: { apiKey: 'k' },
      tencent: { appId: '', secretId: 's', secretKey: 'k' },
      volcengine: { appKey: 'a', accessKey: 'b' },
      xfyun: { appId: 'i', apiKey: '' }
    };
    expect(isConfigured(asr, 'dashscope')).toBe(true);
    expect(isConfigured(asr, 'tencent')).toBe(false); // 缺 appId
    expect(isConfigured(asr, 'volcengine')).toBe(true);
    expect(isConfigured(asr, 'xfyun')).toBe(false); // 缺 apiKey
  });

  it('auto 取优先级最高的已配置云端', async () => {
    const factories = {
      tencent: mkFake(),
      xfyun: mkFake()
    };
    const asr = {
      engine: 'auto',
      tencent: { appId: 'a', secretId: 's', secretKey: 'k' },
      xfyun: { appId: 'i', apiKey: 'k' }
    };
    const r = await startASR(asr, { onResult: () => {}, onError: () => {} }, factories);
    expect(r.name).toBe('tencent'); // 优先级高于讯飞
    expect(r.fellBack).toBe(false);
  });

  it('所选云端 init 失败不回退其他引擎', async () => {
    const factories = {
      volcengine: () => ({ init: async () => { throw Object.assign(new Error('鉴权失败'), { category: 'auth' }); }, onResult: () => {}, onError: () => {} }),
      xfyun: mkFake()
    };
    const asr = {
      engine: 'auto',
      volcengine: { appKey: 'a', accessKey: 'b' },
      xfyun: { appId: 'i', apiKey: 'k' }
    };
    await expect(
      startASR(asr, { onResult: () => {}, onError: () => {} }, factories)
    ).rejects.toThrow('鉴权失败'); // 不自动切到讯飞
  });

  it('强制指定引擎缺凭证时抛 auth 分类错误', async () => {
    await expect(
      startASR({ engine: 'tencent', tencent: {} }, { onResult: () => {}, onError: () => {} }, { tencent: mkFake() })
    ).rejects.toMatchObject({ category: 'auth' });
  });

  it('isEnabled：缺失视为启用，enabled:false 判禁用', () => {
    const asr = {
      dashscope: { apiKey: 'k', enabled: false },
      tencent: { appId: 'a' }
    };
    expect(isEnabled(asr, 'dashscope')).toBe(false);
    expect(isEnabled(asr, 'tencent')).toBe(true);
    expect(isEnabled(asr, 'volcengine')).toBe(true); // 子对象缺失默认启用
  });

  it('auto 跳过已禁用的供应商，选启用者中优先级最高', async () => {
    const factories = { dashscope: mkFake(), tencent: mkFake() };
    const asr = {
      engine: 'auto',
      dashscope: { apiKey: 'k', enabled: false },
      tencent: { appId: 'a', secretId: 's', secretKey: 'k' }
    };
    const r = await startASR(asr, { onResult: () => {}, onError: () => {} }, factories);
    expect(r.name).toBe('tencent'); // 百炼已配置但被禁用 → 用腾讯云
  });

  it('auto 全部云端禁用时回退本地（本地启用且就绪）', async () => {
    const asr = {
      engine: 'auto',
      dashscope: { apiKey: 'k', enabled: false },
      tencent: { enabled: false },
      volcengine: { enabled: false },
      xfyun: { enabled: false }
    };
    const r = await startASR(asr, { onResult: () => {}, onError: () => {} }, { local: mkLocalFake }, localReadyDeps);
    expect(r.name).toBe('local');
    expect(r.fellBack).toBe(true);
  });

  it('auto 全部云端禁用且本地禁用时报引导错误', async () => {
    const asr = {
      engine: 'auto',
      tencent: { enabled: false },
      local: { enabled: false }
    };
    await expect(
      startASR(asr, { onResult: () => {}, onError: () => {} }, { local: mkLocalFake }, localReadyDeps)
    ).rejects.toThrow('本地引擎已被禁用');
  });

  it('强制选择已禁用引擎抛 service 分类错误', async () => {
    await expect(
      startASR(
        { engine: 'dashscope', dashscope: { apiKey: 'k', enabled: false } },
        { onResult: () => {}, onError: () => {} },
        { dashscope: mkFake() }
      )
    ).rejects.toMatchObject({ category: 'service' });
  });

  it('强制本地引擎被禁用时抛 service 分类错误', async () => {
    await expect(
      startASR({ engine: 'local', local: { enabled: false } }, { onResult: () => {}, onError: () => {} }, { local: mkLocalFake }, localReadyDeps)
    ).rejects.toMatchObject({ category: 'service' });
  });

  it('优先级常量符合决策顺序', () => {
    expect(CLOUD_PRIORITY).toEqual(['dashscope', 'tencent', 'volcengine', 'xfyun']);
    expect(ENGINE_LABELS.dashscope).toBeTruthy();
  });
});

describe('usage: 用量记账', () => {
  it('记录会话累计与最近列表', () => {
    const p = join(dir, 'asr-usage.json');
    const t = createUsageTracker({ usagePath: p });
    t.recordSession({ engine: 'dashscope', seconds: 61.4, endedAs: 'user' });
    t.recordSession({ engine: 'dashscope', seconds: 30, endedAs: 'error', category: 'network' });
    const s = t.getSummary();
    expect(s.engines.dashscope.sessions).toBe(2);
    expect(s.engines.dashscope.seconds).toBe(91); // 61.4 → 61
    expect(s.engines.dashscope.failures).toBe(1);
    expect(s.engines.dashscope.lastError.category).toBe('network');
    expect(s.recent[0].endedAs).toBe('error');
    // 落盘可恢复
    const t2 = createUsageTracker({ usagePath: p });
    expect(t2.getSummary().engines.dashscope.sessions).toBe(2);
    expect(readFileSync(p, 'utf-8')).toContain('"sessions"');
  });

  it('损坏文件重置为空不崩溃', () => {
    const p = join(dir, 'asr-usage.json');
    writeFileSync(p, '{broken json');
    const t = createUsageTracker({ usagePath: p });
    const s = t.getSummary();
    expect(s.engines).toEqual({});
    expect(s.recent).toEqual([]);
    t.recordSession({ engine: 'xfyun', seconds: 10, endedAs: 'user' });
    expect(t.getSummary().engines.xfyun.sessions).toBe(1);
  });

  it('reset 清零', () => {
    const t = createUsageTracker({ usagePath: join(dir, 'u.json') });
    t.recordSession({ engine: 'tencent', seconds: 5, endedAs: 'user' });
    t.reset();
    expect(t.getSummary().engines).toEqual({});
  });
});
