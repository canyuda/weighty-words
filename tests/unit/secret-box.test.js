import { describe, it, expect } from 'vitest';
import {
  MASK_CHAR,
  MASK_CORE,
  isMasked,
  maskKey,
  mergeMaskedSecrets,
  mergeMaskedAnalyzerEntry,
  transformSecrets
} from '../../lib/secret-box.js';
import { defaultSettings } from '../../lib/settings.js';

// Key 值一律运行时构造，不写凭据样式字面量
const k = (name) => ['unit', name, 'token'].join('-');

function entry(overrides = {}) {
  return {
    id: 'an-1',
    provider: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    protocol: 'openai-chat',
    models: ['deepseek-chat'],
    primaryModel: 'deepseek-chat',
    ...overrides
  };
}

function fixture() {
  const s = defaultSettings();
  s.analysis.entries = [
    entry({ id: 'an-1', apiKey: k('deepseek') }),
    entry({ id: 'an-2', provider: 'zhipu', name: '智谱 GLM', apiKey: '' })
  ];
  s.asr.dashscope.apiKey = k('cloud');
  return s;
}

describe('secret-box: 掩码格式（前5 + 8• + 后5）', () => {
  it('常规长度 Key：前 5 位与后 5 位明文，中间固定 8 个掩码符', () => {
    const v = k('deepseek'); // 19 字符
    expect(maskKey(v)).toBe(v.slice(0, 5) + MASK_CORE + v.slice(-5));
    expect(maskKey(v)).not.toContain(v.slice(5, -5)); // 中段不可见
  });

  it('短 Key（< 11 位）全部打点，不泄露任何字符', () => {
    expect(maskKey('abc')).toBe(MASK_CORE);
    expect(maskKey('short-key9')).toBe(MASK_CORE); // 恰好 10 位
    expect(maskKey('short-key99')).not.toBe(MASK_CORE); // 11 位起显示两端
  });

  it('固定 8 个掩码符，不泄露真实长度', () => {
    const m14 = maskKey(k('a1'));
    const m30 = maskKey(k('a').repeat(30));
    expect(m14.length).toBe(5 + 8 + 5);
    expect(m30.length).toBe(5 + 8 + 5);
  });

  it('空值掩码为空串；isMasked 以是否含 • 判定（真实 Key 字符集不含 •）', () => {
    expect(maskKey('')).toBe('');
    expect(isMasked(maskKey(k('deepseek')))).toBe(true);
    expect(isMasked(k('plain'))).toBe(false);
    expect(isMasked('')).toBe(false);
  });
});

describe('secret-box: 掩码合并协议（条目 + ASR 槽位）', () => {
  it('掩码值保留存储中的原 Key，新值直接生效（按条目 id 配对）', () => {
    const current = fixture(); // 明文态（内存缓存）
    const incoming = fixture();
    incoming.analysis.entries[0].apiKey = maskKey(k('deepseek')); // 用户未改 → 掩码
    incoming.analysis.entries[1].apiKey = k('brand-new'); // 用户新输入
    incoming.asr.dashscope.apiKey = maskKey(k('cloud')); // 用户未改

    mergeMaskedSecrets(incoming, current);
    expect(incoming.analysis.entries[0].apiKey).toBe(k('deepseek'));
    expect(incoming.analysis.entries[1].apiKey).toBe(k('brand-new'));
    expect(incoming.asr.dashscope.apiKey).toBe(k('cloud'));
  });

  it("'' 表示显式清除（清除按钮 / 清空输入）", () => {
    const current = fixture();
    const incoming = fixture();
    incoming.asr.dashscope.apiKey = '';
    incoming.analysis.entries[0].apiKey = '';
    mergeMaskedSecrets(incoming, current);
    expect(incoming.asr.dashscope.apiKey).toBe('');
    expect(incoming.analysis.entries[0].apiKey).toBe('');
  });

  it('掩码 Key 在存储侧找不到配对条目时归空（新条目不应带掩码入库）', () => {
    const current = fixture();
    const incoming = { analysis: { entries: [entry({ id: 'an-new', apiKey: MASK_CHAR + 'x' })] } };
    mergeMaskedSecrets(incoming, current);
    expect(incoming.analysis.entries[0].apiKey).toBe('');
  });
});

describe('secret-box: mergeMaskedAnalyzerEntry 单条目合并', () => {
  it('掩码按 id 配对保留原 Key；新条目掩码归空；明文原样', () => {
    const current = [entry({ id: 'an-1', apiKey: k('deepseek') })];
    expect(mergeMaskedAnalyzerEntry(entry({ id: 'an-1', apiKey: maskKey(k('deepseek')) }), current).apiKey).toBe(k('deepseek'));
    expect(mergeMaskedAnalyzerEntry(entry({ id: 'an-2', apiKey: maskKey(k('x')) }), current).apiKey).toBe('');
    expect(mergeMaskedAnalyzerEntry(entry({ id: 'an-2', apiKey: k('fresh') }), current).apiKey).toBe(k('fresh'));
  });
});

describe('secret-box: transformSecrets 槽位遍历', () => {
  it('覆盖全部分析条目与 ASR 凭据槽位', () => {
    const s = fixture();
    s.asr.tencent.secretKey = k('tencent');
    s.asr.volcengine.accessKey = k('volc');
    s.asr.xfyun.apiKey = k('xfyun');
    const seen = [];
    transformSecrets(s, (v) => { seen.push(v); return v; });
    expect(seen).toEqual(expect.arrayContaining([
      k('deepseek'), k('cloud'), k('tencent'), k('volc'), k('xfyun')
    ]));
    expect(seen).toHaveLength(5); // an-2 条目 Key 为空不入遍历
  });

  it('plaintextSeen 标记未掩码的明文残留', () => {
    const s = fixture();
    const r1 = transformSecrets(s, (v) => v); // 恒等 → 明文残留
    expect(r1.plaintextSeen).toBe(true);
    const r2 = transformSecrets(s, (v) => maskKey(v));
    expect(r2.plaintextSeen).toBe(false);
  });
});
