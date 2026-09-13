#!/usr/bin/env python3
"""生成「言之有物」项目介绍 PPT。"""

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor as RgbColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import nsmap
from pptx.oxml import parse_xml
from lxml import etree
import copy

# —— 视觉：墨青 + 琥珀，避开常见 AI 紫/奶油风 ——
INK = RgbColor(0x1A, 0x2B, 0x3C)
TEAL = RgbColor(0x0D, 0x7A, 0x7A)
TEAL_LIGHT = RgbColor(0xE6, 0xF4, 0xF4)
AMBER = RgbColor(0xC4, 0x5C, 0x26)
AMBER_SOFT = RgbColor(0xF7, 0xEB, 0xE3)
WHITE = RgbColor(0xFF, 0xFF, 0xFF)
GRAY = RgbColor(0x5A, 0x6A, 0x7A)
GRAY_LIGHT = RgbColor(0xF4, 0xF6, 0xF8)
LINE = RgbColor(0xD0, 0xD8, 0xE0)

SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)


def set_run(run, size=18, bold=False, color=INK, font="PingFang SC"):
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    run.font.name = font
    # 东亚字体
    rPr = run._r.get_or_add_rPr()
    ea = rPr.find("{http://schemas.openxmlformats.org/drawingml/2006/main}ea")
    if ea is None:
        ea = etree.SubElement(rPr, "{http://schemas.openxmlformats.org/drawingml/2006/main}ea")
    ea.set("typeface", font)


def add_rect(slide, left, top, width, height, fill):
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill
    shape.line.fill.background()
    return shape


def add_round_rect(slide, left, top, width, height, fill):
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill
    shape.line.fill.background()
    # 略小圆角
    try:
        shape.adjustments[0] = 0.08
    except Exception:
        pass
    return shape


def add_textbox(slide, left, top, width, height, text, size=18, bold=False, color=INK, align=PP_ALIGN.LEFT, font="PingFang SC"):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.alignment = align
    run = p.add_run()
    run.text = text
    set_run(run, size=size, bold=bold, color=color, font=font)
    return box


def add_paragraphs(box, lines, size=16, color=INK, bold=False, space_after=8, bullet=False):
    tf = box.text_frame
    tf.word_wrap = True
    first = True
    for line in lines:
        if first:
            p = tf.paragraphs[0]
            first = False
        else:
            p = tf.add_paragraph()
        p.alignment = PP_ALIGN.LEFT
        p.space_after = Pt(space_after)
        if bullet:
            p.level = 0
        run = p.add_run()
        run.text = (("• " if bullet else "") + line) if not bullet else ("• " + line)
        # simplify: always prefix manually for reliability
        set_run(run, size=size, bold=bold, color=color)


def clear_and_lines(box, lines, size=16, color=INK, space_after=10, prefix="• "):
    tf = box.text_frame
    tf.clear()
    tf.word_wrap = True
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.space_after = Pt(space_after)
        run = p.add_run()
        run.text = prefix + line if prefix else line
        set_run(run, size=size, color=color)


def footer(slide, page, total):
    add_textbox(slide, Inches(0.5), Inches(7.1), Inches(8), Inches(0.3),
                "言之有物 · expression-trainer", size=11, color=GRAY)
    add_textbox(slide, Inches(11.5), Inches(7.1), Inches(1.5), Inches(0.3),
                f"{page} / {total}", size=11, color=GRAY, align=PP_ALIGN.RIGHT)


def accent_bar(slide):
    add_rect(slide, Inches(0), Inches(0), Inches(0.12), SLIDE_H, TEAL)


def section_title(slide, title, subtitle=None):
    accent_bar(slide)
    add_textbox(slide, Inches(0.55), Inches(0.35), Inches(12), Inches(0.55),
                title, size=28, bold=True, color=INK)
    if subtitle:
        add_textbox(slide, Inches(0.55), Inches(0.9), Inches(12), Inches(0.35),
                    subtitle, size=14, color=GRAY)
    add_rect(slide, Inches(0.55), Inches(1.35), Inches(1.2), Inches(0.06), AMBER)


def card(slide, left, top, width, height, title, body_lines, title_color=TEAL):
    add_round_rect(slide, left, top, width, height, GRAY_LIGHT)
    add_textbox(slide, left + Inches(0.25), top + Inches(0.2), width - Inches(0.4), Inches(0.4),
                title, size=16, bold=True, color=title_color)
    box = slide.shapes.add_textbox(left + Inches(0.25), top + Inches(0.65),
                                   width - Inches(0.45), height - Inches(0.85))
    clear_and_lines(box, body_lines, size=13, color=INK, space_after=6)


def build():
    prs = Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H
    blank = prs.slide_layouts[6]
    total = 12

    # 1 封面
    s = prs.slides.add_slide(blank)
    add_rect(s, 0, 0, SLIDE_W, SLIDE_H, INK)
    add_rect(s, 0, Inches(5.9), SLIDE_W, Inches(1.6), TEAL)
    add_textbox(s, Inches(0.8), Inches(1.8), Inches(11), Inches(0.9),
                "言之有物", size=54, bold=True, color=WHITE)
    add_textbox(s, Inches(0.8), Inches(2.75), Inches(11), Inches(0.5),
                "Expression Trainer", size=22, color=RgbColor(0xA8, 0xD4, 0xD4))
    add_textbox(s, Inches(0.8), Inches(3.5), Inches(11), Inches(0.8),
                "实时中文语音识别 · 本地词库分析 · AI 表达反馈", size=18, color=WHITE)
    add_textbox(s, Inches(0.8), Inches(6.25), Inches(11), Inches(0.4),
                "本地桌面应用  ·  Electron  ·  MIT  ·  github.com/canyuda/expression-trainer",
                size=14, color=WHITE)
    add_textbox(s, Inches(0.8), Inches(6.7), Inches(11), Inches(0.35),
                "项目介绍", size=14, color=RgbColor(0xC8, 0xE8, 0xE8))

    # 2 问题与定位
    s = prs.slides.add_slide(blank)
    section_title(s, "为什么需要「言之有物」", "口语表达常见问题 → 可感知、可训练的反馈闭环")
    pains = [
        ("填充词不断", "「嗯、啊、那个、然后」占满节奏，听者抓不住重点"),
        ("犹豫弱化表达", "「可能、也许、我觉得」让观点听起来不坚定"),
        ("用词笼统", "「挺好的、一些、很多」缺少画面与信息量"),
        ("反馈滞后", "事后回想难，缺少当场看见问题的训练工具"),
    ]
    for i, (t, d) in enumerate(pains):
        col, row = i % 2, i // 2
        left = Inches(0.55) + Inches(col * 6.2)
        top = Inches(1.7) + Inches(row * 2.3)
        add_round_rect(s, left, top, Inches(5.9), Inches(2.0), TEAL_LIGHT if i % 2 == 0 else AMBER_SOFT)
        add_textbox(s, left + Inches(0.35), top + Inches(0.35), Inches(5.2), Inches(0.45),
                    t, size=20, bold=True, color=INK)
        add_textbox(s, left + Inches(0.35), top + Inches(0.95), Inches(5.2), Inches(0.8),
                    d, size=15, color=GRAY)
    footer(s, 2, total)

    # 3 产品一句话
    s = prs.slides.add_slide(blank)
    section_title(s, "产品是什么", "对着它说话，问题词当场高亮；结束后拿到 6 维深度报告")
    steps = [
        ("01", "说", "麦克风实时采集口语"),
        ("02", "听", "云端 / 本地 ASR 转文字"),
        ("03", "析", "本地词库匹配问题词"),
        ("04", "评", "AI 实时反馈 + 终稿报告"),
    ]
    for i, (n, t, d) in enumerate(steps):
        left = Inches(0.55) + Inches(i * 3.15)
        add_round_rect(s, left, Inches(2.0), Inches(2.95), Inches(3.6), GRAY_LIGHT)
        add_textbox(s, left + Inches(0.25), Inches(2.3), Inches(2.4), Inches(0.5),
                    n, size=28, bold=True, color=TEAL)
        add_textbox(s, left + Inches(0.25), Inches(3.1), Inches(2.4), Inches(0.5),
                    t, size=26, bold=True, color=INK)
        add_textbox(s, left + Inches(0.25), Inches(3.85), Inches(2.4), Inches(1.2),
                    d, size=15, color=GRAY)
    add_textbox(s, Inches(0.55), Inches(5.9), Inches(12), Inches(0.6),
                "核心主张：让表达训练「看得见问题、改得有方向」。", size=16, bold=True, color=AMBER)
    footer(s, 3, total)

    # 4 核心功能
    s = prs.slides.add_slide(blank)
    section_title(s, "核心功能", "五项能力覆盖从录音到复盘的完整链路")
    cards = [
        ("实时语音识别", ["阿里云百炼云端（开箱即用）", "Sherpa-ONNX 本地离线", "自动 / 仅云端 / 仅本地"]),
        ("大字字幕批注", ["纸面画布实时字幕", "问题词当场上色标注", "顶部统计胶囊累计"]),
        ("本地词库分析", ["填充词 / 犹豫词 / 笼统词", "精准替代建议", "基于大连理工情感词库结构"]),
        ("AI 多后端反馈", ["DeepSeek / 智谱 / OpenAI", "Ollama 本地或自定义 API", "每约 50 字实时点评"]),
        ("6 维分析报告", ["逻辑 · 直接性 · 填充词", "密度 · 词汇 · 亮点", "可按训练规则定制"]),
        ("规则定制", ["训练目标与自定义规则", "表达风格参照", "额外口癖词表"]),
    ]
    for i, (title, lines) in enumerate(cards):
        col, row = i % 3, i // 3
        left = Inches(0.5) + Inches(col * 4.2)
        top = Inches(1.7) + Inches(row * 2.5)
        card(s, left, top, Inches(4.0), Inches(2.3), title, lines)
    footer(s, 4, total)

    # 5 使用流程
    s = prs.slides.add_slide(blank)
    section_title(s, "一次训练怎么走", "五步完成：录制 → 看见 → 反馈 → 结束 → 报告")
    flow = [
        ("开始录制", "对着麦克风自然说话"),
        ("实时字幕", "大字显示，问题词高亮"),
        ("统计与反馈", "胶囊计数 + 右侧 AI 卡片"),
        ("结束录制", "停下本轮表达"),
        ("生成报告", "拿到 6 维度深度分析"),
    ]
    for i, (t, d) in enumerate(flow):
        top = Inches(1.75) + Inches(i * 0.95)
        add_round_rect(s, Inches(0.55), top, Inches(12.2), Inches(0.85), TEAL_LIGHT if i % 2 == 0 else GRAY_LIGHT)
        add_round_rect(s, Inches(0.75), top + Inches(0.18), Inches(0.5), Inches(0.5), TEAL)
        add_textbox(s, Inches(0.75), top + Inches(0.22), Inches(0.5), Inches(0.45),
                    str(i + 1), size=16, bold=True, color=WHITE, align=PP_ALIGN.CENTER)
        add_textbox(s, Inches(1.55), top + Inches(0.15), Inches(4), Inches(0.55),
                    t, size=18, bold=True, color=INK)
        add_textbox(s, Inches(6.0), top + Inches(0.2), Inches(6.4), Inches(0.5),
                    d, size=16, color=GRAY)
    footer(s, 5, total)

    # 6 字幕颜色
    s = prs.slides.add_slide(blank)
    section_title(s, "字幕怎么读", "颜色 = 问题类型；绿色反馈 = 有力表达认可")
    legends = [
        (RgbColor(0xC0, 0x39, 0x2B), "红色波浪下划线", "填充词", "嗯、啊、那个、然后…"),
        (RgbColor(0xE6, 0x7E, 0x22), "橙色下划线", "犹豫词", "可能、也许、我觉得…"),
        (RgbColor(0xD4, 0xA0, 0x17), "黄色虚线", "笼统词", "有精准替代建议"),
        (RgbColor(0x1E, 0x8A, 0x5A), "绿色条目", "有力表达", "右侧实时反馈面板认可"),
    ]
    for i, (c, mark, name, eg) in enumerate(legends):
        top = Inches(1.75) + Inches(i * 1.15)
        add_round_rect(s, Inches(0.55), top, Inches(12.2), Inches(1.0), GRAY_LIGHT)
        add_round_rect(s, Inches(0.8), top + Inches(0.25), Inches(0.5), Inches(0.5), c)
        add_textbox(s, Inches(1.6), top + Inches(0.15), Inches(3.5), Inches(0.7),
                    mark, size=16, bold=True, color=INK)
        add_textbox(s, Inches(5.3), top + Inches(0.15), Inches(2.5), Inches(0.7),
                    name, size=18, bold=True, color=c)
        add_textbox(s, Inches(8.0), top + Inches(0.2), Inches(4.4), Inches(0.6),
                    eg, size=15, color=GRAY)
    footer(s, 6, total)

    # 7 词库
    s = prs.slides.add_slide(blank)
    section_title(s, "本地词库能力", "data/emotion-lexicon.json — 分析不依赖网络")
    items = [
        ("130+", "情绪词", "喜怒哀惧恶惊 · 强度 1–9"),
        ("25", "笼统→精准", "高频替代映射"),
        ("24", "填充词", "常见口头禅"),
        ("19", "犹豫词", "弱化表达"),
        ("4 级", "程度梯度", "弱 → 中 → 强 → 极"),
        ("10+8", "转换示例", "画面化 / 犹豫→直接"),
    ]
    for i, (n, t, d) in enumerate(items):
        col, row = i % 3, i // 3
        left = Inches(0.5) + Inches(col * 4.2)
        top = Inches(1.75) + Inches(row * 2.4)
        add_round_rect(s, left, top, Inches(4.0), Inches(2.15), GRAY_LIGHT)
        add_textbox(s, left + Inches(0.3), top + Inches(0.35), Inches(3.4), Inches(0.55),
                    n, size=32, bold=True, color=TEAL)
        add_textbox(s, left + Inches(0.3), top + Inches(1.0), Inches(3.4), Inches(0.4),
                    t, size=18, bold=True, color=INK)
        add_textbox(s, left + Inches(0.3), top + Inches(1.45), Inches(3.4), Inches(0.45),
                    d, size=14, color=GRAY)
    footer(s, 7, total)

    # 8 ASR
    s = prs.slides.add_slide(blank)
    section_title(s, "语音识别引擎", "云端开箱即用，也可完全离线")
    modes = [
        ("自动（默认）", "云端优先；Key 缺失或失败时回退本地，并提示用户"),
        ("仅云端", "强制阿里云百炼；失败直接报错"),
        ("仅本地", "Sherpa-ONNX streaming paraformer；需先下载模型"),
    ]
    for i, (t, d) in enumerate(modes):
        left = Inches(0.5) + Inches(i * 4.2)
        add_round_rect(s, left, Inches(1.7), Inches(4.0), Inches(2.4), TEAL_LIGHT)
        add_textbox(s, left + Inches(0.25), Inches(1.95), Inches(3.5), Inches(0.5),
                    t, size=18, bold=True, color=TEAL)
        box = s.shapes.add_textbox(left + Inches(0.25), Inches(2.6), Inches(3.5), Inches(1.2))
        clear_and_lines(box, [d], size=14, color=INK, space_after=4, prefix="")

    add_textbox(s, Inches(0.55), Inches(4.4), Inches(12), Inches(0.4),
                "常用云端模型", size=16, bold=True, color=INK)
    models = [
        "paraformer-realtime-v2 — 默认，稳定",
        "fun-asr-realtime — 方言友好",
        "qwen-audio / qwen3-asr — 热词、情感等能力",
        "说明：为保留填充词检测，已关闭服务端语气词过滤",
    ]
    box = s.shapes.add_textbox(Inches(0.55), Inches(4.85), Inches(12), Inches(1.8))
    clear_and_lines(box, models, size=14, color=GRAY, space_after=6)
    footer(s, 8, total)

    # 9 AI 报告
    s = prs.slides.add_slide(blank)
    section_title(s, "AI 反馈与 6 维报告", "推荐 DeepSeek：质量高、成本极低")
    dims = ["逻辑结构", "直接性", "填充词控制", "信息密度", "词汇精准", "表达亮点"]
    for i, d in enumerate(dims):
        col, row = i % 3, i // 3
        left = Inches(0.5) + Inches(col * 4.2)
        top = Inches(1.7) + Inches(row * 1.35)
        add_round_rect(s, left, top, Inches(4.0), Inches(1.15), AMBER_SOFT if row == 0 else TEAL_LIGHT)
        add_textbox(s, left + Inches(0.3), top + Inches(0.35), Inches(3.4), Inches(0.5),
                    f"{i+1}.  {d}", size=18, bold=True, color=INK)

    backends = "后端：DeepSeek · 智谱 GLM · OpenAI · Ollama · 自定义 HTTP"
    add_textbox(s, Inches(0.55), Inches(4.7), Inches(12), Inches(0.4),
                backends, size=15, color=GRAY)
    add_round_rect(s, Inches(0.55), Inches(5.3), Inches(12.2), Inches(1.35), GRAY_LIGHT)
    box = s.shapes.add_textbox(Inches(0.85), Inches(5.5), Inches(11.6), Inches(1.0))
    clear_and_lines(box, [
        "实时：约每 50 字推送一条 AI 点评到右侧反馈卡片",
        "终稿：结束后一键生成完整 Markdown 分析报告",
        "规则：训练目标 / 风格 / 口癖词会影响 Prompt，报告按你的目标定制",
    ], size=14, color=INK, space_after=4)
    footer(s, 9, total)

    # 10 架构
    s = prs.slides.add_slide(blank)
    section_title(s, "技术架构", "Electron 双进程：主进程管引擎，渲染进程管体验")
    add_round_rect(s, Inches(0.55), Inches(1.7), Inches(12.2), Inches(2.6), INK)
    add_textbox(s, Inches(0.85), Inches(1.9), Inches(11.5), Inches(0.4),
                "Electron 主进程", size=18, bold=True, color=WHITE)
    main_items = [
        "语音识别：云端百炼 / 本地 Sherpa-ONNX + 模型下载（进度 / 续传 / 校验）",
        "词库匹配：emotion-lexicon.json",
        "AI 反馈：多后端 HTTP API + Prompt 模板",
    ]
    box = s.shapes.add_textbox(Inches(0.85), Inches(2.45), Inches(11.5), Inches(1.6))
    clear_and_lines(box, main_items, size=14, color=RgbColor(0xD0, 0xE8, 0xE8), space_after=8)

    add_round_rect(s, Inches(0.55), Inches(4.55), Inches(12.2), Inches(2.0), TEAL)
    add_textbox(s, Inches(0.85), Inches(4.75), Inches(11.5), Inches(0.4),
                "渲染进程（Chromium）", size=18, bold=True, color=WHITE)
    ui_items = [
        "全屏字幕与批注画布 · 实时统计面板 · 分析报告弹窗",
        "设置页 / 训练规则编辑器 · 主界面交互逻辑",
    ]
    box = s.shapes.add_textbox(Inches(0.85), Inches(5.3), Inches(11.5), Inches(1.0))
    clear_and_lines(box, ui_items, size=14, color=WHITE, space_after=8)
    footer(s, 10, total)

    # 11 上手与发版
    s = prs.slides.add_slide(blank)
    section_title(s, "快速上手与发版", "Node 18+ · macOS 12+ / Windows 10+ / Linux")
    add_round_rect(s, Inches(0.5), Inches(1.7), Inches(6.0), Inches(4.8), GRAY_LIGHT)
    add_textbox(s, Inches(0.8), Inches(1.95), Inches(5.4), Inches(0.4),
                "本地运行", size=18, bold=True, color=TEAL)
    box = s.shapes.add_textbox(Inches(0.8), Inches(2.5), Inches(5.4), Inches(3.7))
    clear_and_lines(box, [
        "npm install",
        "npm start  （开发：npm run dev）",
        "设置 → 语音识别：填百炼 Key 或下载本地模型",
        "设置 → 分析模型：选后端并填 Key",
        "开始录制即可训练",
    ], size=14, color=INK, space_after=12, prefix="")

    add_round_rect(s, Inches(6.8), Inches(1.7), Inches(6.0), Inches(4.8), TEAL_LIGHT)
    add_textbox(s, Inches(7.1), Inches(1.95), Inches(5.4), Inches(0.4),
                "打包发版", size=18, bold=True, color=TEAL)
    box = s.shapes.add_textbox(Inches(7.1), Inches(2.5), Inches(5.4), Inches(3.7))
    clear_and_lines(box, [
        "npm run build      → macOS dmg/zip",
        "npm run build:win  → Windows NSIS",
        "打 v* tag 触发 GitHub Actions",
        "产物挂到 GitHub Release",
        "Windows 未签名：SmartScreen 选「仍要运行」",
    ], size=14, color=INK, space_after=12, prefix="")
    footer(s, 11, total)

    # 12 结尾
    s = prs.slides.add_slide(blank)
    add_rect(s, 0, 0, SLIDE_W, SLIDE_H, INK)
    add_rect(s, 0, Inches(0), Inches(0.15), SLIDE_H, AMBER)
    add_textbox(s, Inches(0.9), Inches(2.0), Inches(11.5), Inches(0.8),
                "看见问题，才改得动表达", size=36, bold=True, color=WHITE)
    add_textbox(s, Inches(0.9), Inches(3.0), Inches(11.5), Inches(0.6),
                "言之有物 — 让每一次开口，都更有物可言之", size=18, color=RgbColor(0xA8, 0xD4, 0xD4))
    add_textbox(s, Inches(0.9), Inches(4.2), Inches(11.5), Inches(0.4),
                "https://github.com/canyuda/expression-trainer", size=16, color=WHITE)
    add_textbox(s, Inches(0.9), Inches(5.0), Inches(11.5), Inches(0.4),
                "MIT License  ·  Copyright 2026 canyuda", size=14, color=GRAY)
    add_textbox(s, Inches(0.9), Inches(6.3), Inches(11.5), Inches(0.4),
                "谢谢", size=22, bold=True, color=TEAL)

    out = "/Users/yiqi/webProjects/expression-trainer/cursor-auto-gen.pptx"
    prs.save(out)
    print(out)


if __name__ == "__main__":
    build()
