// 通用抓取：找 PDF 入口 → 导航 → 页内同源 fetch。
// ACS 分支特殊：必须留在文章页做同源 fetch（导航到 PDF 会被插件渲染，CDP 读不到正文）。
// 用法：node generic_pull.mjs 9223 <输出目录> <items.json>
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

async function pull(sessionId, dst, urlExpr = 'location.href') {
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

    // ACS：留在文章页做同源 fetch，不导航到 PDF 地址
    const host = String(await cdp.ev(sessionId, 'location.host').catch(() => ''));
    if (it.kind === 'acs' || /pubs\.acs\.org$/.test(host)) {
      const p = it.pdfPath || `/doi/pdf/${it.doi}`;
      let lastErr;
      let ok = false;
      for (let i = 0; i < 6; i++) {
        await sleep(4000);
        try {
          const r = await pull(sessionId, dst, JSON.stringify(p));
          markDone(OUT, it, dst, { pages: r.pages });
          console.log(`OK   ${it.doi}  ${(r.size / 1048576).toFixed(1)}MB  pages≈${r.pages}`);
          ok = true;
          lastErr = null;
          break;
        } catch (e) { lastErr = e; }
      }
      if (!ok) throw lastErr;
      clearFailure(OUT, it.doi);
      continue;
    }

    // 找 PDF 入口：优先页面上的下载链接，其次 meta[name="citation_pdf_url"]
    // （后者是未点名适配的出版社最可靠的入口，见 dispatch.mjs 的 unknown 兜底）
    let href = null;
    let pageUrl = null;
    let verifySecs = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(2000);
      const raw = await cdp.ev(sessionId, `(()=>{
        const txt=document.body?document.body.innerText:'';
        const ts=/Verify you are human|确认您是真人|Checking your browser/i.test(txt);
        const pats=['a[href*="/pdfft?"]','a[href*="/doi/pdf/"]','a[href$=".pdf"]','a[href*="/pdf"]','a[href*="download"]'];
        let pick=null;
        for(const p of pats){const els=[...document.querySelectorAll(p)].filter(a=>!a.closest('nav,footer'));
          const cur=els.find(a=>/accessbar-utility|pdf-link|article-pdfLink/.test(a.className))||els[0]; if(cur){pick=cur;break}}
        const meta=document.querySelector('meta[name="citation_pdf_url"]');
        return JSON.stringify({url:location.href,ts,href:pick?pick.getAttribute('href'):null,
          meta:meta?meta.content:null,
          alt:location.pathname.match(/^\\/\\d+\\.\\d+\\//)?location.origin+location.pathname+'/pdf':null});
      })()`).catch(() => null);
      if (!raw) continue;
      const st = JSON.parse(raw);
      if (st.ts) { verifySecs += 2; if (i % 10 === 0) console.log(`⏸  ${it.doi} 需要人工验证…`); continue; }
      href = st.href || st.meta || st.alt;
      if (href) { pageUrl = st.url; break; }
    }
    if (!href) {
      if (verifySecs >= 10) throw new Error(`人机验证未通过（已等 ${verifySecs} 秒，请在 Edge 窗口勾选后重跑）`);
      throw new Error('未找到 PDF 入口');
    }
    const full = href.startsWith('http') ? href : absUrl(it, href, pageUrl);
    console.log(`→ ${it.doi} 入口 ${full.slice(0, 100)}`);

    await cdp.send('Page.navigate', { url: full }, sessionId);

    let ok = false;
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const u = await cdp.ev(sessionId, 'location.href').catch(() => null);
      if (!u) continue;
      // 落地页本身是 PDF 就取 location.href；否则（未适配出版社的 meta 地址、
      // 或导航被插件接管留在文章页）只要与当前页同源，就直接页内取目标地址
      const isPdfPage = /sciencedirectassets\.com|\.pdf(\?|$)/i.test(u) || /\/epdf\//i.test(u);
      const expr = isPdfPage ? 'location.href' : originOf(full) === originOf(u) ? JSON.stringify(full) : null;
      if (!expr) continue;
      try {
        const r = await pull(sessionId, dst, expr);
        markDone(OUT, it, dst, { pages: r.pages });
        console.log(`OK   ${it.doi}  ${(r.size / 1048576).toFixed(1)}MB  pages≈${r.pages}`);
        ok = true;
        break;
      } catch (e) {
        if (i > 8) console.log(`   重试中(${i}): ${e.message}`);
      }
    }
    if (!ok) throw new Error('页内取字节未成功');
    clearFailure(OUT, it.doi);
  } catch (e) {
    fail++;
    recordFailure(OUT, { doi: it.doi, kind: it.kind || 'generic', script: 'generic_pull.mjs', file: it.file, reason: e.message });
    console.log(`FAIL ${it.doi}  ${e.message}`);
  } finally {
    await cdp.closePage(tid);
  }
  await sleep(4000);
}
await cdp.close();
if (fail) process.exitCode = 1;

function absUrl(it, href, base) {
  if (it.kind === 'elsevier') return 'https://www.sciencedirect.com' + href;
  if (it.kind === 'acs') return 'https://pubs.acs.org' + href;
  if (it.kind === 'mdpi') return 'https://www.mdpi.com' + href;
  // 其余出版社按文章页实际地址解析相对路径（如 nature.com 的 /articles/xxx.pdf）
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
