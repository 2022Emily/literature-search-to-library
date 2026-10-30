// 输入归一化：把 DOI、doi.org 链接、出版社文章页 URL 统一成 items 数组。
// 用法：node normalize.mjs <input> <out.json> [--port 9223]
//   input 可以是 JSON 数组（字符串或对象），也可以是每行一条的 txt
//   --port 给出时，无法从 URL 直接解析的条目（RSC 新版文章页、MDPI、ScienceDirect PII）
//   会开标签页读 meta[name="citation_doi"] 反查
// 输出：[{ "doi": "10.1039/xxxxxxx", ... }]，无法解析的条目会列出并返回码 1。
import fs from 'node:fs';
import { connect, sleep } from './lib_cdp.mjs';
import { readJson } from './lib_pdf.mjs';

const IN = process.argv[2];
const OUT = process.argv[3];
const pi = process.argv.indexOf('--port');
const PORT = pi > 0 ? process.argv[pi + 1] : '';
if (!IN || !OUT) {
  console.log('用法：node normalize.mjs <input> <out.json> [--port 9223]');
  process.exit(2);
}

function cleanDoi(s) {
  const m = String(s || '').match(/10\.\d{4,9}\/[^\s"'<>?#]+/);
  return m ? m[0].replace(/[.,;)\]]+$/, '') : null;
}

// URL 里没有 DOI 时，靠出版社固定的 URL 形状补
function fromUrlShape(u) {
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'nature.com') {
    const m = u.pathname.match(/^\/articles\/([a-z0-9.-]+)/);
    if (m && /s\d{4,5}-/.test(m[1])) return `10.1038/${m[1]}`;
  }
  if (host === 'pubs.rsc.org') {
    const m = u.pathname.match(/\/articlelanding\/\d{4}\/[^/]+\/([a-z0-9]+)/i)
      || u.pathname.match(/\/articlehtml\/\d{4}\/[^/]+\/([a-z0-9]+)/i)
      || u.pathname.match(/\/articlepdf\/\d{4}\/[^/]+\/([a-z0-9]+)/i);
    if (m) return `10.1039/${m[1].toLowerCase()}`;
  }
  if (host === 'doi.org' || host === 'dx.doi.org') {
    return cleanDoi(decodeURIComponent(u.pathname.slice(1)));
  }
  return null;
}

function loadInput() {
  const raw = fs.readFileSync(IN, 'utf8').replace(/^\uFEFF/, '');
  const t = raw.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    const j = readJson(IN);
    return (Array.isArray(j) ? j : [j]).map((x) => (typeof x === 'string' ? { source: x } : { ...x, source: x.source || x.url || x.doi || '' }));
  }
  return t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => ({ source: l }));
}

async function fromPage(cdp, url) {
  let page;
  try {
    page = await cdp.newPage(url);
    for (let i = 0; i < 12; i++) {
      await sleep(1500);
      const raw = await cdp.ev(page.sessionId, `(()=>{
        const m=[...document.querySelectorAll('meta[name="citation_doi"],meta[name="dc.identifier"],meta[name="DOI"]')].map(x=>x.content)[0]||'';
        const c=document.querySelector('link[rel="canonical"]')?.href||'';
        return JSON.stringify({m,c,url:location.href});
      })()`).catch(() => null);
      if (!raw) continue;
      const s = JSON.parse(raw);
      const hit = cleanDoi(s.m) || cleanDoi(s.c) || cleanDoi(s.url);
      if (hit) return hit;
    }
    return null;
  } finally {
    if (page) await cdp.closePage(page.targetId);
  }
}

const rows = loadInput();
const cdp = PORT ? await connect(PORT).catch(() => null) : null;
const out = [];
const unresolved = [];

for (const row of rows) {
  const src = String(row.source || row.doi || row.url || '').trim();
  const item = { ...row };
  delete item.source;
  let doi = cleanDoi(row.doi) || cleanDoi(src);
  if (!doi) {
    try { doi = fromUrlShape(new URL(src)); } catch {}
  }
  if (!doi && cdp) {
    const url = /^https?:\/\//i.test(src) ? src : `https://doi.org/${src}`;
    doi = await fromPage(cdp, url);
    if (doi) console.log(`↻ ${src.slice(0, 70)} → ${doi}`);
  }
  if (!doi) {
    unresolved.push(src);
    continue;
  }
  item.doi = doi.toLowerCase();
  out.push(item);
}
if (cdp) await cdp.close();

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`归一化完成：${out.length} 条 → ${OUT}`);
if (unresolved.length) {
  console.log(`\n无法解析 ${unresolved.length} 条：`);
  for (const u of unresolved) console.log(`  ${u}`);
  if (!cdp) console.log('（给出 --port 并启动 Edge，可让浏览器读 citation_doi 反查）');
  process.exit(1);
}
