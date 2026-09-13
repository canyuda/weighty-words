import { describe, it, expect, vi } from 'vitest';
const {
  SLICE_SAMPLES,
  SAMPLE_RATE,
  MAX_DURATION_SECONDS,
  MAX_FILE_BYTES,
  formatClock,
  validateFileSize,
  validateDuration,
  floatToInt16,
  mapDecodeError,
  createFileFeeder,
  createAuditionPlayer
} = require('../../src/media-file-feeder.js');

/**
 * Deterministic fake clock: setTimeout registers timers on a virtual
 * timeline; advance() fires every due timer in order, letting chained
 * ticks (feeder rescheduling) run to exhaustion within the window.
 */
function fakeClock() {
  let now = 0;
  let seq = 0;
  let timers = [];
  const setTimeoutFn = (fn, ms) => {
    const t = { id: ++seq, fn, at: now + Math.max(0, ms) };
    timers.push(t);
    return t.id;
  };
  const clearTimeoutFn = (id) => { timers = timers.filter((t) => t.id !== id); };
  const nowFn = () => now;
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t.id !== due.id);
      now = Math.max(now, due.at);
      due.fn();
    }
    now = until;
  };
  const pendingCount = () => timers.length;
  return { advance, nowFn, setTimeoutFn, clearTimeoutFn, pendingCount };
}

/** Recording feedChunk stub: keeps chunks and whether they are all-silence */
function stubFeed() {
  const chunks = [];
  return {
    chunks,
    feedChunk: (int16) => chunks.push(int16),
    silenceCount: () => chunks.filter((c) => c.length && Array.prototype.every.call(c, (v) => v === 0)).length
  };
}

function oneSecondSamples() {
  return new Float32Array(SAMPLE_RATE).fill(0.5);
}

describe('media-file-feeder: 校验纯函数', () => {
  it('体积上限：恰好 500MB 通过，超一字节拒绝', () => {
    expect(validateFileSize(MAX_FILE_BYTES).ok).toBe(true);
    const over = validateFileSize(MAX_FILE_BYTES + 1);
    expect(over.ok).toBe(false);
    expect(over.code).toBe('too_large');
    expect(over.message).toContain('500');
  });

  it('时长上限：恰好 10 分钟通过，超限拒绝', () => {
    expect(validateDuration(MAX_DURATION_SECONDS).ok).toBe(true);
    const over = validateDuration(MAX_DURATION_SECONDS + 0.5);
    expect(over.ok).toBe(false);
    expect(over.code).toBe('too_long');
    expect(over.message).toContain('10');
  });

  it('formatClock 输出 mm:ss', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(75)).toBe('01:15');
    expect(formatClock(600)).toBe('10:00');
  });

  it('mapDecodeError 返回人话提示（不暴露内部错误细节）', () => {
    const msg = mapDecodeError(new Error('Decoding failed: 0xdeadbeef'));
    expect(msg).toContain('无法读取音频轨');
  });
});

describe('media-file-feeder: floatToInt16', () => {
  it('映射并钳制到 Int16 范围', () => {
    const out = floatToInt16(new Float32Array([0, 1, -1, 0.5, -0.5, 2, -2]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(32767);
    expect(out[2]).toBe(-32768);
    expect(Math.abs(out[3] - 16384)).toBeLessThanOrEqual(1);
    expect(Math.abs(out[4] + 16384)).toBeLessThanOrEqual(1);
    expect(out[5]).toBe(32767); // clamp
    expect(out[6]).toBe(-32768); // clamp
  });
});

describe('media-file-feeder: 1x 实时节奏', () => {
  it('按 256ms 节奏切片喂入，末尾补短块，播完触发 onEnded', () => {
    const clock = fakeClock();
    const feed = stubFeed();
    const events = { progress: [], ended: 0 };
    const feeder = createFileFeeder({
      samples: oneSecondSamples(),
      feedChunk: feed.feedChunk,
      onProgress: (p, t) => events.progress.push([p, t]),
      onEnded: () => { events.ended += 1; },
      ...clock
    });
    feeder.start();
    clock.advance(0);
    expect(feed.chunks).toHaveLength(1);
    clock.advance(256);
    expect(feed.chunks).toHaveLength(2);
    clock.advance(256 * 3);
    expect(feed.chunks).toHaveLength(4);
    expect(feed.chunks.map((c) => c.length)).toEqual([4096, 4096, 4096, 3712]);
    expect(events.ended).toBe(1);
    expect(events.progress.at(-1)).toEqual([1, 1]);
    expect(clock.pendingCount()).toBe(0);
    expect(feeder.isStopped).toBe(true);
  });

  it('落后于文件时钟时立即追赶（漂移校正，不丢数据）', () => {
    const clock = fakeClock();
    const feed = stubFeed();
    let ended = 0;
    const feeder = createFileFeeder({ samples: oneSecondSamples(), feedChunk: feed.feedChunk, onEnded: () => { ended += 1; }, ...clock });
    feeder.start();
    clock.advance(0);
    expect(feed.chunks).toHaveLength(1);
    // 一次跳进 5 秒墙钟：追赶块应全部立即出完，无需逐 256ms 推进
    clock.advance(5000);
    expect(ended).toBe(1);
    expect(feed.chunks.reduce((n, c) => n + c.length, 0)).toBe(SAMPLE_RATE);
  });

  it('暂停期发静音帧保活且文件指针不动，恢复后从暂停点续喂', () => {
    const clock = fakeClock();
    const feed = stubFeed();
    const feeder = createFileFeeder({ samples: oneSecondSamples(), feedChunk: feed.feedChunk, ...clock });
    feeder.start();
    clock.advance(0);      // chunk1 (0-4096)
    clock.advance(256);    // chunk2 (4096-8192)
    const fedBeforePause = feed.chunks.length;
    const playedBeforePause = feeder.playedSeconds;
    feeder.pause();
    clock.advance(1000);   // silence keep-alive ticks
    expect(feed.chunks.length).toBeGreaterThan(fedBeforePause);
    expect(feed.silenceCount()).toBe(feed.chunks.length - fedBeforePause);
    expect(feeder.playedSeconds).toBe(playedBeforePause);
    const silencesBeforeResume = feed.silenceCount();
    feeder.resume();
    clock.advance(256);
    expect(feed.silenceCount()).toBe(silencesBeforeResume); // 无新增静音
    expect(feeder.playedSeconds).toBeGreaterThan(playedBeforePause);
    // 恢复后的首个文件块 = 样本指针处的原始内容
    const expected = floatToInt16(oneSecondSamples().subarray(8192, 8192 + 4096));
    const resumed = feed.chunks.find((c, i) => i >= fedBeforePause + silencesBeforeResume);
    expect(Array.from(resumed)).toEqual(Array.from(expected));
  });

  it('停止后不再喂入、无残留定时器', () => {
    const clock = fakeClock();
    const feed = stubFeed();
    const feeder = createFileFeeder({ samples: oneSecondSamples(), feedChunk: feed.feedChunk, ...clock });
    feeder.start();
    clock.advance(0);
    feeder.stop();
    clock.advance(2000);
    expect(feed.chunks).toHaveLength(1);
    expect(clock.pendingCount()).toBe(0);
  });

  it('重复 start 为无操作，未暂停时 resume 为无操作', () => {
    const clock = fakeClock();
    const feed = stubFeed();
    const feeder = createFileFeeder({ samples: oneSecondSamples(), feedChunk: feed.feedChunk, ...clock });
    feeder.start();
    feeder.start();
    clock.advance(0);
    expect(feed.chunks).toHaveLength(1);
    feeder.resume();
    expect(feeder.isPaused).toBe(false);
    feeder.pause();
    feeder.pause();
    clock.advance(256);
    expect(feed.silenceCount()).toBe(1);
  });
});

/** AudioContext 桩：记录 buffer 重建与源节点 start(when, offset) 调用 */
function stubAudioContextCtor() {
  const ctx = { buffers: [], sources: [], closed: false, destination: { id: 'destination' } };
  const Ctor = vi.fn(function () {
    this.createBuffer = (channels, length, rate) => {
      const b = { channels, length, rate, copied: null, copyToChannel(data) { this.copied = data; } };
      ctx.buffers.push(b);
      return b;
    };
    this.createBufferSource = () => {
      const s = {
        buffer: null, connectedTo: null, startCalls: [], stopped: false,
        connect(dst) { this.connectedTo = dst; },
        start(when, offset) { this.startCalls.push([when, offset]); },
        stop() { this.stopped = true; }
      };
      ctx.sources.push(s);
      return s;
    };
    this.destination = ctx.destination;
    this.close = () => { ctx.closed = true; };
  });
  return { Ctor, ctx };
}

describe('media-file-feeder: 试听外放（createAuditionPlayer）', () => {
  it('start 重建 buffer 并从喂入指针偏移起播', () => {
    const { Ctor, ctx } = stubAudioContextCtor();
    const samples = oneSecondSamples();
    const player = createAuditionPlayer({ samples, getOffsetSeconds: () => 0.512, AudioContextCtor: Ctor });
    player.start();
    expect(ctx.buffers).toHaveLength(1);
    expect(ctx.buffers[0].copied).toBe(samples); // 同一份 16k 样本
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0].startCalls).toEqual([[0, 0.512]]);
    expect(ctx.sources[0].connectedTo).toBe(ctx.destination);
  });

  it('恢复时以喂入指针重锚（新源从 playedSeconds 起播），与喂入器联动', () => {
    const clock = fakeClock();
    const feed = stubFeed();
    const feeder = createFileFeeder({ samples: oneSecondSamples(), feedChunk: feed.feedChunk, ...clock });
    const { Ctor, ctx } = stubAudioContextCtor();
    const player = createAuditionPlayer({ samples: oneSecondSamples(), getOffsetSeconds: () => feeder.playedSeconds, AudioContextCtor: Ctor });

    feeder.start();
    player.start();
    clock.advance(0);
    clock.advance(256);
    clock.advance(256); // 已喂 3 块 = 0.768s
    expect(feeder.playedSeconds).toBeCloseTo(0.768, 3);

    feeder.pause();
    player.pause();
    expect(ctx.sources[0].stopped).toBe(true);
    clock.advance(1000); // 暂停期喂静音帧，试听指针不动

    feeder.resume();
    player.resume();
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1].startCalls).toEqual([[0, 0.768]]); // 重锚到暂停点
  });

  it('暂停幂等、未暂停 resume 不出双源、stop 终态不可复活', () => {
    const { Ctor, ctx } = stubAudioContextCtor();
    const player = createAuditionPlayer({ samples: oneSecondSamples(), getOffsetSeconds: () => 0, AudioContextCtor: Ctor });
    player.pause(); // 未 start 时暂停：无操作
    expect(ctx.sources).toHaveLength(0);
    player.start();
    player.resume(); // 在播时 resume：无操作
    expect(ctx.sources).toHaveLength(1);
    player.pause();
    player.resume();
    expect(ctx.sources).toHaveLength(2);
    player.stop();
    expect(ctx.closed).toBe(true);
    player.resume();
    player.start();
    expect(ctx.sources).toHaveLength(2); // 终态后无新增源
    expect(player).toBeDefined();
  });
});
