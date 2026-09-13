import { describe, it, expect } from 'vitest';
import { createEditorState } from '../../lib/lexicon-editor-state.js';

// 全量词表夹具（words.json 形态）
function fixtureWords() {
  return {
    _meta: { schemaVersion: 1, note: 'passthrough' },
    fillers: ['嗯', '那个', '反正'],
    hedges: ['可能', '我觉得'],
    vague: { 开心: ['高兴', '愉快'], 想: ['打算'] },
    emotions: { 快乐: { category: '喜', polarity: 'positive' } }
  };
}

function newState() {
  return createEditorState({ words: fixtureWords() });
}

describe('editor-state: 单轨读写', () => {
  it('getEffective 直接返回全量词表内容', () => {
    const s = newState();
    expect(s.getEffective('fillers')).toContain('嗯');
    expect(s.getEffective('vague')['开心']).toEqual(['高兴', '愉快']);
  });

  it('addSimple 新增填充词，重复被拒', () => {
    const s = newState();
    expect(s.addSimple('fillers', '老实说').ok).toBe(true);
    expect(s.getEffective('fillers')).toContain('老实说');
    expect(s.addSimple('fillers', '老实说').ok).toBe(false);
  });

  it('removeWord 数组与映射类目都生效', () => {
    const s = newState();
    expect(s.removeWord('fillers', '反正').ok).toBe(true);
    expect(s.removeWord('vague', '想').ok).toBe(true);
    expect(s.getEffective('fillers')).not.toContain('反正');
    expect(s.getEffective('vague')['想']).toBeUndefined();
    expect(s.removeWord('fillers', '不存在').ok).toBe(false);
  });

  it('addVague / setVagueAlts：新增需词+替代词，改写需已存在', () => {
    const s = newState();
    expect(s.addVague('很快', ['迅速']).ok).toBe(true);
    expect(s.addVague('很快', ['迅捷']).ok).toBe(false);
    expect(s.setVagueAlts('很快', ['火速', '即刻']).ok).toBe(true);
    expect(s.getEffective('vague')['很快']).toEqual(['火速', '即刻']);
    expect(s.setVagueAlts('没这个词', ['x']).ok).toBe(false);
  });

  it('addEmotion 默认元数据，重复被拒', () => {
    const s = newState();
    expect(s.addEmotion('自豪').ok).toBe(true);
    expect(s.getEffective('emotions')['自豪']).toEqual({ category: '自定义', polarity: 'neutral' });
    expect(s.addEmotion('自豪').ok).toBe(false);
  });

  it('toWords 带出 _meta 透传', () => {
    const s = newState();
    expect(s.toWords()._meta).toEqual({ schemaVersion: 1, note: 'passthrough' });
  });
});

describe('editor-state: 撤销栈（快照式）', () => {
  it('每步变更可逐步回退，到底后不可再撤销', () => {
    const s = newState();
    expect(s.canUndo()).toBe(false); // 刚打开无历史
    expect(s.undo().ok).toBe(false); // no-op

    s.addSimple('fillers', '词条甲'); // 变更1
    s.removeWord('fillers', '嗯'); // 变更2

    expect(s.canUndo()).toBe(true);
    s.undo(); // 回退变更2 → 嗯 回来
    expect(s.getEffective('fillers')).toContain('嗯');
    expect(s.getEffective('fillers')).toContain('词条甲');

    s.undo(); // 回退变更1 → 词条甲 移除
    expect(s.getEffective('fillers')).not.toContain('词条甲');
    expect(s.canUndo()).toBe(false); // 到底置灰
    expect(s.undo().ok).toBe(false);
  });

  it('撤销到底 = 回到基准，脏标记复位', () => {
    const s = newState();
    s.addSimple('hedges', '差不多');
    expect(s.isDirty()).toBe(true);
    s.undo();
    expect(s.isDirty()).toBe(false);
  });

  it('校验失败的操作不产生历史（失败不入栈）', () => {
    const s = newState();
    s.addSimple('fillers', '嗯'); // 重复被拒
    s.addVague('开心', ['x']); // 重复被拒
    s.removeWord('hedges', '没有的词'); // 不存在被拒
    expect(s.canUndo()).toBe(false);
  });

  it('深度上限 50：最旧历史被丢弃', () => {
    const s = newState();
    for (let i = 0; i < 60; i++) {
      s.addSimple('fillers', `词${i}`);
    }
    // 逐步撤销最多回到第 10 次变更后的状态（前 10 步历史已溢出）
    let steps = 0;
    while (s.canUndo()) {
      s.undo();
      steps++;
    }
    expect(steps).toBe(50);
    expect(s.getEffective('fillers')).toContain('词9'); // 前 10 次变更已不可回退
    expect(s.getEffective('fillers')).not.toContain('词10');
    expect(s.isDirty()).toBe(true); // 未回到初始基准
  });

  it('reset 清空历史并以新状态为基准（保存后不可再撤销）', () => {
    const s = newState();
    s.addSimple('fillers', '词条甲');
    expect(s.canUndo()).toBe(true);

    s.reset(s.toWords()); // 保存路径：基准前移
    expect(s.canUndo()).toBe(false);
    expect(s.isDirty()).toBe(false);
    expect(s.undo().ok).toBe(false); // 已保存状态不可回退
  });

  it('reset 换入外部词表（导入/恢复出厂/外部重载）', () => {
    const s = newState();
    s.addSimple('fillers', '词条甲');
    s.reset({ fillers: ['外部词'], hedges: [], vague: {}, emotions: {} });
    expect(s.canUndo()).toBe(false);
    expect(s.isDirty()).toBe(false);
    expect(s.getEffective('fillers')).toEqual(['外部词']);
  });

  it('撤销后再次编辑：从回退状态分叉，历史线性追加', () => {
    const s = newState();
    s.addSimple('fillers', '甲');
    s.undo(); // 甲 消失
    expect(s.getEffective('fillers')).not.toContain('甲');
    s.addSimple('fillers', '乙');
    expect(s.canUndo()).toBe(true);
    s.undo();
    expect(s.getEffective('fillers')).not.toContain('乙');
    expect(s.isDirty()).toBe(false);
  });
});
