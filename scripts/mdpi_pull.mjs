// MDPI 全文抓取：MDPI 全 OA，但 /pdf 在 Node 侧会被 Cloudflare 拦（返回 2KB 挑战页）。
// 必须由浏览器先拿到 cf_clearance，再在文章页做同源 fetch。
// 用法：node mdpi_pull.mjs 9223 <输出目录> <items.json>
// items.json: [{ "doi": "10.3390/xxxxxxx", "kind": "mdpi", "host": "www.mdpi.com", "file": "x.pdf" }]
import path from 'node:path';
import { readJson } from './lib_pdf.mjs';
import { connectOrExit, savePdf, sleep } from './lib_cdp.mjs';
import { preSkip, markDone } from './lib_index.mjs';
import { recordFailure, clearFailure } from './lib_fail.mjs';

const P = process.argv[2] || '9223';
const OUT = process.argv[3];
const ITEMS = readJson(process.argv[4]);
const cdp = await connectOrExit(P);
let fail = 0;

async function pull(sessionId, dst, url) {
  const { buf } = await cdp.fetchInPage(sessionId, JSON.stringify(url));
  return savePdf(buf, dst);
}

for (const it of ITEMS) {
  const dst = path.join(OUT, it.file);
  if (preSkip(OUT, it)) continue;
  let tid;
  try {
    // MDPI 的路径形如 /{issn}/{vol}/{issue}/{article}，无法从 DOI 直接拼出，
    // 因此让浏览器走 doi.org 解析，再读回真实地址。
    const page = await cdp.newPage(`https://doi.org/${it.doi}`);
    tid = page.targetId;
    const { sessionId } = page;

    let pdfUrl = null;
    for (let i = 0; i < 25; i++) {
      await sleep(2000);
      const st = await cdp.ev(sessionId, `(()=>{
        const t=document.body?document.body.innerText:'';
        const cdn=[...document.querySelectorAll('a[href*="mdpi-res.com"]')].map(a=>a.href)[0]||null;
        return JSON.stringify({url:location.href, cdn,
          ts:/Just a moment|Verify you are human|Checking your browser|请稍候/i.test(t)});
      })()`).catch(() => null);
      if (!st) continue;
      const s = JSON.parse(st);
      if (s.ts) { if (i % 5 === 0) console.log(`⏸  ${it.doi} Cloudflare 校验中…`); continue; }
      const u = new URL(s.url);
      if (!/^www\.mdpi\.com$/.test(u.hostname)) continue;
      // 文章页路径：/{issn}/{vol}/{issue}/{article}
      if (!/^\/\d{4}-\d{3}[\dX]\/\d+\/\d+\/\d+/.test(u.pathname)) continue;
      const basePath = u.pathname.replace(/\/pdf$/, '');
      // 优先用页面上的 mdpi-res.com CDN 直链，取不到再退回同源 /pdf
      pdfUrl = s.cdn || `${u.origin}${basePath}/pdf`;
      break;
    }
    if (!pdfUrl) throw new Error('文章页未就绪（Cloudflare 未放行或 DOI 未解析到 mdpi.com）');
    console.log(`→ ${it.doi} 入口 ${pdfUrl.slice(0, 110)}`);

    let lastErr;
    let done = false;
    for (let i = 0; i < 6; i++) {
      await sleep(i === 0 ? 1000 : 4000);
      try {
        const r = await pull(sessionId, dst, pdfUrl);
        markDone(OUT, it, dst, { pages: r.pages });
        console.log(`OK   ${it.doi}  ${(r.size / 1048576).toFixed(1)}MB  pages≈${r.pages}  → ${dst}`);
        done = true;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!done) throw lastErr;
    clearFailure(OUT, it.doi);
  } catch (e) {
    fail++;
    recordFailure(OUT, { doi: it.doi, kind: 'mdpi', script: 'mdpi_pull.mjs', file: it.file, reason: e.message });
    console.log(`FAIL ${it.doi}  ${e.message}`);
  } finally {
    await cdp.closePage(tid);
  }
  await sleep(4000);
}
await cdp.close();
if (fail) process.exitCode = 1;
