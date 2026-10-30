// 失败清单：<输出目录>/_failed.json。每个抓取脚本 FAIL 时落盘、成功时清除，
// 便于断点续跑与事后统计。
// 写入走「临时文件 + rename」，避免中断时留下半截 JSON；读取遇到损坏文件会
// 另存为 *.corrupt-*.json 并告警，而不是静默当成「没有失败」。
import fs from 'node:fs';
import path from 'node:path';

const fileOf = (out) => path.join(out, '_failed.json');

function writeAtomic(dst, data) {
  const tmp = `${dst}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dst);
}

export function loadFailures(out) {
  const f = fileOf(out);
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    const bad = `${f}.corrupt-${Date.now()}.json`;
    try { fs.renameSync(f, bad); } catch { /* 另存失败不阻断流程，下面照样告警 */ }
    console.log(`WARN 失败清单无法解析（${e.message}），已另存为 ${path.basename(bad)}，按空清单继续`);
    return [];
  }
}

export function recordFailure(out, { doi, kind = '', script = '', file = '', reason = '' }) {
  const list = loadFailures(out);
  const now = new Date().toISOString();
  const i = list.findIndex((x) => x.doi === doi);
  let entry;
  if (i >= 0) {
    entry = { ...list[i], kind: kind || list[i].kind, script, file: file || list[i].file, reason, attempts: (list[i].attempts || 1) + 1, last: now };
    list[i] = entry;
  } else {
    entry = { doi, kind, script, file, reason, attempts: 1, first: now, last: now };
    list.push(entry);
  }
  fs.mkdirSync(out, { recursive: true });
  writeAtomic(fileOf(out), JSON.stringify(list, null, 2));
  return entry;
}

export function clearFailure(out, doi) {
  const list = loadFailures(out);
  const next = list.filter((x) => x.doi !== doi);
  if (next.length === list.length) return;
  const f = fileOf(out);
  if (next.length === 0) {
    try { fs.unlinkSync(f); } catch { /* 已经不存在就算了 */ }
  } else {
    writeAtomic(f, JSON.stringify(next, null, 2));
  }
}
