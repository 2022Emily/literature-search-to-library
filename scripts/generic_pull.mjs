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

// 页面还在渲染 / 跳转时取字节常常落空，按固定间隔重试几次
async function pullRetry(sessionId, dst, tries = 4, gap = 3000, urlExpr = 'location.href') {
  let last;
  for (let i = 0; i < tries; i++) {
    await sleep(gap);
    try { return await pull(sessionId, dst, urlExpr); } catch (e) { last = e; }
  }
  throw last;
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

    // 找 PDF 入口：meta[name="citation_pdf_url"] 最可靠（未点名适配的出版社基本都发这个），
    // 其次才是页面上的下载链接；downloadTable / downloadRef / downloadSupplement 不是正文。
    // 有的站点两者都没有，只在页面数据里给 PDF 路径（SAGE 中国区代理站就是）
    let href = null;
    let src = '';
    let pageUrl = null;
    let verifySecs = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(2000);
      const raw = await cdp.ev(sessionId, `(()=>{
        const txt=document.body?document.body.innerText:'';
        const ts=/Verify you are human|确认您是真人|Checking your browser/i.test(txt);
        const pats=['a[href*="/pdfft?"]','a[href*="/doi/pdf/"]','a[href$=".pdf"]','a[href*="/pdf"]','a[href*="download"]'];
        const bad=/download(Table|Ref|Supplement|Citat)/i;
        let pick=null;
        for(const p of pats){const els=[...document.querySelectorAll(p)].filter(a=>!a.closest('nav,footer')&&!bad.test(a.getAttribute('href')||''));
          const cur=els.find(a=>/accessbar-utility|pdf-link|article-pdfLink/.test(a.className))||els[0]; if(cur){pick=cur;break}}
        const meta=document.querySelector('meta[name="citation_pdf_url"]');
        const html=document.documentElement.outerHTML;
        let dataPdf=null;
        {const arr=[];let i=html.indexOf('.pdf');
         while(i>-1&&arr.length<6){let s=i;while(s>0&&/[\\w\\-\\.\\/]/.test(html[s-1]))s--;arr.push(html.slice(s,i+4));i=html.indexOf('.pdf',i+5)}
         dataPdf=arr.map(x=>x.replace(/\\\\/g,'')).find(x=>x.startsWith('/')&&x.length>=8)||null}
        return JSON.stringify({url:location.href,ts,href:pick?pick.getAttribute('href'):null,
          meta:meta?meta.content:null,dataPdf,
          alt:location.pathname.match(/^\\/\\d+\\.\\d+\\//)?location.origin+location.pathname+'/pdf':null});
      })()`).catch(() => null);
      if (!raw) continue;
      const st = JSON.parse(raw);
      if (st.ts) { verifySecs += 2; if (i % 10 === 0) console.log(`⏸  ${it.doi} 需要人工验证…`); continue; }
      href = st.meta || st.href || st.dataPdf || st.alt;
      src = st.meta ? 'meta' : st.href ? 'link' : st.dataPdf ? 'data' : 'alt';
      if (href) { pageUrl = st.url; break; }
    }
    if (!href) {
      if (verifySecs >= 10) throw new Error(`人机验证未通过（已等 ${verifySecs} 秒，请在 Edge 窗口勾选后重跑）`);
      throw new Error('未找到 PDF 入口');
    }
    const full = href.startsWith('http') ? href : absUrl(it, href, pageUrl);
    console.log(`→ ${it.doi} 入口 ${full.slice(0, 100)}`);

    // 页面数据里的路径一般带 attachment 头，导航过去只会触发下载，留在文章页直接取
    if (src === 'data') {
      const r = await pullRetry(sessionId, dst, 6, 3000, JSON.stringify(full));
      markDone(OUT, it, dst, { pages: r.pages });
      console.log(`OK   ${it.doi}  ${(r.size / 1048576).toFixed(1)}MB  pages≈${r.pages}`);
      clearFailure(OUT, it.doi);
      continue;
    }

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
