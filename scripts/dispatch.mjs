// 按 _browser_pending.json 的 kind 自动分派到对应抓取脚本。
// 用法：node dispatch.mjs <端口> <输出目录> [--dry] [--retry-failed]
//   --dry           只打印分派结果
//   --retry-failed  改读 _failed.json，只重跑上次失败的条目
// kind=unknown 交给 generic_pull 兜底（读 citation_pdf_url），取不到再来记一次失败。
// 依赖同目录下的 aaas_pull / sd_pull / wiley_cookie / generic_pull / springer_pull / rsc_pull / mdpi_pull / ieee_pull。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson } from './lib_pdf.mjs';
import { loadFailures } from './lib_fail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = process.argv[2] || '9223';
const OUT = process.argv[3];
const DRY = process.argv.includes('--dry');
const RETRY = process.argv.includes('--retry-failed');

const MAP = {
  elsevier: 'sd_pull.mjs',
  aaas: 'aaas_pull.mjs',
  wiley: 'wiley_cookie.mjs',
  acs: 'generic_pull.mjs',
  mdpi: 'mdpi_pull.mjs',
  springer: 'springer_pull.mjs',
  rsc: 'rsc_pull.mjs',
  ieee: 'ieee_pull.mjs',
  // 未点名适配的出版社走通用兜底：读 citation_pdf_url，取不到就照旧记失败
  unknown: 'generic_pull.mjs',
};
// 有依赖关系的顺序：先 Elsevier（会复用已开着的 assets 页），其余互不影响；兜底放最后
const ORDER = ['elsevier', 'aaas', 'acs', 'wiley', 'springer', 'rsc', 'mdpi', 'ieee', 'unknown'];

let items;
if (RETRY) {
  const failed = loadFailures(OUT);
  if (!failed.length) {
    console.log('没有失败记录，无需重试');
    process.exit(0);
  }
  // 从 enriched 里补回 host / pii，失败记录只保留了 doi / kind / file
  const enh = path.join(OUT, '_items_enriched.json');
  const byDoi = fs.existsSync(enh) ? new Map(readJson(enh).map((x) => [x.doi, x])) : new Map();
  items = failed.map((f) => {
    const src = byDoi.get(f.doi) || {};
    return { ...src, doi: f.doi, kind: f.kind || src.kind, file: f.file || src.file };
  });
  console.log(`按 _failed.json 重试 ${items.length} 篇（上次失败次数见清单）`);
} else {
  const pendingFile = path.join(OUT, '_browser_pending.json');
  if (!fs.existsSync(pendingFile)) {
    console.log(`未找到 ${pendingFile}，请先跑 oa_route.mjs`);
    process.exit(2);
  }
  items = readJson(pendingFile);
}

const groups = {};
const unsupported = [];
for (const it of items) {
  const kind = it.kind || 'unknown';
  if (MAP[kind]) (groups[kind] ||= []).push(it);
  else unsupported.push(it);
}
for (const it of groups.unknown || []) {
  console.log(`WARN ${it.doi}  kind=unknown，走通用兜底（读 citation_pdf_url）`);
}
for (const it of unsupported) {
  console.log(`WARN ${it.doi}  kind=${it.kind} 暂无对应脚本，需手工处理`);
}

const failedKinds = [];
for (const kind of ORDER) {
  const list = groups[kind];
  if (!list?.length) continue;
  const script = MAP[kind];
  const tmp = path.join(OUT, `_pending_${kind}.json`);
  console.log(`\n=== ${kind} → ${script}（${list.length} 篇）===`);
  if (DRY) {
    console.log(`[dry] node ${script} ${P} ${OUT} ${tmp}（${list.map((x) => x.doi).join(', ')}）`);
    continue;
  }
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  const r = spawnSync(process.execPath, [path.join(HERE, script), P, OUT, tmp], {
    stdio: 'inherit',
    cwd: HERE,
  });
  if (r.status !== 0) failedKinds.push(kind);
  fs.rmSync(tmp, { force: true });
}

// 汇总失败清单
const failures = loadFailures(OUT);
if (failures.length) {
  console.log(`\n失败清单 _failed.json：${failures.length} 篇`);
  for (const f of failures) {
    console.log(`  ${f.doi}  [${f.kind || '?'}] ×${f.attempts || 1}  ${f.reason}`);
  }
  console.log('修复后用 --retry-failed 只重跑这些条目');
}

console.log(`\n分派结束${unsupported.length ? `，${unsupported.length} 篇未处理（kind 缺失或无脚本）` : ''}`);
if (failedKinds.length) {
  console.log(`失败通道：${failedKinds.join(', ')}`);
  process.exit(1);
}
