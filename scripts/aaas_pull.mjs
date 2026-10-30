// AAAS / science.org 全文抓取：机构 IP 识别后，在文章页内同源 fetch PDF，2 MB 分块 base64 回传。
// 不要导航到 PDF 地址：science.org 会触发附件下载，CDP 拿不到正文。
// 用法：node aaas_pull.mjs 9223 <输出目录> <items.json>
// items.json: [{ "doi": "10.1126/science.xxxxxxx", "kind": "aaas", "file": "xxx.pdf" }]
import path from 'node:path';
import { readJson } from './lib_pdf.mjs';
import { connectOrExit, savePdf, sleep } from './lib_cdp.mjs';
import { recordFailure, clearFailure } from './lib_fail.mjs';
import { preSkip, markDone } from './lib_index.mjs';

const P = process.argv[2] || '9223';
const OUT = process.argv[3];
const ITEMS = readJson(process.argv[4]);
const cdp = await connectOrExit(P, { timeout: 90000 });
let fail = 0;

for (const it of ITEMS) {
  const dst = path.join(OUT, it.file);
  if (preSkip(OUT, it)) continue;
  let tid;
  try {
    // 落在文章页，而不是 PDF 地址
    const page = await cdp.newPage('https://doi.org/' + it.doi);
    tid = page.targetId;
    const { sessionId } = page;

    // 等 Cloudflare 放行 + 机构授权标识 + PDF 入口
    let pdfPath = null;
    let noaccess = false;
    let verifySecs = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(2000);
      const st = await cdp.ev(sessionId, `(()=>{
        const t=document.body?document.body.innerText:'';
        return JSON.stringify({
          cf: /请稍候|Just a moment|Checking/i.test(document.title),
          full: /FULL ACCESS|Access through your institution/i.test(t),
          pdf: (document.querySelector('a[href*="/doi/pdf/"][href$="download=true"]')
                || document.querySelector('a.btn--pdf'))?.getAttribute('href') || null
        })})()`).catch(() => null);
      if (!st) continue;
      const s = JSON.parse(st);
      if (s.cf) { verifySecs += 2; if (i % 10 === 0) console.log(`⏸  ${it.doi} 等待人机验证…`); continue; }
      if (s.full && s.pdf) { pdfPath = s.pdf; break; }
      if (i > 12 && !s.full) noaccess = true;
    }
    if (!pdfPath) {
      if (verifySecs >= 10) throw new Error(`人机验证未通过（已等 ${verifySecs} 秒，请在 Edge 窗口勾选后重跑）`);
      throw new Error(noaccess ? '无全文访问权限（页面未出现 FULL ACCESS）' : '未取得 PDF 入口');
    }

    // 关键：在文章页内同源 fetch，不导航
    const r = await cdp.fetchInPage(sessionId, JSON.stringify(pdfPath));
    if (r.size < 100000) throw new Error(`页内 fetch 内容过小: ${r.size}B`);
    if (r.mime && !/pdf/i.test(r.mime)) throw new Error(`取回非 PDF: ${r.mime}`);
    const saved = savePdf(r.buf, dst);
    markDone(OUT, it, dst, { pages: saved.pages });
    clearFailure(OUT, it.doi);
    console.log(`OK   ${it.doi}  ${(saved.size / 1048576).toFixed(1)}MB  → ${dst}`);
  } catch (e) {
    fail++;
    recordFailure(OUT, { doi: it.doi, kind: it.kind || 'aaas', script: 'aaas_pull.mjs', file: it.file, reason: e.message });
    console.log(`FAIL ${it.doi}  ${e.message}`);
  } finally {
    await cdp.closePage(tid);
  }
  await sleep(6000);
}
await cdp.close();
if (fail) process.exitCode = 1;
