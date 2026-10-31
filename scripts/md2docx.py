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
    from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt, RGBColor
    from docx.text.run import Run
except ImportError:
    print('缺少依赖 python-docx，请先运行：pip install python-docx')
    sys.exit(1)

BODY_LATIN = 'Times New Roman'
BODY_EA = '宋体'
HEAD_EA = '黑体'
# 正文字号：12 pt 为小四（学术报告常用），10.5 pt 为五号（更紧凑）。
# 临时对比时可用环境变量 MD2DOCX_BODY_PT 覆盖，不改文件。
BODY_PT = float(os.environ.get('MD2DOCX_BODY_PT', '12'))
TABLE_PT = 9.0

INLINE = re.compile(r'(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))')

SUB_MAP = {ch: str(i) for i, ch in enumerate('₀₁₂₃₄₅₆₇₈₉')}
SUB_MAP.update({'₊': '+', '₋': '-'})
SUP_MAP = {ch: str(i) for i, ch in enumerate('⁰¹²³⁴⁵⁶⁷⁸⁹')}
SUP_MAP.update({'⁺': '+', '⁻': '-'})

ELEMENTS = set('''H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni
Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce
Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra
Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr'''.split())

# 单元素分子（不写第二个元素，靠白名单避免把谱系编号 S1、批次号 N2 之类误判成化学式）
MOLECULES = {'H2', 'N2', 'O2', 'O3', 'F2', 'Cl2', 'Br2', 'I2', 'P4', 'S8'}

FORMULA = re.compile(r'(?<![A-Za-z0-9#])[A-Z][A-Za-z0-9()]{1,}(?![A-Za-z0-9])')

# 脚本内部的摘要来源标识（小写）不直接面向读者，导出时换成正式名称。
# 前后加词边界，避免误伤 DOI：10.1002/sus2.196、10.3390/s23146634
ABS_LABEL = {'openalex': 'OpenAlex', 'crossref': 'Crossref', 's2': 'Semantic Scholar'}
ABS_TOKEN = re.compile(r'(?<![A-Za-z0-9])(openalex|crossref|s2)(?![A-Za-z0-9])')


def screen_source(text):
    """把数据源内部标识换成正式名称；DOI 等行内代码不经过这里。"""
    return ABS_TOKEN.sub(lambda m: ABS_LABEL[m.group(1)], text)


def is_formula(text):
    """元素符号 + 数字 + 括号的完整串，且至少含一个数字；单元素式须在白名单里。"""
    if not re.search(r'\d', text):
        return False
    symbols = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch.isdigit() or ch in '()':
            i += 1
            continue
        if not ch.isupper():
            return False
        sym = ch
        if i + 1 < len(text) and text[i + 1].islower():
            sym += text[i + 1]
            i += 1
        if sym not in ELEMENTS:
            return False
        symbols.append(sym)
        i += 1
    if not symbols:
        return False
    return len(set(symbols)) >= 2 or text in MOLECULES


def split_scripts(text):
    """把 Unicode 上下标与化学式数字拆成 (文字, 模式) 段；模式为 ''/'sub'/'sup'。"""
    pieces, buf, mode = [], '', ''
    for ch in text:
        if ch in SUB_MAP:
            ch, m = SUB_MAP[ch], 'sub'
        elif ch in SUP_MAP:
            ch, m = SUP_MAP[ch], 'sup'
        else:
            m = ''
        if m != mode:
            if buf:
                pieces.append((buf, mode))
            buf, mode = ch, m
        else:
            buf += ch
    if buf:
        pieces.append((buf, mode))

    out = []
    for seg, m in pieces:
        if m:
            out.append((seg, m))
            continue
        pos = 0
        for hit in FORMULA.finditer(seg):
            f = hit.group(0)
            if not is_formula(f):
                continue
            out.append((seg[pos:hit.start()], ''))
            for part in re.findall(r'\d+|[^\d]+', f):
                out.append((part, 'sub' if part.isdigit() else ''))
            pos = hit.end()
        out.append((seg[pos:], ''))
    return [(s, m) for s, m in out if s]


def add_text(paragraph, text, size, bold=None, color=None, ea=BODY_EA):
    """写一段文字，上下标用真正的 vertAlign，而不是 Unicode 小字。"""
    for seg, mode in split_scripts(text):
        r = paragraph.add_run(seg)
        set_run(r, BODY_LATIN, ea, size, bold, color)
        if mode == 'sub':
            r.font.subscript = True
        elif mode == 'sup':
            r.font.superscript = True


def set_run(run, latin, ea, size=None, bold=None, color=None):
    run.font.name = latin
    run._element.rPr.rFonts.set(qn('w:eastAsia'), ea)
    run._element.rPr.rFonts.set(qn('w:cs'), latin)   # 复杂文种也锁定同一西文字体，避免回退到主题字体
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color:
        run.font.color.rgb = color


def add_inline(paragraph, text, size, base_bold=False, color=None, ea=BODY_EA):
    """把 **粗体**、`代码`、[文字](链接) 拆成多个 run。

    行内代码（DOI、关键词、文件名）不再用等宽字体：正文里的西文统一 Times New Roman，
    混排时才不会出现忽宽忽窄的两种英文。化学式与 Unicode 上下标交给 add_text。
    """
    for token in INLINE.split(text):
        if not token:
            continue
        if token.startswith('**') and token.endswith('**') and len(token) > 4:
            add_text(paragraph, screen_source(token[2:-2]), size, True, color, ea)
        elif token.startswith('*') and token.endswith('*') and len(token) > 2:
            r = paragraph.add_run(screen_source(token[1:-1]))
            set_run(r, BODY_LATIN, ea, size, base_bold, color)
            r.italic = True
        elif token.startswith('`') and token.endswith('`') and len(token) > 2:
            add_text(paragraph, token[1:-1], size, base_bold, color, ea)
        elif token.startswith('[') and '](' in token:
            add_text(paragraph, screen_source(token[1:token.index('](')]), size, base_bold, color, ea)
        else:
            add_text(paragraph, screen_source(token), size, base_bold, color, ea)


def style_document(doc):
    normal = doc.styles['Normal']
    normal.font.name = BODY_LATIN
    normal.font.size = Pt(BODY_PT)
    normal.element.rPr.rFonts.set(qn('w:eastAsia'), BODY_EA)
    normal.paragraph_format.space_after = Pt(0)
    normal.paragraph_format.line_spacing = 1.25

    for name, size in (('Heading 1', 16), ('Heading 2', 14), ('Heading 3', BODY_PT)):
        st = doc.styles[name]
        st.font.name = BODY_LATIN
        st.font.size = Pt(size)
        st.font.bold = True
        st.font.color.rgb = RGBColor(0, 0, 0)
        st.element.rPr.rFonts.set(qn('w:eastAsia'), HEAD_EA)
        st.paragraph_format.space_before = Pt(12 if name == 'Heading 1' else 8)
        st.paragraph_format.space_after = Pt(6)

    for section in doc.sections:
        section.page_width = Cm(21)
        section.page_height = Cm(29.7)
        section.left_margin = Cm(2.54)
        section.right_margin = Cm(2.54)
        section.top_margin = Cm(2.54)
        section.bottom_margin = Cm(2.54)
        add_page_number(section)

    drop_compat_mode(doc)


PAGE_FIELD = 'PAGE'


def add_page_number(section):
    """页脚居中放「第 X 页」：PAGE 域，增删页后自动更新。"""
    p = section.footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_run(p.add_run('第 '), BODY_LATIN, BODY_EA, 9)
    fld = OxmlElement('w:fldSimple')
    fld.set(qn('w:instr'), PAGE_FIELD)
    r = OxmlElement('w:r')
    t = OxmlElement('w:t')
    t.text = '1'
    r.append(t)
    fld.append(r)
    p._p.append(fld)
    set_run(Run(r, p), BODY_LATIN, BODY_EA, 9)
    set_run(p.add_run(' 页'), BODY_LATIN, BODY_EA, 9)


def drop_compat_mode(doc):
    """把兼容级别提到 Word 2013+，消除 Word 标题栏的「兼容性模式」。"""
    settings = doc.settings.element
    for node in settings.findall(qn('w:compat')):
        settings.remove(node)
    compat = OxmlElement('w:compat')
    setting = OxmlElement('w:compatSetting')
    setting.set(qn('w:name'), 'compatibilityMode')
    setting.set(qn('w:uri'), 'http://schemas.microsoft.com/office/word')
    setting.set(qn('w:val'), '15')
    compat.append(setting)
    settings.append(compat)


INDENT_CHARS = 2


def indent_chars(p, n=INDENT_CHARS):
    """按字符数缩进首行（东亚版式），换字号后仍是 n 个字；firstLine 作为兜底。"""
    p.paragraph_format.first_line_indent = Pt(BODY_PT * n)   # 让 python-docx 按 schema 插入 w:ind
    ind = p._p.pPr.find(qn('w:ind'))
    ind.set(qn('w:firstLineChars'), str(n * 100))


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


WIDTH_FLOOR = 1.1
TOKEN_BREAK = re.compile(r'[ \t\u00a0\u3000\-‐–—/]+')   # 空格、连字符、斜杠都是断行点


def _text_cm(text, pt):
    """估算不可断文本的宽度（cm）：全角字 1 em、西文 0.5 em，另加单元格左右内边距。"""
    em = sum(1.0 if unicodedata.east_asian_width(ch) in ('W', 'F') else 0.5 for ch in text)
    return em * pt * 0.03528 + 0.38


def col_floor(rows, j):
    """列宽下限＝该列最长的一个英文单词，保证单词不在格子里被折断。

    含中文的单元格可在任意汉字处断行，不构成宽度下限。
    """
    floor = WIDTH_FLOOR
    for row in rows:
        cell = row[j]
        if any(unicodedata.east_asian_width(ch) in ('W', 'F') for ch in cell):
            continue
        for tok in TOKEN_BREAK.split(cell):
            floor = max(floor, _text_cm(tok, TABLE_PT))
    return floor


def fit_widths(doc, rows, cols):
    """按内容量分配列宽：75 分位长度定权重，每列不低于该列最长单词的宽度。"""
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
    floors = [col_floor(rows, j) for j in range(cols)]
    widths = [max(u / total * avail, f) for u, f in zip(units, floors)]
    over = sum(widths) - avail
    if over > 1e-6:
        slack = [w - f for w, f in zip(widths, floors)]
        flex = sum(slack)
        if flex >= over:
            # 只回收超出下限的富余空间，单词宽度不动
            widths = [w - over * (s / flex) for w, s in zip(widths, slack)]
        else:
            scale = avail / sum(floors)   # 压到下限仍超宽，只能整体等比缩小
            widths = [f * scale for f in floors]
    # 列少、内容短时按比例补满版心，避免右侧留白
    under = avail - sum(widths)
    if under > 1e-6:
        widths = [w + under * (w / sum(widths)) for w in widths]
    return widths


DOI_CELL = re.compile(r'^10\.\d{4,9}/\S+')


def doi_cols(rows):
    """判定 DOI 列：表头含 DOI，或正文 80% 以上是 DOI 串；该列保持左对齐。"""
    out = set()
    for j in range(len(rows[0])):
        if 'doi' in rows[0][j].lower():
            out.add(j)
            continue
        vals = [r[j].strip() for r in rows[1:] if r[j].strip()]
        if vals and sum(bool(DOI_CELL.match(v)) for v in vals) >= 0.8 * len(vals):
            out.add(j)
    return out


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
    doi = doi_cols(rows)
    for i, row in enumerate(rows):
        trPr = table.rows[i]._tr.get_or_add_trPr()
        if i == 0:
            # 跨页时自动重复表头，长表翻页不会丢失列名
            head = OxmlElement('w:tblHeader')
            head.set(qn('w:val'), 'true')
            trPr.append(OxmlElement('w:cantSplit'))
            trPr.append(head)
        else:
            trPr.append(OxmlElement('w:cantSplit'))
        for j, cell in enumerate(row):
            c = table.cell(i, j)
            c.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            p = c.paragraphs[0]
            p.paragraph_format.space_after = Pt(1)
            p.paragraph_format.line_spacing = 1.15
            if i == 0:
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            elif j in doi:
                p.alignment = WD_ALIGN_PARAGRAPH.LEFT   # DOI 串太长，居中会挤成多行
            else:
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            add_inline(p, cell, TABLE_PT, base_bold=(i == 0))
    doc.add_paragraph()


FIELD_LABELS = ('核心贡献', '方法', '主要结果', '评述', '优先级')
FIELD_BOLD = ('核心贡献', '方法', '主要结果', '评述', '优先级')
EMOJI_PREFIX = re.compile(r'^(?:[\U0001F300-\U0001FAFF\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF]+\s*)?')


def add_field(p, text, size):
    """字段式评述：字段名加粗、优先级前补 ⭐；刊名与 DOI 行原样输出。"""
    head, sep, rest = text.partition('：')
    m = EMOJI_PREFIX.match(head)
    label = head[m.end():].strip()
    if not sep or label not in FIELD_LABELS:
        add_inline(p, text, size)
        return
    emoji = m.group(0) or ''
    strong = label in FIELD_BOLD
    if label == '优先级':
        emoji = '⭐ '
        strong = True
    if emoji:
        set_run(p.add_run(emoji), BODY_LATIN, BODY_EA, size, strong)
    set_run(p.add_run(label + '：'), BODY_LATIN, BODY_EA, size, strong)
    add_inline(p, rest, size)


def add_numbered(doc, number, text, size, indent_cm=0.0, bold_head=False):
    """手工编号段落：编号取自源稿，悬挂缩进，不依赖 Word 自动编号链。"""
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    pf = p.paragraph_format
    pf.left_indent = Cm(indent_cm + 0.74)
    pf.first_line_indent = Cm(-0.74)
    pf.space_after = Pt(1)
    set_run(p.add_run(f'{number}. '), BODY_LATIN, BODY_EA, size)
    if bold_head and '：' in text:
        head, _, rest = text.partition('：')
        add_inline(p, head, size, base_bold=True)   # 议题名加粗，冒号随之前置
        set_run(p.add_run('：'), BODY_LATIN, BODY_EA, size, True)
        add_inline(p, rest, size)
        return
    add_inline(p, text, size)


def convert(src, dst):
    with open(src, encoding='utf-8') as f:
        lines = f.read().splitlines()

    doc = Document()
    style_document(doc)

    a, b = year_span('\n'.join(lines))
    sub = f'（{a}-{b}年文献调研）' if b else (f'（{a}年文献调研）' if a else '')

    i = 0
    title_done = False
    section = ''
    gap_no = 0
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
            add_inline(h, m.group(2), 16 if level == 1 else (14 if level == 2 else BODY_PT), base_bold=True, ea=HEAD_EA)
            if level == 2:
                section = m.group(2)   # 记住当前章节，用于第三节字段式、第六节编号
                gap_no = 0
            stats['h'] += 1
            i += 1
            continue

        if re.match(r'^\s*>\s?', line):
            text = re.sub(r'^\s*>\s?', '', line)
            p = doc.add_paragraph()
            indent_chars(p)                            # 顶格后再空两格，说明性文字（11 pt）同样适用
            add_inline(p, text, BODY_PT - 1, color=RGBColor(0x44, 0x44, 0x44))
            stats['p'] += 1
            i += 1
            continue

        m = re.match(r'^(\s*)[-*]\s+(.*)$', line)
        if m:
            depth = len(m.group(1)) // 2
            if depth == 0 and '研究空白' in section:
                # 第六节四个议题改 1./2./3./4. 编号，议题名加粗
                gap_no += 1
                add_numbered(doc, gap_no, m.group(2), BODY_PT, bold_head=True)
                stats['list'] += 1
                i += 1
                continue
            if depth == 0 and '代表性文献评述' in section:
                # 字段式评述：去掉项目符号、顶格，字段名加粗
                p = doc.add_paragraph()
                p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
                p.paragraph_format.space_after = Pt(1)
                add_field(p, m.group(2), BODY_PT)
                stats['list'] += 1
                i += 1
                continue
            style = 'List Bullet' if depth == 0 else 'List Bullet 2'
            p = doc.add_paragraph(style=style)
            p.paragraph_format.space_after = Pt(1)
            add_inline(p, m.group(2), BODY_PT)
            stats['list'] += 1
            i += 1
            continue

        m = re.match(r'^(\s*)(\d+)\.\s+(.*)$', line)
        if m:
            depth = len(m.group(1)) // 2
            if depth >= 1 and '研究空白' in section:
                # 第六节子条目已挂在编号议题下，改用点，避免二级数字与一级数字撞车
                p = doc.add_paragraph(style='List Bullet 2')
                p.paragraph_format.space_after = Pt(1)
                add_inline(p, m.group(3), BODY_PT)
                stats['list'] += 1
                i += 1
                continue
            add_numbered(doc, m.group(2), m.group(3), BODY_PT, 0.74 * depth)
            stats['list'] += 1
            i += 1
            continue

        if re.match(r'^---+$', stripped):
            i += 1
            continue

        if '研究空白' in section and stripped.startswith('**问题陈述**'):
            gap_no += 1
            add_numbered(doc, gap_no, stripped, BODY_PT, bold_head=True)
            stats['p'] += 1
            i += 1
            continue

        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY   # 两端对齐，汉字行末不参差
        indent_chars(p)                            # 首行缩进两字符（随字号自适应）
        add_inline(p, stripped, BODY_PT)
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
