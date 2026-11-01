// IEEE 全文抓取：DOI 只落地到 ieeexplore 文章页，PDF 地址要 arnumber 才能拼。
// 文章页的 citation_pdf_url 常指向 stamp.jsp（iframe 外壳，取回是 HTML），
// 所以统一改用 /stampPDF/getPDF.jsp?tp=&arnumber=，并在文章页做同源 fetch。
// 用法：node ieee_pull.mjs 9223 <输出目录> <items.json>
// items.json: [{ "doi": "10.1109/xxx", "kind": "ieee", "file": "x.pdf" }]
import path from 'node:path';
import { readJson } from './lib_pdf.mjs';
import { connectOrExit, savePdf, sleep } from './lib_cdp.mjs';
import { recordFailure, clearFailure } from './lib_fail.mjs';
import { preSkip, markDone } from './lib_index.mjs';

const P = process.argv[2] || '9223';
const OUT = process.argv[3];
const ITEMS = readJson(process.argv[4]);
const cdp = await connectOrExit(P);
let fail = 0;

async function pull(sessionId, dst, urlExpr) {
  const { buf } = await cdp.fetchInPage(sessionId, urlExpr);
  return savePdf(buf, dst);
}

for (const it of ITEMS) {
  const dst = path.join(OUT, it.file);
  if (preSkip(OUT, it)) continue;
  let tid;
  try {
    const page = await cdp.newPage(`https://doi.org/${it.doi}`);
    tid = page.targetId;
    const { sessionId } = page;

    // 第一步：等 DOI 落到 ieeexplore 文章页，取 arnumber（PDF 地址拼不出来）
    let arnumber = null;
    let metaUrl = null;
    for (let i = 0; i < 20; i++) {
      await sleep(2000);
      const raw = await cdp.ev(sessionId, `(()=>{
        const m=[...document.querySelectorAll('meta[name="citation_pdf_url"]')].map(x=>x.content)[0]||null;
        return JSON.stringify({url:location.href,m});
      })()`).catch(() => null);
      if (!raw) continue;
      const s = JSON.parse(raw);
      if (/doi\.org/i.test(s.url)) continue;
      if (!/ieeexplore\.ieee\.org/i.test(s.url)) throw new Error(`落地页不是 ieeexplore（${s.url.slice(0, 60)}）`);
      const fromUrl = s.url.match(/\/document\/(\d+)/);
      const fromMeta = String(s.m || '').match(/arnumber=(\d+)/);
      arnumber = (fromUrl && fromUrl[1]) || (fromMeta && fromMeta[1]) || null;
      metaUrl = s.m;
      if (arnumber) break;
    }
    if (!arnumber) throw new Error('未取到 arnumber（可能被拦截、非 IEEE 文章或未登录机构）');

    // 第二步：优先 /stampPDF/ 直取正文；meta 里的 stamp.jsp 只作为备选
    const urls = [
      `https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=${arnumber}&ref=`,
      metaUrl && !/stamp\.jsp/i.test(metaUrl) ? metaUrl : null,
    ].filter(Boolean);

    let lastErr;
    let ok = false;
    for (const u of urls) {
      for (let i = 0; i < 6; i++) {
        await sleep(3000);
        try {
          const r = await pull(sessionId, dst, JSON.stringify(u));
          markDone(OUT, it, dst, { pages: r.pages });
          console.log(`OK   ${it.doi}  ${(r.size / 1048576).toFixed(1)}MB  pages≈${r.pages}  arnumber=${arnumber}`);
          ok = true;
          break;
        } catch (e) { lastErr = e; }
      }
      if (ok) break;
    }
    if (!ok) throw lastErr;
    clearFailure(OUT, it.doi);
  } catch (e) {
    fail++;
    recordFailure(OUT, { doi: it.doi, kind: 'ieee', script: 'ieee_pull.mjs', file: it.file, reason: e.message });
    console.log(`FAIL ${it.doi}  ${e.message}`);
  } finally {
    await cdp.closePage(tid);
  }
  await sleep(4000);
}
await cdp.close();
if (fail) process.exitCode = 1;
