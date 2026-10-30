// 检索阶段补全 publisher / host / pii，并顺带生成标题、刊名、年份、文件名与 meta.json。
// 同时补 pubDate（印刷期优先的精确出版日）、pubPrintYear 与 abstractCr（Crossref JATS 摘要全文），
// 供检索端的分析层使用：OpenAlex 的摘要默认截断到 600 字，语义判断需要完整摘要。
// 用法：node enrich_meta.mjs <in.json> <out.json> [--meta meta.json]
// 输入：候选池数组，至少含 doi；输出：原样保留并新增 publisher、host、pii、title、journal、year、firstAuthor、file、pubDate、pubPrintYear、abstractCr。
// meta.json 形如 { "文件名.pdf": { "doi": "...", "keywords": ["..."] } }，直接喂给 verify_pdf.py。
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './lib_pdf.mjs';

const IN = process.argv[2];
const OUT = process.argv[3];
if (!IN || !OUT) {
  console.log('用法：node enrich_meta.mjs <in.json> <out.json> [--meta meta.json]');
  process.exit(2);
}
const mi = process.argv.indexOf('--meta');
const META = mi > 0 ? process.argv[mi + 1] : path.join(path.dirname(OUT), 'meta.json');

const EMAIL = process.env.UNPAYWALL_EMAIL || '';
const UA = `meta-enrich/1.0${EMAIL ? ` (mailto:${EMAIL})` : ''}`;
const items = readJson(IN);

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
      await new Promise((s) => setTimeout(s, 1000 * (i + 1)));
      continue;
    }
    throw new Error(`HTTP ${r.status}`);
  }
}

// Crossref 的 date-parts 精度不一（只有年 / 年-月 / 年月日），按实际精度输出，不补 01 造精确假象
function dateOf(o) {
  const p = (o?.['date-parts'] || [])[0] || [];
  if (!p.length || !Number.isFinite(Number(p[0]))) return '';
  const y = p[0];
  if (p.length === 1) return String(y);
  const mo = String(p[1]).padStart(2, '0');
  if (p.length === 2) return `${y}-${mo}`;
  return `${y}-${mo}-${String(p[2]).padStart(2, '0')}`;
}

// JATS 摘要带 <jats:p> 等标签，去掉标签后压平空白
const stripJats = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Crossref 的 link[].URL 才是真实托管地址；OpenAlex 的 landing_page_url 几乎全是 doi.org
async function enrichOne(it) {
  const doi = it.doi;
  const out = { ...it };
  try {
    const m = (await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)).message;
    out.publisher = m.publisher || '';
    const links = (m.link || []).filter((l) => l.URL);
    // Wiley / Elsevier 常在 link 里放 TDM 端点（api.wiley.com、api.elsevier.com），
    // 那是给机器取的接口，浏览器打不开；host 只认能落地文章页的域名
    const pageLink = links.find((l) => !/^api\./i.test(l.URL.replace(/^https?:\/\//, '').split('/')[0])) || links[0];
    const pdfLink = links.find((l) => /pdf/i.test(l['content-type'] || '')) || links[0];
    out.host = pageLink ? pageLink.URL.replace(/^https?:\/\//, '').split('/')[0] : '';
    const alt = (m['alternative-id'] || []).find((x) => /^S\d/.test(x));
    out.pii = alt || ((pdfLink?.URL || '').match(/(S\d{8,})/) || [])[1] || '';
    out.title = (m.title || [])[0] || '';
    out.journal = (m['container-title'] || [])[0] || '';
    // 印刷期优先：Elsevier / Wiley 的 online-first 与印刷期常差数月，
    // issued 常是上线年，按它算年份会把 2026 见刊的文章记成 2025
    out.pubPrintYear = Number(((m['published-print']?.['date-parts'] || [])[0] || [])[0]) || '';
    out.year = out.pubPrintYear
      || (m.issued?.['date-parts']?.[0]?.[0])
      || (m.published?.['date-parts']?.[0]?.[0]) || '';
    out.firstAuthor = (m.author || [])[0]?.family || '';
    out.pubDate = dateOf(m['published-print'])
      || dateOf(m.published)
      || dateOf(m.issued)
      || dateOf(m['published-online']);
    out.abstractCr = stripJats(m.abstract);
  } catch (e) {
    out.enrichError = e.message;
    try {
      const w = await getJson(`https://api.openalex.org/works/doi:${doi}`);
      const locs = [w.primary_location, ...(w.locations || [])].filter(Boolean);
      out.publisher = locs.map((l) => l.source?.host_organization_name).find(Boolean) || '';
      out.host = '';
      out.title = out.title || w.title || '';
      out.journal = out.journal || (w.primary_location?.source?.display_name || '');
      out.year = out.year || w.publication_year || '';
      out.firstAuthor = out.firstAuthor || (w.authorships?.[0]?.author?.display_name || '').split(' ').pop() || '';
      out.pubDate = out.pubDate || w.publication_date || '';
    } catch {}
  }
  return out;
}

const result = new Array(items.length);
let idx = 0;
async function worker() {
  while (idx < items.length) {
    const i = idx++;
    result[i] = await enrichOne(items[i]);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);

// 摘要兜底：Elsevier 不向 Crossref 提供摘要，OpenAlex 也常缺（2026 新刊尤其明显）。
// 这里用 Semantic Scholar 批量接口补一次（一次请求、失败不致命），补不到就标空，由分析层降级处理。
const noAbsYet = result.filter((x) => !x.abstractCr && !(x.abstract || '').trim());
if (noAbsYet.length) {
  try {
    const r = await fetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=abstract', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ ids: noAbsYet.map((x) => `DOI:${x.doi}`) }),
      signal: AbortSignal.timeout(30000),
    });
    if (r.ok) {
      const j = await r.json();
      noAbsYet.forEach((x, i) => {
        const s = (j[i]?.abstract || '').replace(/\s+/g, ' ').trim();
        if (s) x.abstractS2 = s;
      });
    }
  } catch {}
}

// 选定最终摘要：Crossref 优先（完整 JATS），其次 S2，最后 OpenAlex（截断到 600 字）
for (const x of result) {
  if (x.abstractCr) { x.absText = x.abstractCr; x.absSrc = 'crossref'; }
  else if (x.abstractS2) { x.absText = x.abstractS2; x.absSrc = 's2'; }
  else if ((x.abstract || '').trim()) { x.absText = x.abstract.trim(); x.absSrc = 'openalex'; }
  else { x.absText = ''; x.absSrc = ''; }
}

// 文件名缺省时按 {年}_{首作者}_{DOI后缀}.pdf 生成，保证可复现且唯一
const safe = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 48);
for (const it of result) {
  if (!it.file) it.file = `${safe(it.year) || 'nd'}_${safe(it.firstAuthor) || 'Anon'}_${safe(it.doi.split('/')[1])}.pdf`;
}

// 关键词只取标题里较长的词，verify 只需命中其一。
// 连字符词在 PDF 里常被行尾断开，改用其中最长的一段，避免校验必然落空。
const STOP = new Set(['with', 'from', 'using', 'based', 'study', 'effect', 'effects', 'highly', 'high', 'into', 'under', 'toward', 'towards', 'between', 'through', 'their', 'these', 'those', 'novel', 'enhanced', 'recent', 'there']);
function keywordsOf(it) {
  const words = ((it.title || '').toLowerCase().match(/[a-z][a-z-]{4,}/g) || [])
    .map((w) => (w.includes('-') ? w.split('-').sort((a, b) => b.length - a.length)[0] : w))
    .filter((w) => w.length >= 5);
  const uniq = [...new Set(words.filter((w) => !STOP.has(w)))];
  uniq.sort((a, b) => b.length - a.length);
  const pick = uniq.slice(0, 3);
  if (!pick.length && it.journal) pick.push(it.journal.toLowerCase());
  if (!pick.length) pick.push((it.doi || '').split('/')[1]);
  return pick;
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
const meta = {};
for (const it of result) meta[it.file] = { doi: it.doi, keywords: keywordsOf(it) };
fs.mkdirSync(path.dirname(META), { recursive: true });
fs.writeFileSync(META, JSON.stringify(meta, null, 2));

const withPub = result.filter((x) => x.publisher).length;
const withHost = result.filter((x) => x.host).length;
const hosts = {};
for (const x of result) if (x.host) hosts[x.host] = (hosts[x.host] || 0) + 1;
const withDate = result.filter((x) => x.pubDate).length;
const withPrint = result.filter((x) => x.pubPrintYear).length;
const absBy = result.reduce((m, x) => ((m[x.absSrc || '无摘要'] = (m[x.absSrc || '无摘要'] || 0) + 1), m), {});
console.log(`完成 ${result.length} 条：publisher ${withPub}，host ${withHost}，`
  + `pubDate ${withDate}，印刷年 ${withPrint}`);
console.log(`摘要来源：${JSON.stringify(absBy)}`);
const noAbs = result.filter((x) => !x.absText);
if (noAbs.length) {
  // 无摘要的条目只能用标题判断，分析层必须显式标注，不能装作有据可依
  console.log(`无摘要 ${noAbs.length} 条（仅凭标题判断）：${noAbs.slice(0, 5).map((x) => x.doi).join(' ')}${noAbs.length > 5 ? ' …' : ''}`);
}
for (const [h, n] of Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(3)}  ${h}`);
}
console.log(`meta.json 已写入 ${META}（${Object.keys(meta).length} 条关键词）`);
