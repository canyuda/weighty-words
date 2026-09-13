import { describe, it, expect, vi } from 'vitest';
import { createSettingsStore } from '../../lib/settings-store.js';
import { defaultSettings } from '../../lib/settings.js';

describe('settings-store: 串行化写入', () => {
  it('并发两次 update 均落盘，互不丢失', async () => {
    const initial = defaultSettings();
    initial.analysis.entries = [
      { id: 'e1', provider: 'deepseek', apiKey: '' },
      { id: 'e2', provider: 'zhipu', apiKey: '' }
    ];
    const saved = [];
    const store = createSettingsStore({
      load: () => initial,
      save: (s) => saved.push(s)
    });

    // 两个更新几乎同时发起，各自改不同字段
    const [a, b] = await Promise.all([
      store.update((s) => {
        s.analysis.entries[0].apiKey = 'A';
        return s;
      }),
      store.update((s) => {
        s.analysis.activeId = 'e2';
        return s;
      })
    ]);

    expect(saved).toHaveLength(2);
    // 第二次保存是最终状态，包含两次变更
    const finalState = saved[saved.length - 1];
    expect(finalState.analysis.entries[0].apiKey).toBe('A');
    expect(finalState.analysis.activeId).toBe('e2');
    expect(a.analysis.entries[0].apiKey).toBe('A');
    expect(b.analysis.activeId).toBe('e2');
  });

  it('写入串行：每次 update 基于上一次的结果', async () => {
    const counter = { n: 0 };
    const saved = [];
    const store = createSettingsStore({
      load: () => counter,
      save: (s) => saved.push(JSON.parse(JSON.stringify(s)))
    });

    await Promise.all([
      store.update((s) => {
        s.n += 1;
        return s;
      }),
      store.update((s) => {
        s.n += 1;
        return s;
      }),
      store.update((s) => {
        s.n += 1;
        return s;
      })
    ]);

    // 三次自增全部生效（非原子并发会丢失更新得到 1）
    expect(saved[saved.length - 1].n).toBe(3);
  });

  it('update 抛错时不落盘，且不阻塞后续 update', async () => {
    const saved = [];
    const store = createSettingsStore({
      load: () => ({ n: 0 }),
      save: (s) => saved.push(s)
    });

    await expect(
      store.update(() => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    await store.update((s) => {
      s.n = 7;
      return s;
    });
    expect(saved).toHaveLength(1);
    expect(saved[0].n).toBe(7);
  });

  it('get 缓存生效：写后读取的是最新对象', async () => {
    let stored = { n: 0 };
    const store = createSettingsStore({
      load: () => JSON.parse(JSON.stringify(stored)),
      save: (s) => {
        stored = s;
      }
    });
    expect(store.get().n).toBe(0);
    await store.update((s) => {
      s.n = 5;
      return s;
    });
    expect(store.get().n).toBe(5);
  });
});
