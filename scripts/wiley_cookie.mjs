// Wiley 全文抓取：先让 PDF 在浏览器里真正加载，再导出 cookie，最后在 Node 侧复用 cookie 取字节。
// 顺序不可调换：PDF 加载之前导出的 cookie 一定 403。
// 用法：node wiley_cookie.mjs 9223 <输出目录> <items.json>
// items.json: [{ "doi": "10.1002/adma.2025xxxxx", "kind": "wiley", "file": "xxx.pdf" }]
import path from 'node:path';
import { readJson } from './lib_pdf.mjs';
import { connectOrExit, directDownload, sleep } from './lib_cdp.mjs';
import { recordFailure, clearFailure } from './lib_fail.mjs';
import { preSkip, markDone } from './lib_index.mjs';

const P = process.argv[2] || '9223';
const OUT = process.argv[3];
const ITEMS = readJson(process.argv[4]);
const HOST = 'https://advanced.onlinelibrary.wiley.com';
const cdp = await connectOrExit(P, { timeout: 90000 });
let fail = 0;

for (const it of ITEMS) {
  const dst = path.join(OUT, it.file);
  if (preSkip(OUT, it)) continue;
  let tid;
  try {
    // 检索阶段补的 host 优先：Wiley 的 Advanced 系列在 advanced.*，Small/Angew 等在裸域名。
    // 只认文章页域名（api.wiley.com 是 Crossref 里的 TDM 端点，浏览器打不开）；
    // host 缺失或不可用时，advanced.* 与裸域名各试一次，先成功的就用它。
    const bases = [];
    if (it.host && /^(advanced\.)?onlinelibrary\.wiley\.com$/.test(it.host)) bases.push(`https://${it.host}`);
    for (const b of [HOST, 'https://onlinelibrary.wiley.com']) if (!bases.includes(b)) bases.push(b);

    let page;
    let sessionId = '';
    let loaded = false;
    let finalUrl = '';
    let artUrl = '';
    for (const base of bases) {
      const pdfUrl = `${base}/doi/pdfdirect/${it.doi}`;
      artUrl = `${base}/doi/${it.doi}`;
      page = await cdp.newPage(pdfUrl);
      tid = page.targetId;
      sessionId = page.sessionId;
      for (let i = 0; i < 15; i++) {
        await sleep(2000);
        const href = await cdp.ev(sessionId, 'location.href').catch(() => '');
        // 通用 CARSI 登录页特征：CAS / Shibboleth IdP / 常见登录路径
        if (/cas\.|idp\.|login|identity|sso/i.test(String(href))) {
          throw new Error('需要 CARSI 登录，请先在该 Edge 窗口完成机构登录');
        }
        const ct = await cdp.ev(sessionId, 'document.contentType').catch(() => '');
        if (String(ct).includes('pdf')) { loaded = true; finalUrl = String(href) || pdfUrl; break; }
      }
      if (loaded) break;
      await cdp.closePage(tid);
      tid = undefined;
    }
    if (!loaded) throw new Error('PDF 未加载（可能无权限或未登录）');
    await sleep(3000);

    // 关键顺序：PDF 加载完成后才导出 cookie
    const wiley = (await cdp.cookies()).filter((c) => /wiley\.com$/.test(c.domain));
    if (!wiley.length) throw new Error('未取到 wiley cookie');
    const ua = await cdp.ev(sessionId, 'navigator.userAgent');
    // 裸域名会 302 到 advanced.*；用加载后的真实地址，避免 manual redirect 拿不到正文
    finalUrl = (await cdp.ev(sessionId, 'location.href').catch(() => '')) || finalUrl;
    const cookie = wiley.map((c) => `${c.name}=${c.value}`).join('; ');
    await cdp.closePage(tid);
    tid = undefined;

    const r = await directDownload(finalUrl, dst, { referer: artUrl, cookie, ua, redirect: 'manual' });
    markDone(OUT, it, dst, { pages: r.pages });
    clearFailure(OUT, it.doi);
    console.log(`OK   ${it.doi}  ${(r.size / 1048576).toFixed(1)}MB  → ${dst}`);
  } catch (e) {
    fail++;
    recordFailure(OUT, { doi: it.doi, kind: it.kind || 'wiley', script: 'wiley_cookie.mjs', file: it.file, reason: e.message });
    console.log(`FAIL ${it.doi}  ${e.message}`);
  } finally {
    await cdp.closePage(tid);
  }
  await sleep(10000);
}
await cdp.close();
if (fail) process.exitCode = 1;
