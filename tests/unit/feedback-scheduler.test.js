import { describe, it, expect, vi } from 'vitest';
const { createFeedbackScheduler, clampTriggerChars } = require('../../lib/feedback-scheduler.js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** send 桩：记录调用并返回可控的 deferred promise */
function stubSend() {
  const calls = [];
  const queue = [];
  const send = vi.fn((text, gen) => {
    const d = deferred();
    calls.push({ text, gen, d });
    queue.push(d);
    return d.promise;
  });
  return { send, calls };
}

describe('feedback-scheduler: 触发阈值', () => {
  it('默认阈值 30，达到即触发', () => {
    const { send, calls } = stubSend();
    const s = createFeedbackScheduler({ send });
    s.onFinal('甲'.repeat(29));
    expect(calls).toHaveLength(0);
    s.onFinal('甲'); // 累计 30
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe('甲'.repeat(30));
  });

  it('阈值可配置并钳制在 30-200', () => {
    const s = createFeedbackScheduler({ send: async () => {}, triggerChars: 100 });
    expect(s.triggerChars).toBe(100);
    expect(clampTriggerChars(10)).toBe(30);
    expect(clampTriggerChars(500)).toBe(200);
    expect(clampTriggerChars('abc')).toBe(30);
  });

  it('长文本只发送末尾 500 字窗口', () => {
    const { send, calls } = stubSend();
    const s = createFeedbackScheduler({ send });
    s.onFinal('乙'.repeat(800));
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe('乙'.repeat(500));
  });
});

describe('feedback-scheduler: 在途合并与代数防护', () => {
  it('在途期间触发只标记待办，完成后自动补发一次（不并发）', async () => {
    const { send, calls } = stubSend();
    const s = createFeedbackScheduler({ send });

    s.onFinal('丙'.repeat(30));
    expect(s.inFlight).toBe(true);
    expect(calls).toHaveLength(1);

    // 在途期间又积累 30 字 → 不发第二个请求
    s.onFinal('丁'.repeat(30));
    expect(calls).toHaveLength(1);

    // 第一个请求返回 → 自动补发，携带最新全文窗口（500 字内即全量 丙+丁）
    calls[0].d.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toBe('丙'.repeat(30) + '丁'.repeat(30));
    expect(s.generation).toBe(0); // 同会话代数不变
  });

  it('stop 后返回的在途响应作废（代数递增，不补发）', async () => {
    const { send, calls } = stubSend();
    const s = createFeedbackScheduler({ send });

    s.onFinal('戊'.repeat(30));
    const genBefore = s.generation;
    s.stop();
    expect(s.generation).toBe(genBefore + 1);

    calls[0].d.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1); // 无补发
  });

  it('reset 清空累积并作废在途', async () => {
    const { send, calls } = stubSend();
    const s = createFeedbackScheduler({ send });

    s.onFinal('己'.repeat(30));
    s.reset();
    calls[0].d.resolve();
    await Promise.resolve();
    await Promise.resolve();

    s.onFinal('庚'.repeat(29));
    expect(calls.filter((c) => c.text === '庚'.repeat(29))).toHaveLength(0);
    s.onFinal('庚'); // 新会话重新从 30 字触发
    expect(calls[calls.length - 1].text).toBe('庚'.repeat(30));
  });
});

describe('feedback-scheduler: 失败语义', () => {
  it('send 抛错不推进已喂长度，后续积累后可再次触发', async () => {
    const { send, calls } = stubSend();
    const s = createFeedbackScheduler({ send });

    s.onFinal('辛'.repeat(30));
    calls[0].d.reject(new Error('network'));
    await Promise.resolve();
    await Promise.resolve();

    // 失败后再积累 30 字 → 重新触发
    s.onFinal('辛'.repeat(30));
    expect(calls).toHaveLength(2);
  });

  it('paste 无条件立即触发一次', () => {
    const { send, calls } = stubSend();
    const s = createFeedbackScheduler({ send });
    s.paste('这是一段不足三十字的粘贴文本');
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe('这是一段不足三十字的粘贴文本');
  });
});
