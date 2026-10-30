// 判断已有文件是不是一个「看起来完整的 PDF」。
// 仅作前置过滤：不代表「这篇已完成」，完成与否以 _index.json 的 DOI + sha256 为准（见 lib_index.mjs）。
import fs from 'node:fs';

export const SKIP_MIN = 100000;

// 读取 JSON 输入文件，容忍 PowerShell 5 的 UTF-8 BOM
export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

export function validPdf(p) {
  try {
    const st = fs.statSync(p);
    if (st.size < SKIP_MIN) return false;
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(5);
    fs.readSync(fd, b, 0, 5, 0);
    fs.closeSync(fd);
    return b.toString('latin1') === '%PDF-';
  } catch {
    return false;
  }
}
