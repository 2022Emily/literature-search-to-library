// 入口路由：先查 OpenAlex/Unpaywall 的开放获取直链，命中就用 Node 直接下载；未命中的
// 按候选池里的 publisher / host 识别出版社并写成待浏览器清单。
// 缺少这两项时判为 unknown，交给 dispatch 打 WARN 转人工，不按 DOI 前缀猜测。
// 用法：node oa_route.mjs <输出目录> <items.json> [email]
// items.json: [{ "doi": "10.1038/s41467-025-xxxxxx", "file": "xxx.pdf" }]
import fs from 'node:fs';
import path from 'node:path';
import { validPdf, readJson } from './lib_pdf.mjs';
import { alreadyDone, dropStale, markDone } from './lib_index.mjs';

const OUT = process.argv[2];
const ITEMS = readJson(process.argv[3]);
const EMAIL = process.argv[4] || process.env.UNPAYWALL_EMAIL || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 出版社判定只用检索阶段补的 host / publisher；DOI 前缀只标识注册方、不标识托管域名，
// 容易把 Wiley 的裸域名文章派给错误的通道，因此不再作为兜底。
const HOST_RULES = [
  [/pubs\.acs\.org$/, 'acs'],
  [/sciencedirect\.com$|elsevier\.com$/, 'elsevier'],
  [/science\.org$/, 'aaas'],
  [/wiley\.com$/, 'wiley'],
  [/mdpi\.com$/, 'mdpi'],
  [/nature\.com$|link\.springer\.com$/, 'springer'],
  [/rsc\.org$/, 'rsc'],
  [/ieeexplore\.ieee\.org$/, 'ieee'],
];
const PUB_RULES = [
  [/american chemical society/i, 'acs'],
  [/elsevier/i, 'elsevier'],
  [/american association for the advancement of science/i, 'aaas'],
  [/wiley/i, 'wiley'],
  [/mdpi/i, 'mdpi'],
  [/springer|nature portfolio/i, 'springer'],
  [/royal society of chemistry/i, 'rsc'],
  [/institute of electrical|^ieee$/i, 'ieee'],
];
const pick = (v, rules) => (rules.find(([re]) => re.test(v)) || [null, null])[1];
const detect = (it) => pick(it.host || '', HOST_RULES) || pick(it.publisher || '', PUB_RULES) || 'unknown';

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) { await new Promise((s) => setTimeout(s, 3000 * (i + 1))); continue; }
    throw new Error(`HTTP ${r.status}`);
  }
}

// 取 OA 候选链接：优先 OpenAlex（无需邮箱），配置了真实邮箱时再叠加 Unpaywall
// 只收 pdf_url，landing page 不尝试（返回 HTML）
async function oaUrls(doi) {
  const urls = [];
  let note = '';
  const mail = EMAIL ? `?mailto=${encodeURIComponent(EMAIL)}` : '';
  try {
    const w = (await getJson(`https://api.openalex.org/works/doi:${doi}${mail}`));
    const locs = [w.best_oa_location, w.primary_location, ...(w.locations || [])].filter(Boolean);
    for (const l of locs) if (l.pdf_url) urls.push(l.pdf_url);
    if (!w.open_access?.is_oa) note = 'OpenAlex 标记非 OA';
    else if (!urls.length) note = 'OA 但无 pdf_url';
  } catch (e) {
    note = `OpenAlex 查询失败: ${e.message}`;
  }
  if (EMAIL) {
    try {
      const u = await getJson(`https://api.unpaywall.org/v2/${doi}?email=${encodeURIComponent(EMAIL)}`);
      for (const l of [u.best_oa_location, ...(u.oa_locations || [])].filter(Boolean)) {
        if (l.url_for_pdf) urls.push(l.url_for_pdf);
      }
    } catch (e) {
      note = (note ? note + '; ' : '') + `Unpaywall: ${e.message}`;
    }
  }
  return { urls: [...new Set(urls)], note };
}

async function tryPdf(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/pdf,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(90000) });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, why: `非 PDF (${r.status} ${r.headers.get('content-type')})` };
  if (buf.length < 50000) return { ok: false, why: `过小 ${buf.length}B` };
  return { ok: true, buf };
}

// Elsevier 需要 PII，从 Crossref 的 alternative-id 取
async function piiOf(doi) {
  try {
    const m = (await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)).message;
    const alt = (m['alternative-id'] || []).find((x) => /^S\d/.test(x));
    if (alt) return alt;
    const link = (m.link || []).map((l) => l.URL).find((u) => /pii|S\d{8}/.test(u));
    return link ? (link.match(/(S\d{8,})/) || [])[1] || null : null;
  } catch { return null; }
}

const report = [];
const pending = [];

// 跨批次去重：台账由抓取脚本登记、verify_pdf.py 补校验时间戳。
// 命中要求「同一 DOI + 文件在 + 体积与 sha256 一致」，不再用「文件名像 PDF」作为完成判据。
async function routeOne(it) {
  const dst = path.join(OUT, it.file);
  const done = alreadyDone(OUT, it.doi);
  if (done) {
    console.log(`SKIP ${it.doi}  台账命中 ${done.file}${done.verified ? '' : '（未校验）'}`);
    return { report: { doi: it.doi, route: 'index', status: 'skip', file: done.file }, pending: null };
  }
  if (validPdf(dst)) dropStale(dst, it.doi);
  let oa = '';
  try {
    const { urls, note } = await oaUrls(it.doi);
    let got = null;
    let why = note || '无 OA 候选链接';
    for (const u2 of urls.slice(0, 6)) {
      const r = await tryPdf(u2).catch((e) => ({ ok: false, why: e.message }));
      if (r.ok) { got = r; break; }
      why = `${u2.slice(0, 70)} → ${r.why}`;
    }
    if (got) {
      fs.writeFileSync(dst, got.buf);
      // OA 直取同样登记台账：否则下次重跑会把它当成「无台账旧文件」改名重下。
      markDone(OUT, it, dst);
      console.log(`OK   ${it.doi}  OA 直链  ${(got.buf.length / 1048576).toFixed(1)}MB`);
      return {
        report: { doi: it.doi, route: 'oa', status: 'ok', file: it.file, size: got.buf.length },
        pending: null,
      };
    }
    oa = why;
  } catch (e) {
    oa = `OA 查询失败: ${e.message}`;
  }
  const kind = detect(it);
  const p = { doi: it.doi, kind, file: it.file };
  if (it.host) p.host = it.host;
  if (kind === 'elsevier') {
    const pii = it.pii || (await piiOf(it.doi));
    if (pii) p.pii = pii;
  }
  console.log(`TODO ${it.doi}  → ${kind}${p.pii ? ' pii=' + p.pii : ''}  (${oa})${kind === 'unknown' ? '  未适配出版社，交给通用兜底' : ''}`);
  return {
    report: { doi: it.doi, route: kind, status: 'pending-browser', reason: oa },
    pending: p,
  };
}

// 4 个 worker 并发（OpenAlex 单篇一次查询，串行跑 40 篇纯等网络）。
// 结果按输入下标回填，两个 JSON 的条目顺序与输入清单保持一致。
const CONC = 4;
const results = new Array(ITEMS.length);
let cursor = 0;
async function worker() {
  while (cursor < ITEMS.length) {
    const i = cursor++;
    results[i] = await routeOne(ITEMS[i]);
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, ITEMS.length) }, () => worker()));
for (const r of results) {
  report.push(r.report);
  if (r.pending) pending.push(r.pending);
}

fs.writeFileSync(path.join(OUT, '_oa_report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT, '_browser_pending.json'), JSON.stringify(pending, null, 2));
console.log(`\n汇总：OA 直取 ${report.filter((r) => r.status === 'ok').length}，待浏览器 ${pending.length}，已存在 ${report.filter((r) => r.status === 'skip').length}`);
