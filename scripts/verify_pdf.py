"""三重校验：%PDF- 头 + 页数 + 首页关键词。

单文件：python verify_pdf.py <文件> [关键词1 关键词2 ...]
批量  ：python verify_pdf.py <目录> [--meta meta.json]

meta.json 为 { "文件名.pdf": { "keywords": ["a","b"] } }，可省略关键词。
批量模式递归扫描目录下 *.pdf，输出汇总表并写 _verify_report.json；任一 FAIL 则退出码 1。
"""
import datetime
import hashlib
import json
import os
import sys

import fitz

MIN_PAGES = 3


def inspect(path: str, keys: list[str]) -> dict:
    raw = open(path, 'rb').read()
    ok_head = raw[:5] == b'%PDF-'
    pages = 0
    first = ''
    try:
        doc = fitz.open(path)
        pages = doc.page_count
        first = ' '.join(doc[0].get_text().split()).lower() if pages else ''
    except Exception as e:  # 损坏的 PDF
        first = ''
    hits = [k for k in keys if k.lower() in first]
    textless = pages > 0 and not first
    if keys:
        passed = ok_head and pages >= MIN_PAGES and bool(hits)
    else:
        passed = ok_head and pages >= MIN_PAGES
    return {
        'file': os.path.basename(path),
        'path': path,
        'head': ok_head,
        'pages': pages,
        'size': len(raw),
        'sha256': hashlib.sha256(raw).hexdigest(),
        'textless': textless,
        'hits': hits,
        'passed': passed,
        'first200': first[:200],
    }


def show(r: dict, verbose: bool) -> None:
    print(f'文件      : {r["file"]}')
    print(f'文件头    : {"%PDF-" if r["head"] else "异常"}')
    print(f'页数      : {r["pages"]}')
    print(f'体积      : {r["size"] / 1048576:.2f} MB')
    print(f'SHA256    : {r["sha256"][:16]}')
    if r['textless']:
        print('文本层    : 无（疑似扫描版，关键词校验不可用）')
    print(f'关键词命中: {r["hits"] if r["hits"] else "无"}')
    if verbose:
        print(f'首页前 200: {r["first200"]}')
    print('结论      : ' + ('PASS' if r['passed'] else 'FAIL'))


def batch(root: str, meta: dict) -> int:
    files = sorted(
        os.path.join(root, f) for f in os.listdir(root)
        if f.lower().endswith('.pdf') and os.path.isfile(os.path.join(root, f))
        and not f.lower().endswith('.unverified.pdf')  # 台账未登记的留档文件，不算库内条目
    )
    if not files:
        print(f'目录下没有 PDF：{root}')
        return 1

    results = []
    for p in files:
        keys = (meta.get(os.path.basename(p)) or {}).get('keywords') or []
        r = inspect(p, keys)
        r['keywords'] = keys
        results.append(r)

    print(f'{"文件":<58} {"页":>3} {"MB":>7} {"SHA16":<17} {"关键词":<10} 结论')
    print('-' * 110)
    for r in results:
        kw = '有' if r['keywords'] and r['hits'] else ('未验' if not r['keywords'] else '缺')
        name = r['file'] if len(r['file']) <= 56 else r['file'][:53] + '...'
        print(f'{name:<58} {r["pages"]:>3} {r["size"] / 1048576:>7.2f} {r["sha256"][:16]:<17} {kw:<10} '
              + ('PASS' if r['passed'] else 'FAIL'))

    # 重复 DOI 检测（跨文件名）与 SHA256 重复检测
    seen = {}
    seen_doi = {}
    dups = []
    for r in results:
        if r['sha256'] in seen:
            dups.append((r['file'], seen[r['sha256']]))
        else:
            seen[r['sha256']] = r['file']
        doi = ((meta.get(r['file']) or {}).get('doi') or '').strip().lower()
        if doi:
            if doi in seen_doi:
                print(f'重复 DOI：{r["file"]} 与 {seen_doi[doi]}')
            else:
                seen_doi[doi] = r['file']
    if dups:
        print('\n重复内容：')
        for a, b in dups:
            print(f'  {a}  ==  {b}')
    else:
        print('\nSHA256 全部唯一')

    failed = [r for r in results if not r['passed']]
    print(f'\n汇总：{len(results) - len(failed)} PASS / {len(failed)} FAIL / 共 {len(results)}')

    # 维护 DOI 台账，供 oa_route 做跨批次去重（ACS 的 PDF 字节不稳定，不能只靠 SHA256）。
    # 抓取脚本落盘时已写 downloaded，这里只在通过校验后补 verified 时间戳。
    index_path = os.path.join(root, '_index.json')
    index = {}
    if os.path.exists(index_path):
        try:
            with open(index_path, encoding='utf-8') as f:
                index = json.load(f)
        except Exception as e:
            print(f'警告：台账解析失败（{index_path}）：{e}；本次重建')
            index = {}
    index = {k: v for k, v in index.items()
             if isinstance(v, dict) and v.get('file')
             and os.path.exists(os.path.join(root, v['file']))}
    stamp = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
    added = 0
    for r in results:
        doi = ((meta.get(r['file']) or {}).get('doi') or '').strip().lower()
        if not doi or not r['passed']:
            continue
        prev = index.get(doi) or {}
        if doi not in index:
            added += 1
        index[doi] = {
            'file': r['file'], 'sha256': r['sha256'], 'pages': r['pages'],
            'bytes': r['size'], 'downloaded': prev.get('downloaded'), 'verified': stamp,
        }
    tmp = index_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    os.replace(tmp, index_path)
    print(f'索引：{index_path}（{len(index)} 条，本次新增 {added}）')

    out = os.path.join(root, '_verify_report.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump([{k: v for k, v in r.items() if k != 'first200'} for r in results], f,
                  ensure_ascii=False, indent=2)
    print(f'报告：{out}')
    return 0 if not failed else 1


if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(2)
    target = args[0]
    rest = args[1:]

    meta = {}
    if '--meta' in rest:
        i = rest.index('--meta')
        with open(rest[i + 1], encoding='utf-8') as f:
            meta = json.load(f)
        rest = rest[:i] + rest[i + 2:]

    if os.path.isdir(target):
        sys.exit(batch(target, meta))
    if not os.path.exists(target):
        print(f'文件不存在：{target}')
        sys.exit(2)
    r = inspect(target, rest)
    show(r, verbose=True)
    sys.exit(0 if r['passed'] else 1)
