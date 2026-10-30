// Elsevier / ScienceDirect 全文抓取：从文章页取 /pdfft? 链接，导航到签名 URL 后落到
// pdf.sciencedirectassets.com 的 assets 页，再在该页内同源 fetch 取字节。
// 用法：node sd_pull.mjs 9223 <输出目录> <items.json>
// items.json: [{ "doi": "10.1016/j.xxx.2024.123456", "kind": "elsevier", "pii": "S0955...", "file": "x.pdf" }]
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

// 已停在 assets 页的标签页：重新 attach 后页内取字节
async function pullTarget(targetId, dst) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  const { buf } = await cdp.fetchInPage(sessionId, 'location.href');
  return savePdf(buf, dst);
}

// 1) 先把当前已停在 assets 页的标签页收进来
const existing = (await cdp.targets()).filter((t) => /sciencedirectassets\.com.*\.pdf/i.test(t.url));
const pending = [...ITEMS];
for (const t of existing) {
  const pii = (t.url.match(/1-s2\.0-([A-Z0-9]+)\/main\.pdf/) || [])[1] || '';
  const idx = pending.findIndex((it) => it.pii && pii.startsWith(it.pii.slice(0, 8)));
  const item = idx >= 0 ? pending.splice(idx, 1)[0] : null;
  if (!item) continue;
  if (preSkip(OUT, item)) continue;
  try {
    const r = await pullTarget(t.targetId, path.join(OUT, item.file));
    markDone(OUT, item, path.join(OUT, item.file), { pages: r.pages });
    clearFailure(OUT, item.doi);
    console.log(`OK(现存页) ${item.doi} ${(r.size / 1048576).toFixed(1)}MB pages≈${r.pages}`);
  } catch (e) {
    fail++;
    recordFailure(OUT, { doi: item.doi, kind: 'elsevier', script: 'sd_pull.mjs', file: item.file, reason: e.message });
    console.log(`FAIL(现存页) ${item.doi} ${e.message}`);
  }
}

// 2) 其余按 DOI 走一遍
for (const it of pending) {
  const dst = path.join(OUT, it.file);
  if (preSkip(OUT, it)) continue;
  let tid;
  try {
    const page = await cdp.newPage(`https://doi.org/${it.doi}`);
    tid = page.targetId;
    const { sessionId } = page;

    let href = null;
    let verifySecs = 0;
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      const r = await cdp.ev(sessionId, `(()=>{
        const as=[...document.querySelectorAll('a')].filter(a=>/\\/pdfft\\?/.test(a.getAttribute('href')||''));
        const cur=as.find(a=>/accessbar-utility/.test(a.className))||as[0];
        return JSON.stringify({ts:/Verify you are human|确认您是真人/i.test(document.body.innerText||''),vp:cur?cur.getAttribute('href'):null});
      })()`).catch(() => null);
      if (!r) continue;
      const st = JSON.parse(r);
      if (st.ts) { verifySecs += 2; if (i % 10 === 0) console.log(`⏸  ${it.doi} 请人工过验证…`); }
      if (st.vp && !st.ts) { href = st.vp; break; }
    }
    if (!href) {
      if (verifySecs >= 10) throw new Error(`人机验证未通过（已等 ${verifySecs} 秒，请在 Edge 窗口勾选后重跑）`);
      throw new Error('未找到 pdfft 链接');
    }
    await cdp.send('Page.navigate', { url: 'https://www.sciencedirect.com' + href }, sessionId);

    let assetsId = null;
    for (let i = 0; i < 40; i++) {
      await sleep(2000);
      const hit = (await cdp.targets()).find((t) => t.targetId === tid && /sciencedirectassets\.com.*\.pdf/i.test(t.url));
      if (hit) { assetsId = hit.targetId; break; }
    }
    if (!assetsId) {
      const alt = (await cdp.targets()).find((t) => /sciencedirectassets\.com.*\.pdf/i.test(t.url));
      if (alt) assetsId = alt.targetId;
    }
    if (!assetsId) throw new Error('未到达 assets PDF 页');
    await sleep(1500);
    const r = await pullTarget(assetsId, dst);
    markDone(OUT, it, dst, { pages: r.pages });
    clearFailure(OUT, it.doi);
    console.log(`OK   ${it.doi}  ${(r.size / 1048576).toFixed(1)}MB  pages≈${r.pages}`);
  } catch (e) {
    fail++;
    recordFailure(OUT, { doi: it.doi, kind: 'elsevier', script: 'sd_pull.mjs', file: it.file, reason: e.message });
    console.log(`FAIL ${it.doi}  ${e.message}`);
  } finally {
    await cdp.closePage(tid);
  }
  await sleep(3000);
}
await cdp.close();
if (fail) process.exitCode = 1;
