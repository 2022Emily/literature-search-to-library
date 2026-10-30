// 候选池 → 分析底稿：只做可计算的事实（检索概况 / 主题簇候选 / 获取性预判 / 缺口清单），
// 语义判断（第三节评述、A–D 分组、空白分析）留给 agent 在 _analysis.md 里填。
// 脚本绝不编造评语：所有结论性段落都是 _(待填)_ 占位。
// 用法：node analyze_pool.mjs <pool_enriched.json> [--report _search_report.json] [--top 15] [--clusters 5]
// 输出：同目录 _analysis_stats.json 与 _analysis_draft.md
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const IN = args[0];
if (!IN || IN.startsWith('--')) {
  console.log('用法：node analyze_pool.mjs <pool_enriched.json> [--report _search_report.json] [--top 15] [--clusters 5]');
  process.exit(2);
}

const opt = (n, d = '') => {
  const i = args.indexOf(`--${n}`);
  return i > 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const num = (n, d) => {
  const v = Number(opt(n, ''));
  return Number.isFinite(v) && v > 0 ? v : d;
};

const TOP = num('top', 15);
const MAX_CLUSTERS = num('clusters', 5);
const DIR = path.dirname(path.resolve(IN));
const pool = JSON.parse(fs.readFileSync(IN, 'utf8'));
if (!Array.isArray(pool) || !pool.length) {
  console.log('候选池为空');
  process.exit(1);
}

// 检索报告可选：有就读，用来还原去重与门控的原始数字
let sr = null;
const srPath = opt('report', path.join(DIR, '_search_report.json'));
if (fs.existsSync(srPath)) {
  try { sr = JSON.parse(fs.readFileSync(srPath, 'utf8')); } catch {}
}

// Crossref 标题里常带 HTML 实体和标签（&amp; / &lt;sub&gt;），直接进表格会把列撑断
const clean = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&nbsp;': ' ', '&#39;': "'" }[m] || ' '))
  .replace(/\s+/g, ' ')
  .trim();
for (const x of pool) {
  x.title = clean(x.title);
  x.journal = clean(x.journal);
}

const absOf = (x) => (x.absText || x.abstractCr || x.abstractS2 || x.abstract || '').trim();
const absSrcOf = (x) => x.absSrc || (absOf(x) ? 'openalex' : '');
const pct = (a, b) => (b ? `${a}/${b}（${Math.round((a / b) * 100)}%）` : '—');
const median = (ns) => {
  if (!ns.length) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ── 基本事实 ────────────────────────────────────────────────
const N = pool.length;
const years = pool.reduce((m, x) => ((m[x.year || '未知'] = (m[x.year || '未知'] || 0) + 1), m), {});
const tiers = pool.reduce((m, x) => ((m[x.tierName || '未知'] = (m[x.tierName || '未知'] || 0) + 1), m), {});
const pubs = pool.reduce((m, x) => {
  const k = x.publisher || (x.doi || '').split('/')[0] || '未知';
  m[k] = (m[k] || 0) + 1;
  return m;
}, {});
const cited = pool.map((x) => x.cited || 0).filter((n) => n > 0);
const annual = pool.map((x) => x.citedAnnual || 0);
const ifs = pool.map((x) => x.if2y).filter((v) => Number.isFinite(v));

// 摘要覆盖：直接决定后续能不能做语义判断，必须显式呈现
const absBy = pool.reduce((m, x) => {
  const k = absSrcOf(x) || 'none';
  m[k] = (m[k] || 0) + 1;
  return m;
}, {});
const noAbs = pool.filter((x) => !absOf(x));

// 获取性预判：只按已知元数据分三类，不猜具体通道（那要 dispatch 才能定）
const accessOf = (x) => (x.oa ? 'direct' : x.host ? 'browser' : 'unknown');
const access = pool.reduce((m, x) => {
  const k = accessOf(x);
  m[k] = (m[k] || 0) + 1;
  return m;
}, {});

// ── 主题簇候选：TF-IDF + 单遍质心聚类 ───────────────────────
// 用标题（权重 2）+ 摘要前 400 字构成向量，不依赖任何领域词表，
// 换课题也能用；簇名留空，由 agent 起名（脚本起的名字没有信息量）。
const STOP = new Set(`a an the and or of for in on with via by to from at as is are be was were been
this that these those using used use based study studies new high low higher lower effect effects
effective properties property performance via toward towards through into under over between among
its their our we here shows show shown results result method methods approach applications application
potential novel design fabrication prepared prepare synthesis synthesized characterization
different various several both also however moreover thus therefore which while where when than more most
such can could may might has have had not only very well these it's its towards review insight insights
recent progress advance advances strategy strategies structural structure structures type types kind
temperature temperatures paper work present herein reported report first time greatly significantly
enhanced excellent superior facile simple effective improved tunable controllable rational
author authors corresponding reserved rights elsevier ltd all rights reserved abstract graphical`
  .split(/\s+/).filter(Boolean));

const tok = (s) => (s || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .split(' ')
  .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !STOP.has(w));

const docs = pool.map((x) => {
  const tt = tok(x.title);
  const at = tok(absOf(x).slice(0, 400));
  const tf = new Map();
  tt.forEach((w) => tf.set(w, (tf.get(w) || 0) + 2));
  at.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
  return { x, tf };
});

const df = new Map();
docs.forEach(({ tf }) => { for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1); });
const idf = (w) => Math.log((N + 1) / ((df.get(w) || 0) + 1)) + 1;

docs.forEach((d) => {
  const v = new Map();
  for (const [w, f] of d.tf) v.set(w, f * idf(w));
  const norm = Math.sqrt([...v.values()].reduce((s, z) => s + z * z, 0)) || 1;
  for (const [w, z] of v) v.set(w, z / norm);
  d.v = v;
});

const cos = (a, b) => {
  let s = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [w, z] of small) s += z * (big.get(w) || 0);
  return s;
};

// 高被引先入场：让高影响力文献当种子，后面用平均连接层次聚类。
// 只按相似度自然合并，不强行压到 K 簇——候选池同题文献多，硬压会把无关条目挤成一团。
const order = [...docs].sort((a, b) => (b.x.citedAnnual || 0) - (a.x.citedAnnual || 0));
const MERGE_MIN = 0.12;   // 低于此相似度就不再合并
const groups = order.map((d) => ({ members: [d] }));
const avgLink = (g, h) => {
  let s = 0;
  let n = 0;
  for (const a of g.members) for (const b of h.members) { s += cos(a.v, b.v); n++; }
  return n ? s / n : 0;
};
while (groups.length > 1) {
  let bi = -1;
  let bj = -1;
  let bs = -1;
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const s = avgLink(groups[i], groups[j]);
      if (s > bs) { bs = s; bi = i; bj = j; }
    }
  }
  if (bs < MERGE_MIN) break;
  groups[bi] = { members: [...groups[bi].members, ...groups[bj].members] };
  groups.splice(bj, 1);
}
const clusters = groups;

const clusterOut = clusters
  .map((c) => {
    const agg = new Map();
    c.members.forEach((m) => { for (const [w, z] of m.v) agg.set(w, (agg.get(w) || 0) + z); });
    const terms = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
    const items = c.members
      .map((m) => m.x)
      .sort((a, b) => (b.citedAnnual || 0) - (a.citedAnnual || 0));
    return {
      size: items.length,
      terms,
      hasAbstract: items.filter((x) => absOf(x)).length,
      topCited: items[0]?.cited || 0,
      items: items.map((x) => ({ doi: x.doi, title: x.title, journal: x.journal, cited: x.cited, citedAnnual: x.citedAnnual, if2y: x.if2y, hasAbs: !!absOf(x) })),
    };
  })
  .sort((a, b) => b.size - a.size);

// 全局主题词：只作为「这批文献都在谈什么」的旁证
const globalTerms = [...df.entries()]
  .map(([w, c]) => ({ w, c, score: c * idf(w) }))
  .filter((t) => t.c >= 2)
  .sort((a, b) => b.score - a.score)
  .slice(0, 20)
  .map((t) => `${t.w}(${t.c})`);

// 标题特征词：在 ≥3 篇标题里出现的词，等于谱系标签的候选。
// 文本相似度在同类短标题上区分度有限，靠这张覆盖表让 agent 按内容自行分体系更可靠。
const titleDf = new Map();
docs.forEach(({ x }) => new Set(tok(x.title)).forEach((w) => titleDf.set(w, (titleDf.get(w) || 0) + 1)));
const featureTerms = [...titleDf.entries()]
  .filter(([, c]) => c >= 3)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)
  .map(([w, c]) => ({ word: w, docs: c, sample: pool.filter((x) => tok(x.title).includes(w)).slice(0, 3).map((x) => x.doi) }));

// 评述候选：有摘要才可能细评，无摘要一律进「待读」区，不冒充细评
const rank = [...pool].sort((a, b) => (b.citedAnnual || 0) - (a.citedAnnual || 0) || (b.tier || 0) - (a.tier || 0));

// 零被引·高影响刊：同一年份的文献里被引年化退化成「被引×2」，
// 零被引条目会被有引用的整体压在末尾，高影响新刊因此沉底（如 Nature Communications 的 0 引新文）。
// 单独拎出来按 期刊档 → IF≈ → 相关度 排，不改动主排序键。
const ZERO_TIER_MIN = 3;
const stars = pool
  .filter((x) => (x.cited || 0) === 0 && (x.tier || 0) >= ZERO_TIER_MIN)
  .sort((a, b) => (b.tier || 0) - (a.tier || 0) || (b.if2y || 0) - (a.if2y || 0) || (b.rel || 0) - (a.rel || 0));
const starDoiSet = new Set(stars.map((x) => x.doi));

// 评述双轨：主轨取排序键前 TOP；副轨从零被引高影响刊里补最多 STAR_CARDS 条有摘要的，
// 让它们也能拿到字段完整的细评，而不是只露一个标题
const STAR_CARDS = 6;
const cardItems = rank.filter((x) => absOf(x)).slice(0, TOP);
const cardDoiSet = new Set(cardItems.map((x) => x.doi));
const starCards = stars.filter((x) => absOf(x) && !cardDoiSet.has(x.doi)).slice(0, STAR_CARDS);
cardItems.push(...starCards);
// 补位后重建集合：2.4 的「细评」列和 stats 都按最终卡片清单判断
const inCardSet = new Set(cardItems.map((x) => x.doi));

const unread = rank.filter((x) => !absOf(x));
const edge = rank.filter((x) => !absOf(x) || (x.citedAnnual || 0) <= 1).slice(0, 10);

const stats = {
  source: { file: path.basename(IN), enriched: pool.some((x) => x.publisher !== undefined) },
  generatedAt: new Date().toISOString(),
  pool: {
    total: N,
    window: sr?.window || {},
    padConfirm: sr?.pad || {},
    dedup: sr?.dedup || {},
    gate: sr?.gate || {},
    years, tiers,
    ifMedian: Number(median(ifs).toFixed(2)) || null,
    ifMax: ifs.length ? Math.max(...ifs) : null,
    cited: {
      withCitations: cited.length,
      total: cited.reduce((s, n) => s + n, 0),
      median: median(cited),
      max: Math.max(...cited),
      annualMedian: Number(median(annual).toFixed(2)),
      annualMax: Math.max(...annual),
    },
    oa: pool.filter((x) => x.oa).length,
    publishers: pubs,
  },
  abstract: { by: absBy, missing: noAbs.length, missingDois: noAbs.map((x) => x.doi) },
  access,
  clusters: clusterOut,
  globalTerms,
  featureTerms,
  stars: stars.map((x) => ({
    doi: x.doi,
    title: x.title,
    journal: x.journal,
    tier: x.tier,
    tierName: x.tierName,
    if2y: x.if2y,
    date: x.date,
    hasAbs: !!absOf(x),
    inCards: inCardSet.has(x.doi),
  })),
  cards: cardItems.map((x) => x.doi),
  unread: unread.map((x) => ({ doi: x.doi, journal: x.journal, cited: x.cited, citedAnnual: x.citedAnnual, if2y: x.if2y, title: x.title })),
};

const statsPath = path.join(DIR, '_analysis_stats.json');
fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));

// ── 生成底稿 ────────────────────────────────────────────────
const T = '_(待填)_';
const short = (s, n = 78) => {
  const c = clean(s);
  return c.length > n ? `${c.slice(0, n)}…` : (c || '');
};
const cell = (s, n = 78) => short(s, n).replace(/\|/g, '/');
// 表格里的标题不截断：题目是选片的主要依据，缺了后半句会误判
const cellFull = (s) => clean(s).replace(/\|/g, '/');
const yearCell = (x) => (x.date || String(x.year || ''));
const tbl = (rows, head) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows].join('\n');

const md = [];
md.push(`# 文献分析底稿`);
md.push('');
md.push(`> 本文件由 \`analyze_pool.mjs\` 生成，只含可计算的事实。`);
md.push(`> 所有 \`${T}\` 标记必须由 agent 依据摘要证据填写；无摘要条目不写评语。`);
md.push(`> 数据源：\`${path.basename(IN)}\`｜生成于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
md.push('');

// 一、文献来源与筛选
md.push('## 一、文献来源与筛选');
md.push('');
if (sr) {
  // 只给 --concept 时 queries 为空，search_multi 会用概念组回填，别重复展示
  const qline = (sr.queries || []).join('；');
  if (qline && !(sr.concepts?.length && qline === sr.concepts.map((c) => c.split('|').join(' ')).join('；'))) {
    md.push(`- 检索词：${qline}`);
  }
  if (sr.concepts?.length) md.push(`- 概念组（全部须命中）：${sr.concepts.map((c) => `\`${c}\``).join(' ∧ ')}`);
  if (sr.excludes?.length) md.push(`- 反向排除（仅匹配标题）：${sr.excludes.map((c) => `\`${c}\``).join(', ')}`);
  const w = sr.window || {};
  md.push(`- 时间窗口：${w.from || '不限'} → ${w.to || '不限'}${w.pad ? `（查询放宽 ${w.pad} 月，起点 ${w.queryFrom}）` : ''}`);
  if (sr.pad?.early) md.push(`- 窗口前段核验：${sr.pad.early} 条 online-first 经 Crossref 印刷期确认，保留 ${sr.pad.confirmed}、剔除 ${sr.pad.dropped}${sr.pad.failed ? `、无法确认 ${sr.pad.failed}` : ''}`);
  if (sr.dedup) md.push(`- 去重：DOI 重复 ${sr.dedup.byDoi || 0}、同题重复 ${sr.dedup.byTitle || 0}`);
  if (sr.gate) md.push(`- 主题门控：反向排除 ${sr.gate.excluded || 0}、概念不全剔除 ${sr.gate.dropped || 0}`);
}
md.push(`- **最终候选：${N} 条**；年份 ${Object.entries(years).map(([y, c]) => `${y}:${c}`).join(' / ')}`);
md.push(`- 期刊档：${Object.entries(tiers).map(([k, c]) => `${k} ${c}`).join(' / ')}；IF≈ 中位 ${stats.pool.ifMedian ?? '—'}、最高 ${stats.pool.ifMax ?? '—'}`);
md.push(`- 被引：有引用 ${cited.length} 条，中位 ${stats.pool.cited.median}、最高 ${stats.pool.cited.max}；被引年化中位 ${stats.pool.cited.annualMedian}、最高 ${stats.pool.cited.annualMax}`);
md.push(`- 开放获取：${pct(pool.filter((x) => x.oa).length, N)}；获取性预判 直取 ${access.direct || 0} / 浏览器 ${access.browser || 0} / 未知 ${access.unknown || 0}`);
md.push(`- 摘要覆盖：${Object.entries(absBy).map(([k, c]) => `${k} ${c}`).join(' / ')}；**缺失 ${noAbs.length} 条** ${noAbs.length ? '（详见第四节）' : ''}`);
md.push(`- 主要出版方：${Object.entries(pubs).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, c]) => `${k} ${c}`).join(' / ')}`);
md.push(`- 高频主题词：${globalTerms.slice(0, 12).join('、')}`);
md.push('');
md.push(`**总体判断**：${T}`);
md.push('');

// 二、研究方向的谱系划分
md.push('## 二、研究方向的谱系划分');
md.push('');
md.push(`> 文本相似度只作为**线索**：下列 ${clusterOut.length} 个簇由标题+摘要词向量自然合并而成，簇名没有实质含义。`);
md.push(`> 同题文献标题高度雷同、差异藏在材料体系与工艺细节里，聚类分不清——请以「高频主题词分布」和摘要内容为准，自行划分直接相关 / 边缘相关 / 无关。`);
md.push('');
md.push('### 2.1 高频主题词分布（≥3 篇共现）');
md.push('');
md.push(tbl(
  featureTerms.map((t) => `| \`${t.word}\` | ${t.docs} | ${Math.round((t.docs / N) * 100)}% | ${t.sample.join(' ')} |`),
  ['特征词', '覆盖条数', '占比', '示例 DOI'],
));
md.push('');
md.push('### 2.2 文献聚类结果（前 ' + Math.min(MAX_CLUSTERS, clusterOut.length) + ' 簇）');
md.push('');
clusterOut.slice(0, MAX_CLUSTERS).forEach((c, i) => {
  md.push(`### 簇 ${i + 1}（${c.size} 条｜有摘要 ${c.hasAbstract}｜最高被引 ${c.topCited}）`);
  md.push('');
  md.push(`- 特征词：${c.terms.join('、')}`);
  md.push(`- 建议命名：${T}`);
  md.push(`- 归类：${T}（直接相关 / 边缘相关 / 无关）`);
  md.push('');
  md.push(tbl(
    c.items.slice(0, 6).map((x, j) => `| ${j + 1} | ${cellFull(x.title)} | ${x.journal || '—'} | ${x.cited} | ${x.citedAnnual} | ${x.hasAbs ? '有' : '无'} |`),
    ['#', '标题', '期刊', '被引', '年化', '摘要'],
  ));
  md.push('');
});

// 未进入展示簇的条目：多为孤立文本，不等于无关，交给 agent 按内容判断
const restClusters = clusterOut.slice(MAX_CLUSTERS);
if (restClusters.length) {
  const restItems = restClusters.flatMap((c) => c.items);
  md.push(`### 2.3 未归类文献（${restItems.length} 篇）`);
  md.push('');
  md.push('> 这些文献与主簇文本相似度不足，既可能是差异化创新点所在，也可能是检索边界溢出，需逐篇依据摘要判定。');
  md.push('');
  md.push(tbl(
    restItems.map((x, j) => `| ${j + 1} | ${cellFull(x.title)} | ${x.journal || '—'} | ${x.cited} | ${x.hasAbs ? '有' : '无'} | ${x.doi} |`),
    ['#', '标题', '期刊', '被引', '摘要', 'DOI'],
  ));
  md.push('');
}

// 2.4 零被引·高影响刊：主排序键在同一年份失效时的兜底视图
if (stars.length) {
  const zeroCnt = pool.filter((x) => (x.cited || 0) === 0).length;
  md.push(`### 2.4 高影响力期刊的近期零被引文献（${stars.length} 篇）`);
  md.push('');
  md.push(`> 本批 ${N} 条都在 ${Object.keys(years).join(' / ') || '同一年份'}，被引年化退化为「被引×2」，`
    + `${zeroCnt} 条零被引整体排在 ${cited.length} 条有引用之后。`);
  md.push(`> 下表把零被引且期刊档 ≥ ${ZERO_TIER_MIN} 的单独列出，按 期刊档 → IF≈ → 相关度 排；`
    + `「评述」打 ✅ 表示已进入第三节。`);
  md.push('');
  md.push(tbl(
    stars.map((x, i) => `| ${i + 1} | ${cellFull(x.title)} | ${x.journal || '—'} | ${x.tierName} | ${x.if2y ?? '—'} | ${absOf(x) ? '有' : '无'} | ${inCardSet.has(x.doi) ? '✅' : '—'} | ${x.doi} |`),
    ['#', '标题', '期刊', '期刊档', 'IF≈', '摘要', '评述', 'DOI'],
  ));
  md.push('');
}

// 三、代表性文献评述
md.push('## 三、代表性文献评述');
md.push('');
md.push(`> 主轨按「被引年化 → 期刊档 → 相关度」取前 ${TOP} 篇**有摘要**的文献；`
  + `副轨自高影响力期刊零被引文献中补入 ${starCards.length} 篇（标题带 ★），共 ${cardItems.length} 篇。`);
md.push(`> 「📊 主要结果」必须带具体数值，摘要里没有数值就写「摘要未给数值」，不要编。`);
md.push('');
cardItems.forEach((x, i) => {
  md.push(`### ${i + 1}. ${cell(x.title, 200)}${starDoiSet.has(x.doi) ? ' ★' : ''}`);
  md.push('');
  md.push(`- ${x.journal || '—'}（${x.tierName}，IF≈ ${x.if2y ?? '—'}）｜${yearCell(x)}｜被引 ${x.cited}（年化 ${x.citedAnnual}）`);
  md.push(`- DOI：\`${x.doi}\`｜摘要来源：${absSrcOf(x)}`);
  md.push(`- 💡 核心贡献：${T}`);
  md.push(`- 🔬 方法：${T}`);
  md.push(`- 📊 主要结果：${T}`);
  md.push(`- 🧭 评述（价值 / 局限 / 是否值得精读）：${T}`);
  md.push(`- 优先级：${T}（A 核心必读 / B 相关可读 / C 边缘 / D 排除）`);
  md.push('');
});

// 四、暂缺摘要的文献
md.push('## 四、暂缺摘要的文献');
md.push('');
md.push(`> ${unread.length} 篇在 Crossref / Semantic Scholar / OpenAlex 三源均未获得摘要（多为 Elsevier 2026 年新上线文献），**仅能依据标题判断，置信度较低**。`);
md.push(`> 这些文献不进入第三节评述，但仍属有效样本：可按标题与期刊层级决定是否直接下载后阅读。`);
md.push('');
md.push(tbl(
  unread.map((x, i) => `| ${i + 1} | ${cellFull(x.title)} | ${x.journal || '—'} | ${x.if2y ?? '—'} | ${x.cited} | ${x.doi} |`),
  ['#', '标题', '期刊', 'IF≈', '被引', 'DOI'],
));
md.push('');

// 五、相关性存疑与研究边界
md.push('## 五、相关性存疑与研究边界');
md.push('');
md.push('> 低被引 / 无摘要 / 主题偏僻的文献，往往正是研究空白的线索，不宜直接舍弃。');
md.push('');
md.push(tbl(
  edge.map((x, i) => `| ${i + 1} | ${cellFull(x.title)} | ${x.journal || '—'} | ${yearCell(x)} | ${x.cited} | ${x.doi} |`),
  ['#', '标题', '期刊', '日期', '被引', 'DOI'],
));
md.push('');
md.push(`- 边界议题归纳：${T}`);
md.push('');

// 六、研究空白与问题提出
md.push('## 六、研究空白与问题提出');
md.push('');
md.push(`- 已充分覆盖的方向：${T}`);
md.push(`- 尚未覆盖的评价维度：${T}`);
md.push(`- 论断与证据之间的落差：${T}`);
md.push('');
md.push(`**问题陈述草稿**：${T}`);
md.push('');

// 七、阅读优先级与后续检索建议
md.push('## 七、阅读优先级与后续检索建议');
md.push('');
md.push(`- 首选精读（A 组）：${T}`);
md.push(`- 后续检索建议：${T}`);
md.push(`- 方法学说明：概念组 + 全部命中 + 标题反向排除 + 被引年化排序；`
  + `${sr ? `实际命中 ${N} 条` : `候选 ${N} 条`}${sr?.sources?.openalex ? `，OpenAlex ${sr.sources.openalex.got} 条记录` : ''}${noAbs.length ? `；${noAbs.length} 条无摘要已单独标注` : ''}`);
md.push('');

const mdPath = path.join(DIR, '_analysis_draft.md');
fs.writeFileSync(mdPath, md.join('\n'));

// ── 控制台简报 ──────────────────────────────────────────────
console.log(`${N} 条 → ${path.basename(mdPath)} / ${path.basename(statsPath)}`);
console.log(`年份 ${JSON.stringify(years)}；期刊档 ${JSON.stringify(tiers)}`);
console.log(`摘要：${JSON.stringify(absBy)}（缺 ${noAbs.length} 条，已单列第四节）`);
console.log(`零被引高影响刊 ${stars.length} 篇，其中 ${starCards.length} 篇补入第三节评述`);
console.log(`获取性：直取 ${access.direct || 0} / 浏览器 ${access.browser || 0} / 未知 ${access.unknown || 0}`);
console.log(`主题簇 ${clusterOut.length} 个：${clusterOut.slice(0, MAX_CLUSTERS).map((c, i) => `簇${i + 1}(${c.size})`).join(' ')}`);
console.log(`标题特征词：${featureTerms.slice(0, 8).map((t) => `${t.word}(${t.docs})`).join(' ')}`);
cardItems.slice(0, 5).forEach((x, i) => {
  console.log(`  ${String(i + 1).padStart(2)} 年化${String(x.citedAnnual).padStart(5)} 被引${String(x.cited).padStart(3)} `
    + `${(x.tierName || '').padEnd(8)} ${x.journal.slice(0, 20).padEnd(20)} ${x.doi}`);
});
