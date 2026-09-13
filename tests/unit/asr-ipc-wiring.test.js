import { describe, it, expect } from 'vitest';
const { ASRController, computeASRAvailability } = require('../../lib/ipc/asr.js');

/**
 * Regression guard for the 0c8bfea wiring bug: ASRController.start used to
 * pass the WHOLE settings object to startASR, whose contract is the
 * settings.asr sub-object — every cloud lookup read a nonexistent top-level
 * key and auto mode always fell back to local ("未配置云端识别") despite a
 * configured key. The stub startASR captures the config by identity.
 */
describe('ASRController.start → startASR 接线', () => {
  it('startASR 收到的是 settings.asr 子对象（同一引用），回调已接好', async () => {
    const asr = { engine: 'auto', dashscope: { apiKey: 'k', enabled: true }, local: { enabled: true } };
    const settings = { version: 2, asr, feedback: { triggerChars: 30 } };
    const captured = {};
    const fakeEngine = { onResult() {}, onError() {}, feed() {}, stop() {} };
    const controller = new ASRController({ usageTracker: null });

    const session = await controller.start(
      { settings, getMainWindow: () => null },
      {
        startASR: async (asrConfig, callbacks) => {
          captured.asrConfig = asrConfig;
          captured.callbacks = callbacks;
          return { name: 'dashscope', fellBack: false, engine: fakeEngine };
        }
      }
    );

    expect(captured.asrConfig).toBe(asr); // identity: the asr sub-object itself
    expect(session.name).toBe('dashscope');
    expect(typeof captured.callbacks.onResult).toBe('function');
    expect(typeof captured.callbacks.onError).toBe('function');
    // feed 透传到 session.engine
    controller.feed([1, 2, 3]);
    expect(controller.samples).toBe(3);
  });

  it('可用性判定与初始化读同一层级：auto + 已配置 dashscope → cloudReady=true', () => {
    const store = {
      get: () => ({
        asr: { engine: 'auto', dashscope: { apiKey: 'k', enabled: true }, local: { enabled: true } }
      })
    };
    const a = computeASRAvailability(store);
    expect(a.cloudReady).toBe(true);
    expect(a.canRecord).toBe(true);
  });
});
