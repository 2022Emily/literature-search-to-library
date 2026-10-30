# -*- coding: utf-8 -*-
"""把 _analysis.md 转成 _analysis.docx（简洁排版：标题层级、列表、表格、加粗、行内代码）。

用法：python md2docx.py <input.md> [output.docx]
不传输出路径时，输出为同名 .docx。依赖 python-docx（pip install python-docx）。
"""
import os
import re
import sys
import unicodedata

try:
    from docx import Document
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt, RGBColor
except ImportError:
    print('缺少依赖 python-docx，请先运行：pip install python-docx')
    sys.exit(1)

BODY_LATIN = 'Times New Roman'
BODY_EA = '宋体'
HEAD_EA = '黑体'
CODE_FONT = 'Consolas'

INLINE = re.compile(r'(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))')


def set_run(run, latin, ea, size=None, bold=None, color=None):
    run.font.name = latin
    run._element.rPr.rFonts.set(qn('w:eastAsia'), ea)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color:
        run.font.color.rgb = color


def add_inline(paragraph, text, size, base_bold=False, color=None):
    """把 **粗体**、`代码`、[文字](链接) 拆成多个 run。"""
    for token in INLINE.split(text):
        if not token:
            continue
        if token.startswith('**') and token.endswith('**') and len(token) > 4:
            r = paragraph.add_run(token[2:-2])
            set_run(r, BODY_LATIN, BODY_EA, size, True, color)
        elif token.startswith('*') and token.endswith('*') and len(token) > 2:
            r = paragraph.add_run(token[1:-1])
            set_run(r, BODY_LATIN, BODY_EA, size, base_bold, color)
            r.italic = True
        elif token.startswith('`') and token.endswith('`') and len(token) > 2:
            r = paragraph.add_run(token[1:-1])
            set_run(r, CODE_FONT, BODY_EA, size - 0.5, base_bold, color)
        elif token.startswith('[') and '](' in token:
            label = token[1:token.index('](')]
            r = paragraph.add_run(label)
            set_run(r, BODY_LATIN, BODY_EA, size, base_bold, color)
        else:
            r = paragraph.add_run(token)
            set_run(r, BODY_LATIN, BODY_EA, size, base_bold, color)


def style_document(doc):
    normal = doc.styles['Normal']
    normal.font.name = BODY_LATIN
    normal.font.size = Pt(10.5)
    normal.element.rPr.rFonts.set(qn('w:eastAsia'), BODY_EA)
    normal.paragraph_format.space_after = Pt(3)
    normal.paragraph_format.line_spacing = 1.25

    for name, size in (('Heading 1', 16), ('Heading 2', 13), ('Heading 3', 11.5)):
        st = doc.styles[name]
        st.font.name = BODY_LATIN
        st.font.size = Pt(size)
        st.font.bold = True
        st.font.color.rgb = RGBColor(0, 0, 0)
        st.element.rPr.rFonts.set(qn('w:eastAsia'), HEAD_EA)
        st.paragraph_format.space_before = Pt(10 if name == 'Heading 1' else 6)
        st.paragraph_format.space_after = Pt(4)

    for section in doc.sections:
        section.page_width = Cm(21)
        section.page_height = Cm(29.7)
        section.left_margin = Cm(2.54)
        section.right_margin = Cm(2.54)
        section.top_margin = Cm(2.54)
        section.bottom_margin = Cm(2.54)


def split_row(line):
    cells = line.strip().strip('|')
    return [c.strip() for c in cells.split('|')]


def is_separator(line):
    return bool(re.match(r'^\s*\|[\s:|-]+\|\s*$', line))


TITLE_TAIL = re.compile(r'\s*(?:研究进展|研究现状|研究综述|最新进展|进展)\s*$')
TAIL_PAREN = re.compile(r'\s*[（(][^（()）]*[）)]\s*$')


def split_title(text):
    """一级标题只留主题名：去掉结尾的「研究进展」、年份括注与「：候选池分析」这类标签。"""
    t = TAIL_PAREN.sub('', text).strip()
    t = TITLE_TAIL.sub('', t).strip()
    t = re.sub(r'^20\d{2}\s*年\s*', '', t)          # 年份交给下一行的调研括注
    t = re.sub(r'\s*[：:]\s*候选池分析\s*$', '', t)
    return t or text.strip()


def span_from(line):
    """从一句话里取年份区间：只出现一个年份时返回空白终点。"""
    ys = re.findall(r'(20\d{2})', line)
    if not ys:
        return '', ''
    a, b = min(ys), max(ys)
    return a, (b if b != a else '')


def year_span(text):
    """取调研年份：优先「文献范围 / 检索范围」所在行的年份，其次全文里的年份区间。"""
    m = re.search(r'(?:文献范围|检索范围|出版窗口|时间窗口|年份窗口)[^\n]*', text)
    if m:
        a, b = span_from(m.group(0))
        if a:
            return a, b
    return span_from(text)


def add_title(doc, title, sub):
    """报告题目：居中黑体，括号里的调研年份另起一行。"""
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.space_after = Pt(4 if sub else 10)
    set_run(p.add_run(title), BODY_LATIN, HEAD_EA, 16, True)
    if sub:
        q = doc.add_paragraph()
        q.alignment = WD_ALIGN_PARAGRAPH.CENTER
        q.paragraph_format.space_after = Pt(10)
        set_run(q.add_run(sub), BODY_LATIN, BODY_EA, 12)


def _vis_len(s):
    """按显示宽度计数：中日韩全角字符算 2，其余算 1。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1 for ch in s)


def fit_widths(doc, rows, cols):
    """按内容量分配列宽：75 分位长度定权重，窄列压到 1.1 cm，长列吃满剩余版心。"""
    sec = doc.sections[-1]
    avail = (sec.page_width - sec.left_margin - sec.right_margin) / 360000  # EMU → cm
    units = []
    for j in range(cols):
        cells = [r[j] for r in rows]
        head = _vis_len(cells[0])
        body = sorted(_vis_len(c) for c in cells[1:]) or [head]
        rep = body[min(len(body) - 1, int(round(0.75 * (len(body) - 1))))]
        # 表头至少要放得下一行，正文单行超长时封顶，避免一列吃掉半页
        units.append(max(3.0, min(max(rep, head), 72.0)))
    total = sum(units)
    floor = 1.1
    widths = [max(u / total * avail, floor) for u in units]
    # 触底后总宽超出版心时，按各列的富余空间等比回收
    for _ in range(6):
        over = sum(widths) - avail
        if over <= 1e-6:
            break
        slack = [w - floor for w in widths]
        flex = sum(slack)
        if flex <= 1e-6:
            break
        widths = [w - min(over, flex) * (s / flex) for w, s in zip(widths, slack)]
    # 列少、内容短时按比例补满版心，避免右侧留白
    under = avail - sum(widths)
    if under > 1e-6:
        widths = [w + under * (w / sum(widths)) for w in widths]
    return widths


def add_table(doc, rows):
    width = max(len(r) for r in rows)
    rows = [r + [''] * (width - len(r)) for r in rows]
    table = doc.add_table(rows=len(rows), cols=width)
    table.style = 'Table Grid'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    layout = OxmlElement('w:tblLayout')
    layout.set(qn('w:type'), 'fixed')
    table._tbl.tblPr.append(layout)
    widths = fit_widths(doc, rows, width)
    for j, cm in enumerate(widths):
        table.columns[j].width = Cm(cm)
        for cell in table.columns[j].cells:
            cell.width = Cm(cm)
    for i, row in enumerate(rows):
        for j, cell in enumerate(row):
            p = table.cell(i, j).paragraphs[0]
            p.paragraph_format.space_after = Pt(1)
            add_inline(p, cell, 9, base_bold=(i == 0))
    doc.add_paragraph()


def convert(src, dst):
    with open(src, encoding='utf-8') as f:
        lines = f.read().splitlines()

    doc = Document()
    style_document(doc)

    a, b = year_span('\n'.join(lines))
    sub = f'（{a}-{b}年文献调研）' if b else (f'（{a}年文献调研）' if a else '')

    i = 0
    title_done = False
    stats = {'h': 0, 'p': 0, 'table': 0, 'list': 0}
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        # 表格：连续以 | 开头的行
        if stripped.startswith('|'):
            block = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                block.append(lines[i])
                i += 1
            rows = [split_row(b) for b in block if not is_separator(b)]
            if rows:
                add_table(doc, rows)
                stats['table'] += 1
            continue

        m = re.match(r'^(#{1,6})\s+(.*)$', stripped)
        if m:
            level = min(len(m.group(1)), 3)
            if level == 1 and not title_done:
                # 一级标题改写成报告题目：居中、去掉「研究进展」、年份括注另起一行
                title_done = True
                j = i + 1
                while j < len(lines) and not lines[j].strip():
                    j += 1
                if j < len(lines) and re.match(r'^\s*[（(].*年文献调研[）)]\s*$', lines[j]):
                    sub_text = lines[j].strip()   # 稿子里已有括注，照用并跳行
                    i = j + 1
                else:
                    sub_text = sub
                    i += 1
                add_title(doc, split_title(m.group(2)), sub_text)
                stats['h'] += 1
                continue
            doc.add_heading(level=level).add_run('')  # 占位，随后重写
            h = doc.paragraphs[-1]
            h.text = ''
            add_inline(h, m.group(2), 16 if level == 1 else (13 if level == 2 else 11.5), base_bold=True)
            stats['h'] += 1
            i += 1
            continue

        if re.match(r'^\s*>\s?', line):
            text = re.sub(r'^\s*>\s?', '', line)
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.6)
            add_inline(p, text, 10, color=RGBColor(0x44, 0x44, 0x44))
            stats['p'] += 1
            i += 1
            continue

        m = re.match(r'^(\s*)[-*]\s+(.*)$', line)
        if m:
            depth = len(m.group(1)) // 2
            style = 'List Bullet' if depth == 0 else 'List Bullet 2'
            p = doc.add_paragraph(style=style)
            p.paragraph_format.space_after = Pt(1)
            add_inline(p, m.group(2), 10.5)
            stats['list'] += 1
            i += 1
            continue

        m = re.match(r'^\s*\d+\.\s+(.*)$', line)
        if m:
            p = doc.add_paragraph(style='List Number')
            p.paragraph_format.space_after = Pt(1)
            add_inline(p, m.group(1), 10.5)
            stats['list'] += 1
            i += 1
            continue

        if re.match(r'^---+$', stripped):
            i += 1
            continue

        p = doc.add_paragraph()
        p.paragraph_format.first_line_indent = Pt(21)  # 首行缩进两字（10.5pt × 2）
        add_inline(p, stripped, 10.5)
        stats['p'] += 1
        i += 1

    doc.save(dst)
    return stats


def main():
    if len(sys.argv) < 2:
        print('用法：python md2docx.py <input.md> [output.docx]')
        sys.exit(1)
    src = sys.argv[1]
    if not os.path.isfile(src):
        print(f'找不到输入文件：{src}')
        sys.exit(1)
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(src)[0] + '.docx'
    try:
        stats = convert(src, dst)
    except Exception as e:  # noqa: BLE001
        print(f'转换失败：{e}')
        sys.exit(1)
    size = os.path.getsize(dst)
    print(f'已生成 {dst}（{size} B）：标题 {stats["h"]}、段落 {stats["p"]}、列表 {stats["list"]}、表格 {stats["table"]}')


if __name__ == '__main__':
    main()
