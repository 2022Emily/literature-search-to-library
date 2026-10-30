// 统一 Edge CDP 会话：连接、eval、开关标签页、页内分块取字节、Node 直接下载。
// 所有抓取脚本共用，避免各自复制一份脚手架。
import fs from 'node:fs';
import path from 'node:path';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connect(port = '9223', { timeout = 60000, chunk = 2 * 1024 * 1024 } = {}) {
  let info;
  try {
    info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  } catch {
    throw new Error(`端口 ${port} 无响应（Edge 未启动或已被回收）`);
  }
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  let seq = 0;
  const waiting = new Map();

  function send(method, params = {}, sessionId) {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => {
      waiting.set(id, res);
      setTimeout(() => {
        if (waiting.has(id)) { waiting.delete(id); rej(new Error('timeout ' + method)); }
      }, timeout);
    });
  }
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));

  async function ev(sessionId, expression, awaitPromise = false) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text || r.exceptionDetails.exception?.description || 'eval error');
    }
    return r.result?.value;
  }

  async function newPage(url) {
    const { targetId } = await send('Target.createTarget', { url, background: false });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    return { targetId, sessionId };
  }

  async function closePage(targetId) {
    if (!targetId) return;
    try { await send('Target.closeTarget', { targetId }); } catch {}
  }

  async function targets() {
    return (await send('Target.getTargets')).targetInfos;
  }

  async function cookies() {
    return (await send('Storage.getCookies', {})).cookies;
  }

  // 页内同源 fetch，按 chunk 分块 base64 回传，避免整包塞进一条 CDP 消息。
  // urlExpr 是 JS 表达式：JSON.stringify(路径) 或 'location.href'
  async function fetchInPage(sessionId, urlExpr) {
    const raw = await ev(sessionId,
      `fetch(${urlExpr},{credentials:'include'}).then(r=>r.blob()).then(b=>{window.__pdf=b;return b.size+'|'+b.type}).catch(e=>'ERR:'+e.message)`, true);
    const [szRaw, mime] = String(raw).split('|');
    const size = Number(szRaw);
    if (!Number.isFinite(size)) throw new Error('页内 fetch 失败: ' + raw);
    const parts = [];
    for (let off = 0; off < size; off += chunk) {
      const b64 = await ev(sessionId,
        `(()=>new Promise(res=>{const f=new FileReader();f.onload=()=>res(f.result.split(',')[1]);f.readAsDataURL(window.__pdf.slice(${off},${off}+${chunk}))}))()`, true);
      parts.push(Buffer.from(b64, 'base64'));
    }
    return { buf: Buffer.concat(parts), size, mime };
  }

  async function close() {
    try { ws.close(); } catch {}
  }

  return { send, ev, newPage, closePage, targets, cookies, fetchInPage, close };
}

// 连不上直接给出可操作的提示并退出，避免每个脚本各自处理
export async function connectOrExit(port = '9223', opts = {}) {
  try {
    return await connect(port, opts);
  } catch (e) {
    console.log(`无法连接 Edge 调试端口 ${port}：${e.message}`);
    console.log('请把「启动 Edge → 轮询 200 → 跑脚本」放在同一条命令里，或用 run_batch.ps1。');
    process.exit(1);
  }
}

// 校验 %PDF- 头后落盘，返回体积与页数
export function savePdf(buf, dst) {
  const head = buf.subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') throw new Error(`取回非 PDF（${buf.length}B，head=${JSON.stringify(head)}）`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, buf);
  const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  return { size: buf.length, pages };
}

// Node 侧直接 GET 并落盘（可选 cookie / referer / 手动重定向）
export async function directDownload(url, dst, { referer, cookie, ua = UA, redirect = 'follow' } = {}) {
  const headers = { 'user-agent': ua, accept: 'application/pdf,*/*' };
  if (referer) headers.referer = referer;
  if (cookie) headers.cookie = cookie;
  const r = await fetch(url, { redirect, headers, signal: AbortSignal.timeout(120000) });
  const buf = Buffer.from(await r.arrayBuffer());
  const head = buf.subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') {
    throw new Error(`取回非 PDF（${buf.length}B，status=${r.status} ${r.headers.get('content-type') || ''}）`);
  }
  return savePdf(buf, dst);
}
