// RSC 全文抓取：pubs.rsc.org 对 Node 直连和页内 fetch 都会 403 / Failed to fetch，
// 唯一可行路径是浏览器顶层导航到 PDF 地址——它会 302 到 rscj.silverchair-cdn.com 的签名直链，
// 该直链在 Node 侧可直接下载（不需要 cookie）。
// 用法：node rsc_pull.mjs 9223 <输出目录> <items.json>
// items.json: [{ "doi": "10.1039/xxxxxxx", "kind": "rsc", "host": "pubs.rsc.org", "file": "x.pdf" }]
import path from 'node:path';
import { readJson } from './lib_pdf.mjs';
import { connectOrExit, directDownload, sleep } from './lib_cdp.mjs';
import { recordFailure, clearFailure } from './lib_fail.mjs';
import { preSkip, markDone } from './lib_index.mjs';

const P = process.argv[2] || '9223';
const OUT = process.argv[3];
const ITEMS = readJson(process.argv[4]);
const cdp = await connectOrExit(P);
let fail = 0;

for (const it of ITEMS) {
  const dst = path.join(OUT, it.file);
  if (preSkip(OUT, it)) continue;
  let tid;
  try {
    const page = await cdp.newPage(`https://doi.org/${it.doi}`);
    tid = page.targetId;
    const { sessionId } = page;

    // 第一步：在文章页取 citation_pdf_url（RSC 的 PDF 地址含文章内部 id，拼不出来）
    let pdfUrl = null;
    for (let i = 0; i < 20; i++) {
      await sleep(2000);
      const st = await cdp.ev(sessionId, `(()=>{
        const m=[...document.querySelectorAll('meta[name="citation_pdf_url"]')].map(x=>x.content)[0]||null;
        const a=[...document.querySelectorAll('a[href*="articlepdf"],a[href*="article-pdf"]')].map(x=>x.href)[0]||null;
        return JSON.stringify({url:location.href, pdf:m||a});
      })()`).catch(() => null);
      if (!st) continue;
      const s = JSON.parse(st);
      if (!/pubs\.rsc\.org/.test(s.url)) continue;
      if (s.pdf) { pdfUrl = s.pdf; break; }
    }
    if (!pdfUrl) throw new Error('未取到 citation_pdf_url（可能被拦截或未登录机构）');

    // 第二步：顶层导航到 PDF，等它 302 到 silverchair CDN
    await cdp.send('Page.navigate', { url: pdfUrl }, sessionId);
    let finalUrl = null;
    for (let i = 0; i < 20; i++) {
      await sleep(2000);
      const st = await cdp.ev(sessionId, `JSON.stringify({url:location.href, ct:document.contentType})`).catch(() => null);
      if (!st) continue;
      const s = JSON.parse(st);
      if (/article-abstract|\/article\//.test(s.url) || /redirectedFrom=PDF/.test(s.url)) {
        throw new Error('无全文访问权限（PDF 地址被退回文章页）');
      }
      if (s.ct === 'application/pdf' || /silverchair-cdn\.com/.test(s.url)) { finalUrl = s.url; break; }
    }
    if (!finalUrl) throw new Error('PDF 未加载（可能无权限）');

    // 第三步：Node 取签名直链，无需 cookie
    let lastErr;
    let done = false;
    for (let i = 0; i < 6; i++) {
      await sleep(i === 0 ? 1000 : 3000);
      try {
        const r = await directDownload(finalUrl, dst, { referer: pdfUrl });
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
    recordFailure(OUT, { doi: it.doi, kind: 'rsc', script: 'rsc_pull.mjs', file: it.file, reason: e.message });
    console.log(`FAIL ${it.doi}  ${e.message}`);
  } finally {
    await cdp.closePage(tid);
  }
  await sleep(4000);
}
await cdp.close();
if (fail) process.exitCode = 1;
