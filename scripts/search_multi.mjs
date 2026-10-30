// 关键词 → 候选池：OpenAlex + Crossref 双源检索 → 去重 → 主题门控 → 排序键。
// 不输出综合分，只输出事实（被引年化 / 期刊档 / 年份 / 相关度），排序即分层排序键。
// 用法：node search_multi.mjs <out.json> --query "ceramic nanofiber aerogel" [选项]
//   --query    自由文本检索词，可重复，也可用 ; 分隔多个
//   --concept  概念组，可重复，组内用 | 分隔同义词：--concept "ceramic|ceramics" --concept "aerogel"
//   --from --to  出版窗口，接受 2025 或 2025-03-01
//   --pad      窗口起点再往前放宽的月数（默认 6）。online-first 文章的 OpenAlex
//              publication_date 常比印刷期早数月，不放宽会被 from 挡在窗口外；
//              放进来的记录再用 Crossref 印刷期确认，不属于目标年份的直接剔除
//   --per-page 每源每页条数（默认 50），--pages 最多翻几页（默认 2）
//   --min-cited 最低被引（默认 0），--oa-only 只要检测到 OA 的（Crossref 单独命中的条目会被滤掉）
//   --top 表格打印条数（默认 20），--email 联系邮箱（OpenAlex polite pool / Crossref mailto）
// 输出：[{doi,title,journal,year,date,cited,citedAnnual,tier,tierName,if2y,oa,rel,sources,type,abstract,early,searchDate}]
// 同目录另写 _search_report.json（各源命中、去重前后、门控剔除、年份与期刊档分布、失败源）。
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const OUT = args[0];
if (!OUT || OUT.startsWith('--')) {
  console.log('用法：node search_multi.mjs <out.json> --query "关键词" [--concept "a|b"] [--exclude "x|y"] [--from 2025] [--to 2026]');
  console.log('      [--per-page 50] [--pages 2] [--min-cited N] [--oa-only] [--top 20] [--email you@example.com]');
  process.exit(2);
}

const opt = (n, d = '') => {
  const i = args.indexOf(`--${n}`);
  return i > 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (n) => args.includes(`--${n}`);
const num = (n, d) => {
  const v = Number(opt(n, ''));
  return Number.isFinite(v) && v > 0 ? v : d;
};
const repeat = (n) => {
  const out = [];
  args.forEach((a, i) => { if (a === `--${n}` && args[i + 1] && !args[i + 1].startsWith('--')) out.push(args[i + 1]); });
  return out;
};

const queries = repeat('query').flatMap((q) => q.split(';')).map((s) => s.trim()).filter(Boolean);
const concepts = repeat('concept')
  .map((c) => c.split('|').map((s) => s.trim().toLowerCase()).filter(Boolean))
  .filter((c) => c.length);
// 排除组：命中任意一条即剔除（只看标题），用于挡掉「纤维素/淀粉气凝胶 + 陶瓷装饰层」这类
// 「陶瓷是添加剂而不是基体」的复合体系；写进摘要里会误杀模板法合成的真陶瓷气凝胶
const excludes = repeat('exclude')
  .flatMap((c) => c.split('|'))
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (!queries.length && !concepts.length) {
  console.log('缺少 --query 或 --concept');
  process.exit(2);
}

const FROM_RAW = opt('from', '');
const TO_RAW = opt('to', '');
const perDate = (s, end) => {
  if (!s) return '';
  if (/^\d{4}$/.test(s)) return `${s}-${end ? '12' : '01'}-${end ? '31' : '01'}`;
  return s;
};
const FROM = perDate(FROM_RAW, false);
const TO = perDate(TO_RAW, true);

// online-first 文章在 OpenAlex 的 publication_date 常比印刷期早几周甚至半年，
// 直接按 from 卡会把「2026 年见刊」的文章挡在窗口外。查询端往前放宽 pad 个月，
// 落进放宽区间但早于 from 的记录标 early，随后用 Crossref 印刷期确认归属年份。
const PAD_MONTHS = Math.max(0, Number(opt('pad', 6)) || 0);
function shiftMonths(dateStr, months) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}
const FROM_Q = FROM && PAD_MONTHS ? shiftMonths(FROM, PAD_MONTHS) : FROM;

const PER_PAGE = Math.min(num('per-page', 50), 200);
const PAGES = num('pages', 2);
const MIN_CITED = Number(opt('min-cited', 0)) || 0;
const OA_ONLY = flag('oa-only');
const TOP = num('top', 20);
const MAIL = opt('email', process.env.OPENALEX_MAILTO || process.env.UNPAYWALL_EMAIL || '');
const UA = `search-multi/1.0${MAIL ? ` (mailto:${MAIL})` : ''}`;

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

async function getJson(url, tries = 3) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) return r.json();
      last = `HTTP ${r.status}`;
      if (!(r.status === 429 || r.status >= 500) || i === tries - 1) throw new Error(last);
    } catch (e) {
      last = e.message;
      if (i === tries - 1) throw e;
    }
    await sleep(2000 * (i + 1));
  }
  throw new Error(last);
}

// OpenAlex 的 abstract_inverted_index 要还原成纯文本
function abstractOfOA(w) {
  const inv = w.abstract_inverted_index;
  if (!inv) return '';
  const pairs = Object.entries(inv).flatMap(([word, pos]) => pos.map((p) => [p, word]));
  return pairs.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(' ').slice(0, 600);
}

// 这些类型不是可下载的期刊正文
const OA_SKIP = new Set(['dataset', 'peer-review', 'paratext', 'erratum', 'component', 'software', 'grant']);

const normTitle = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 90);
const cleanOA = (q) => q.replace(/[,:]/g, ' ').replace(/\s+/g, ' ').trim();

const seen = new Map();      // doi 小写 → 记录
const titleIdx = new Map();  // 归一化标题 → doi 小写
const report = {
  queries: queries.length ? queries : concepts.map((c) => c.join(' ')),
  concepts: concepts.map((c) => c.join('|')),
  window: { from: FROM || '', to: TO || '', pad: PAD_MONTHS, queryFrom: FROM_Q || '' },
  sources: {},
  excludes: excludes,
  dedup: { byDoi: 0, byTitle: 0 },
  gate: { dropped: 0, excluded: 0 },
  generatedAt: new Date().toISOString(),
};

function mergeInto(cur, inc) {
  // 只补空缺，不覆盖已知值；被引取较大值
  for (const k of ['journal', 'abstract', 'type']) if (!cur[k] && inc[k]) cur[k] = inc[k];
  if (!cur.date && inc.date) cur.date = inc.date;
  if (!cur.oa && inc.oa) cur.oa = inc.oa;
  if (!cur.srcId && inc.srcId) cur.srcId = inc.srcId;
  if (!cur.rel && inc.rel) cur.rel = inc.rel;
  if (inc.early && !cur.early) cur.early = true;
  if ((inc.cited || 0) > (cur.cited || 0)) cur.cited = inc.cited;
  inc.sources.forEach((s) => cur.sources.add(s));
}

function add(rec) {
  const key = rec.doi.toLowerCase();
  if (seen.has(key)) {
    report.dedup.byDoi++;
    mergeInto(seen.get(key), rec);
    return;
  }
  const tkey = normTitle(rec.title);
  if (tkey.length >= 30 && titleIdx.has(tkey)) {
    // 同标题不同 DOI：预印本 / 正式版 / 重复登记，合并到先出现的那条
    report.dedup.byTitle++;
    mergeInto(seen.get(titleIdx.get(tkey)), rec);
    return;
  }
  seen.set(key, rec);
  if (tkey.length >= 30) titleIdx.set(tkey, key);
}

// ── 源 1：OpenAlex ─────────────────────────────────────────────
const oaTerms = concepts.length
  ? [concepts.map((c) => `(${c.join(' OR ')})`).join(' AND ')]
  : queries;

report.sources.openalex = { used: oaTerms.length, got: 0, failed: 0 };
for (const term of oaTerms) {
  let search = concepts.length ? term : cleanOA(term);
  let retriedPlain = false;
  for (let page = 1; page <= PAGES; page++) {
    // 只对检索值编码；filter 之间的逗号必须保持原样
    const f = [
      `title_and_abstract.search:${encodeURIComponent(search)}`,
      'is_paratext:false',
      FROM_Q ? `from_publication_date:${FROM_Q}` : '',
      TO ? `to_publication_date:${TO}` : '',
    ].filter(Boolean).join(',');
    const url = `https://api.openalex.org/works?filter=${f}`
      + `&per-page=${PER_PAGE}&page=${page}${MAIL ? `&mailto=${encodeURIComponent(MAIL)}` : ''}`;
    let j;
    try {
      j = await getJson(url);
    } catch (e) {
      // 布尔检索式被拒时退回纯文本，避免整轮丢源
      if (concepts.length && !retriedPlain) {
        retriedPlain = true;
        search = cleanOA(concepts.map((c) => c[0]).join(' '));
        page--;
        continue;
      }
      console.log(`WARN openalex 第 ${page} 页失败：${e.message}`);
      report.sources.openalex.failed++;
      break;
    }
    const items = j.results || [];
    for (const w of items) {
      const doi = (w.doi || '').replace(/^https?:\/\/doi\.org\//i, '');
      if (!doi || OA_SKIP.has(w.type) || !w.primary_location?.source) continue;
      if (MIN_CITED && (w.cited_by_count || 0) < MIN_CITED) continue;
      report.sources.openalex.got++;
      add({
        doi,
        title: (w.title || '').replace(/\s+/g, ' ').trim(),
        journal: w.primary_location.source.display_name || '',
        date: w.publication_date || '',
        year: w.publication_year || 0,
        cited: w.cited_by_count || 0,
        oa: w.open_access?.is_oa ? (w.open_access.oa_status || 'oa') : '',
        rel: w.relevance_score || 0,
        type: w.type || '',
        abstract: abstractOfOA(w),
        srcId: (w.primary_location.source.id || '').replace(/^https?:\/\/openalex\.org\//, ''),
        early: !!(FROM && w.publication_date && w.publication_date < FROM),
        sources: new Set(['openalex']),
      });
    }
    if (items.length < PER_PAGE) break;
    await sleep(300);
  }
  console.log(`openalex ${term.slice(0, 40)} → 累计 ${seen.size} 条`);
  await sleep(300);
}

// Crossref 不作为检索源：官方 query.bibliographic 是相关性检索、不支持布尔，
// 三概念组合下只带回大量噪音，而 OpenAlex 本身已索引 Crossref 的期刊记录。
// 实测同一批 2026 文献，Crossref 独有的条目为 0；它的价值（精确日期、刊名、JATS 摘要）
// 由 enrich_meta.mjs 按 DOI 精确补全，比全文相关性检索更准也更省请求。

// ── 期刊档：取 OpenAlex 源的 2yr_mean_citedness ─────────────────
const srcIds = [...new Set([...seen.values()].map((x) => x.srcId).filter(Boolean))];
const stats = new Map();
for (let i = 0; i < srcIds.length; i += 20) {
  const chunk = srcIds.slice(i, i + 20);
  const url = `https://api.openalex.org/sources?filter=openalex_id:${chunk.join('|')}&per-page=50`
    + (MAIL ? `&mailto=${encodeURIComponent(MAIL)}` : '');
  try {
    const j = await getJson(url, 2);
    for (const s of j.results || []) {
      const id = (s.id || '').replace(/^https?:\/\/openalex\.org\//, '');
      stats.set(id, s.summary_stats || {});
    }
  } catch (e) {
    console.log(`WARN 期刊统计获取失败：${e.message}`);
  }
  await sleep(300);
}
report.sources.sourceStats = { requested: srcIds.length, got: stats.size };

// 0 预印本 / 1 无刊名或仅刊名 / 2 普通刊 / 3 主流刊 / 4 高影响刊
// 阈值取 OpenAlex 源的 2yr_mean_citedness，跨学科通用，不按本领域标定
function tierOf(x) {
  const t = (x.type || '').toLowerCase();
  if (t === 'preprint' || t === 'posted-content' || /^10\.(2139|48550)\//.test(x.doi)) return [0, '预印本'];
  if (!x.journal) return [1, '无刊名'];
  const v = stats.get(x.srcId)?.['2yr_mean_citedness'];
  if (!Number.isFinite(v) || v <= 0) return [1, '仅刊名'];
  if (v >= 7) return [4, '高影响'];
  if (v >= 2.5) return [3, '主流刊'];
  return [2, '普通刊'];
}

// ── 主题门控：概念组必须全部命中（只在给了 --concept 时生效）──
// Crossref 的 query.bibliographic 是相关性检索、非布尔，会带进只命中部分概念的噪声；
// 与 OpenAlex 侧的 AND 语义保持一致，缺任一组即剔除。同义词请写进同一组。
const hay = (x) => `${x.title} ${x.abstract}`.toLowerCase();
for (const x of seen.values()) {
  const [tier, tierName] = tierOf(x);
  x.tier = tier;
  x.tierName = tierName;
  // if2y：OpenAlex 源的「近两年篇均被引」，是影响因子的近似量，不是 JCR 官方 IF
  const jv = x.journal && tier > 0 ? stats.get(x.srcId)?.['2yr_mean_citedness'] : null;
  x.if2y = Number.isFinite(jv) && jv > 0 ? Number(jv.toFixed(1)) : null;
  if (!x.year && x.date) x.year = Number(x.date.slice(0, 4));
  x.sources = [...x.sources].sort();
}
if (excludes.length) {
  report.gate.excluded = 0;
  for (const [k, x] of [...seen]) {
    const title = (x.title || '').toLowerCase();
    if (excludes.some((s) => title.includes(s))) {
      seen.delete(k);
      report.gate.excluded++;
      delete titleIdx.get(normTitle(x.title));
    }
  }
}
if (concepts.length) {
  const need = concepts.length;
  for (const [k, x] of [...seen]) {
    const hit = concepts.filter((c) => c.some((s) => hay(x).includes(s))).length;
    if (hit < need) {
      seen.delete(k);
      report.gate.dropped++;
    }
  }
}

// ── 窗口前段确认：`early` 记录用 Crossref 印刷期判定归属年份 ──────
// pad 区间里混着两类：online-first 但印刷期落在目标年份（要）与货真价实的
// 上一年论文（不要）。日期分不开，只有印刷期能分开，所以逐条查 Crossref。
// 查不到时保留并保留 early 标记，留给 enrich_meta 重试，宁可多留不可漏掉高被引。
report.pad = { early: 0, confirmed: 0, dropped: 0, failed: 0 };
// 目标年份是个区间（--from 2025 --to 2026 时两年都算），不能只拿 to 的年份判
const YEAR_FROM = FROM ? Number(FROM.slice(0, 4)) : 0;
const YEAR_TO = TO ? Number(TO.slice(0, 4)) : 0;
const WIN_LABEL = YEAR_FROM && YEAR_TO && YEAR_FROM !== YEAR_TO
  ? `${YEAR_FROM}–${YEAR_TO} 年`
  : `${YEAR_TO || YEAR_FROM} 年`;
const yearInWindow = (y) => (!YEAR_FROM || y >= YEAR_FROM) && (!YEAR_TO || y <= YEAR_TO);

async function crPrint(doi) {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`
    + (MAIL ? `?mailto=${encodeURIComponent(MAIL)}` : '');
  try {
    const j = await getJson(url, 3);
    const m = j.message || {};
    const pick = m['published-print'] || m.published || m['published-online'] || {};
    const p = (pick['date-parts'] || [])[0] || [];
    if (!p.length || !Number.isFinite(Number(p[0]))) return null;
    const date = p.length >= 3
      ? `${p[0]}-${String(p[1]).padStart(2, '0')}-${String(p[2]).padStart(2, '0')}`
      : '';
    return { year: Number(p[0]), date, isPrint: !!m['published-print'] };
  } catch {
    return null;
  }
}

if (PAD_MONTHS && FROM && YEAR_TO) {
  for (const [k, x] of [...seen]) {
    if (!x.early) continue;
    report.pad.early++;
    const cr = await crPrint(x.doi);
    if (!cr) {
      report.pad.failed++;
      continue;
    }
    if (!yearInWindow(cr.year)) {
      seen.delete(k);
      report.pad.dropped++;
      continue;
    }
    report.pad.confirmed++;
    x.searchDate = x.date;
    if (cr.date) x.date = cr.date;
    x.year = cr.year;
    x.printConfirmed = cr.isPrint;
    x.early = false;
    await sleep(200);
  }
}

// ── 排序键：被引年化 ↓ → 期刊档 ↓ → 相关度 ↓ ─────────────────
const TODAY = Date.now();
const NOMINAL = 0.5; // 年龄下限，防止刚上线文章除零
for (const x of seen.values()) {
  let ageYears = 2;
  if (x.date && /^\d{4}-\d{2}-\d{2}/.test(x.date)) {
    ageYears = (TODAY - new Date(`${x.date.slice(0, 10)}T00:00:00Z`).getTime()) / 31557600000;
  } else if (x.year) {
    ageYears = (TODAY - new Date(`${x.year}-07-01T00:00:00Z`).getTime()) / 31557600000;
  }
  x.citedAnnual = Number((x.cited / Math.max(ageYears, NOMINAL)).toFixed(2));
}

let all = [...seen.values()];
if (OA_ONLY) all = all.filter((x) => x.oa);
if (!all.length) {
  console.log('没有检索到可用的文献');
  process.exit(1);
}
all.sort((a, b) => b.citedAnnual - a.citedAnnual || b.tier - a.tier || b.rel - a.rel);

// ── 报告与落盘 ───────────────────────────────────────────────
report.result = { count: all.length, oa: all.filter((x) => x.oa).length };
report.dedup.before = report.sources.openalex.got;
report.dedup.after = all.length;
report.dedup.unique = seen.size;
report.pad.unconfirmed = all.filter((x) => x.early).length;
report.years = all.reduce((m, x) => ((m[x.year || '未知'] = (m[x.year || '未知'] || 0) + 1), m), {});
report.tiers = all.reduce((m, x) => ((m[x.tierName] = (m[x.tierName] || 0) + 1), m), {});
report.sourceOf = all.reduce((m, x) => {
  const k = x.sources.join('+');
  m[k] = (m[k] || 0) + 1;
  return m;
}, {});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(all, null, 2));
fs.writeFileSync(path.join(path.dirname(OUT), '_search_report.json'), JSON.stringify(report, null, 2));

console.log(`\n候选池 ${all.length} 条 → ${OUT}`);
console.log(`源：openalex ${report.sources.openalex.got} 条命中`
  + `；去重 -${report.dedup.byDoi + report.dedup.byTitle}（DOI ${report.dedup.byDoi}、标题 ${report.dedup.byTitle}）`
  + (report.gate.excluded ? `；排除基体 ${report.gate.excluded}` : '')
  + (report.gate.dropped ? `；门控剔除 ${report.gate.dropped}` : ''));
console.log(`窗口：查询 ${FROM_Q || '不限'} → ${TO || '不限'}（pad ${PAD_MONTHS} 月）`
  + (report.pad.early
    ? `；前段 ${report.pad.early} 条经 Crossref 确认：印刷期属 ${WIN_LABEL} ${report.pad.confirmed} 条`
      + `、属其他年份剔除 ${report.pad.dropped} 条`
      + (report.pad.failed ? `、查不到保留 ${report.pad.failed} 条` : '')
    : ''));
console.log(`OA ${report.result.oa}；期刊档 ${JSON.stringify(report.tiers)}；年份 ${JSON.stringify(report.years)}`);
console.log(`${'#'.padStart(3)} ${'年化'.padStart(5)} ${'被引'.padStart(4)} ${'期刊档'.padEnd(8)} ${'IF≈'.padStart(5)} ${'日期'.padEnd(10)} ${'期刊'.padEnd(22)} ${'源'.padEnd(9)} DOI`);
const dateCell = (x) => (x.date || String(x.year)) + (x.searchDate ? '*' : '');
const ifCell = (x) => (x.if2y == null ? '—' : x.if2y.toFixed(1));
all.slice(0, TOP).forEach((x, i) => {
  console.log(`${String(i + 1).padStart(3)} ${String(x.citedAnnual).padStart(5)} ${String(x.cited).padStart(4)} `
    + `${x.tierName.padEnd(8)} ${ifCell(x).padStart(5)} ${dateCell(x).padEnd(10)} ${x.journal.slice(0, 22).padEnd(22)} `
    + `${x.sources.join('+').padEnd(9)} ${x.doi}`);
});
const starred = all.filter((x) => x.searchDate).length;
if (starred) console.log(`* ${starred} 条为 online-first 上线日；印刷期经 Crossref 确认属 ${WIN_LABEL}`);
console.log('IF≈ 为 OpenAlex 近两年篇均被引（2yr_mean_citedness），与 JCR 官方 IF 口径不同，仅供横向对比');
