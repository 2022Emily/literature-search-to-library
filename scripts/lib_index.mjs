// DOI 台账 <输出目录>/_index.json：{ "<doi 小写>": { file, sha256, bytes, pages, downloaded, verified } }
// 抓取脚本落盘成功时登记（verified: null），verify_pdf.py 校验通过后补 verified 时间戳。
// SKIP 判据 = 台账命中 + 文件存在 + 体积一致 + sha256 一致；validPdf 仅作前置过滤。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validPdf } from './lib_pdf.mjs';

const fileOf = (out) => path.join(out, '_index.json');
const indexCache = new Map(); // out -> index
const shaCache = new Map(); // `${path}:${size}:${mtimeMs}` -> sha256

export function loadIndex(out) {
  if (indexCache.has(out)) return indexCache.get(out);
  let idx = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(fileOf(out), 'utf8').replace(/^\uFEFF/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) idx = parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') console.log(`WARN 台账解析失败（${fileOf(out)}）：${e.message}；按空台账处理，相关文件会重下`);
  }
  for (const k of Object.keys(idx)) if (!idx[k]?.file) delete idx[k];
  indexCache.set(out, idx);
  return idx;
}

export function saveIndex(out, idx) {
  fs.mkdirSync(out, { recursive: true });
  const tmp = `${fileOf(out)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, fileOf(out));
  indexCache.set(out, idx);
}

export function sha256File(p) {
  try {
    const st = fs.statSync(p);
    const key = `${p}:${st.size}:${st.mtimeMs}`;
    const hit = shaCache.get(key);
    if (hit) return hit;
    const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    shaCache.set(key, h);
    return h;
  } catch {
    return '';
  }
}

// 台账命中（真·已完成）：同一 DOI、文件在、体积与 sha256 都对得上
export function alreadyDone(out, doi) {
  const e = loadIndex(out)[String(doi).toLowerCase()];
  if (!e?.file) return null;
  const p = path.join(out, e.file);
  if (!validPdf(p)) return null;
  if (!e.sha256) return null;
  if (e.bytes && fs.statSync(p).size !== e.bytes) return null;
  if (sha256File(p) !== e.sha256) return null;
  return e;
}

// 同名文件存在但台账无记录：先改名留档，避免静默覆盖用户文件
export function dropStale(dst, doi) {
  const bak = dst.replace(/\.pdf$/i, '') + '.unverified.pdf';
  try {
    fs.renameSync(dst, bak);
    console.log(`WARN ${doi}  已有同名 PDF 但台账无记录，改名为 ${path.basename(bak)} 后重下`);
  } catch (e) {
    console.log(`WARN ${doi}  无法改名旧文件（${e.message}），将直接覆盖`);
  }
}

// 抓取脚本开头调用：台账命中返回 true（跳过）；否则清理同名旧文件后返回 false
export function preSkip(out, it) {
  const done = alreadyDone(out, it.doi);
  if (done) {
    console.log(`SKIP ${it.doi}  台账命中 ${done.file}${done.verified ? '' : '（未校验）'}`);
    return true;
  }
  const dst = path.join(out, it.file);
  if (validPdf(dst)) dropStale(dst, it.doi);
  return false;
}

// 落盘成功后登记台账（verified 留空，等 verify_pdf.py 补）
export function markDone(out, it, dst, { pages = 0 } = {}) {
  const idx = loadIndex(out);
  const key = String(it.doi).toLowerCase();
  let bytes = 0;
  try { bytes = fs.statSync(dst).size; } catch {}
  idx[key] = {
    file: path.basename(dst),
    sha256: sha256File(dst),
    bytes,
    pages,
    downloaded: new Date().toISOString(),
    verified: null,
  };
  saveIndex(out, idx);
}
