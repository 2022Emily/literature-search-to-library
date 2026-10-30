// Springer / Nature 全文抓取：留在文章页做同源 fetch，不导航到 PDF 地址。
// 用法：node springer_pull.mjs 9223 <输出目录> <items.json>
// items.json: [{ "doi": "10.1007/s10853-025-xxxxx-0", "kind": "springer", "host": "link.springer.com", "file": "x.pdf" }]
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
    const slug = it.doi.split('/')[1] || '';
    const isNature = /nature\.com$/.test(it.host || '');
    const base = it.host ? `https://${it.host}` : 'https://link.springer.com';
    const artUrl = isNature ? `https://www.nature.com/articles/${slug}` : `${base}/article/${it.doi}`;
    // 默认路径：Springer 固定 content/pdf/{DOI}.pdf；Nature 为 articles/{slug}.pdf
    let pdfUrl = isNature ? `https://www.nature.com/articles/${slug}.pdf` : `${base}/content/pdf/${it.doi}.pdf`;

    const page = await cdp.newPage(artUrl);
    tid = page.targetId;
    const { sessionId } = page;

    let ready = false;
    for (let i = 0; i < 20; i++) {
      await sleep(2000);
      const href = String(await cdp.ev(sessionId, 'location.href').catch(() => ''));
      if (/idp\.|sso|login|signin|cas\./i.test(href) && !/link\.springer\.com\/article|nature\.com\/articles/.test(href)) {
        throw new Error('需要机构登录，请先在该 Edge 窗口完成认证');
      }
      const st = await cdp.ev(sessionId, `(()=>{
        const t=document.body?document.body.innerText:'';
        const a=[...document.querySelectorAll('a[href*="/content/pdf/"],a[href$=".pdf"]')][0];
        return JSON.stringify({href:a?a.href:null,
          deny:/Access this article|Buy article|Rent this article|Subscribe to journal|Purchase PDF/i.test(t),
          via:/Access through your institution|Open access|Download PDF|Access PDF/i.test(t)});
      })()`).catch(() => null);
      if (!st) continue;
      const s = JSON.parse(st);
      if (s.href) { pdfUrl = s.href; ready = true; break; }
      // 页面已明确无权限时不必等满 40 秒
      if (s.deny && !s.via) throw new Error('页面显示无全文访问权限（Buy article / Access this article）');
      if (s.via) { ready = true; break; }
    }
    if (!ready) throw new Error('文章页未就绪（可能被拦截或无权限）');

    let lastErr;
    let done = false;
    for (let i = 0; i < 6; i++) {
      await sleep(i === 0 ? 1000 : 4000);
      try {
        const r = await pull(sessionId, dst, pdfUrl);
        markDone(OUT, it, dst, { pages: r.pages });
        console.log(`OK   ${it.doi}  ${(r.size / 1048576).toFixed(1)}MB  → ${dst}`);
        done = true;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!done) throw lastErr;
    clearFailure(OUT, it.doi);
  } catch (e) {
    fail++;
    recordFailure(OUT, { doi: it.doi, kind: it.kind || 'springer', script: 'springer_pull.mjs', file: it.file, reason: e.message });
    console.log(`FAIL ${it.doi}  ${e.message}`);
  } finally {
    await cdp.closePage(tid);
  }
  await sleep(4000);
}
await cdp.close();
if (fail) process.exitCode = 1;
