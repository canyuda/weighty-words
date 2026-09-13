import { describe, it, expect } from 'vitest';
import { getRealtimePrompt, getReportPrompt } from '../../lib/prompts.js';

describe('prompts: 实时反馈模板', () => {
  it('system 携带核心行为约束', () => {
    const p = getRealtimePrompt('内容', null, null);
    expect(p.system).toContain('只输出1条提示');
    expect(p.system).toContain('不超过8个字');
  });

  it('user 只携带末尾 500 字窗口', () => {
    const long = '甲'.repeat(900);
    const p = getRealtimePrompt(long, null, null);
    expect(p.user).toContain('最新一段');
    expect(p.user).toContain('甲'.repeat(500));
    expect(p.user).not.toContain('甲'.repeat(600));
  });

  it('上下文信息嵌入 user（时长/主题/已说观点）', () => {
    const p = getRealtimePrompt('内容', { elapsedSec: 125, topic: '面试', previousPoints: ['第一点'] }, null);
    expect(p.user).toContain('[已说2分钟]');
    expect(p.user).toContain('[开头主题: "面试"]');
    expect(p.user).toContain('[已说过的观点: 第一点]');
  });

  it('自定义规则合并进 system 末尾', () => {
    const p = getRealtimePrompt('内容', null, {
      goals: '少说然后',
      customRules: '规则A',
      styleRef: '简洁风格',
      customWords: ' 我的口癖 '
    });
    expect(p.system).toContain('用户训练目标');
    expect(p.system).toContain('少说然后');
    expect(p.system).toContain('规则A');
    expect(p.system).toContain('简洁风格');
    expect(p.system).toContain('口癖词');
  });

  it('无自定义内容时不追加空块', () => {
    const p1 = getRealtimePrompt('内容', null, null);
    const p2 = getRealtimePrompt('内容', null, {});
    expect(p1.system).not.toContain('用户训练目标');
    expect(p2.system).not.toContain('用户训练目标');
  });
});

describe('prompts: 报告模板', () => {
  const stats = { duration: 60, totalWords: 100, fillers: 3, hedges: 2, vagueWords: 4 };

  it('system 覆盖两大能力与报告结构', () => {
    const p = getReportPrompt('全文', stats, null);
    expect(p.system).toContain('逐句编辑');
    expect(p.system).toContain('总评');
    expect(p.system).toContain('行为模式分析');
    expect(p.system).toContain('用词精准度');
  });

  it('user 携带完整全文与统计数字', () => {
    const p = getReportPrompt('这是完整全文', stats, null);
    expect(p.user).toContain('这是完整全文');
    expect(p.user).toContain('60秒');
    expect(p.user).toContain('100字');
    expect(p.user).toContain('填充词3次');
    expect(p.user).toContain('犹豫词2次');
    expect(p.user).toContain('笼统词4次');
  });

  it('报告全文不做窗口裁剪（区别于实时反馈）', () => {
    const full = '乙'.repeat(900);
    const p = getReportPrompt(full, stats, null);
    expect(p.user).toContain(full);
  });

  it('自定义内容合并进报告 system', () => {
    const p = getReportPrompt('全文', stats, { goals: '目标G', styleRef: '风格S', customWords: '词W' });
    expect(p.system).toContain('目标G');
    expect(p.system).toContain('风格S');
    expect(p.system).toContain('词W');
  });
});
