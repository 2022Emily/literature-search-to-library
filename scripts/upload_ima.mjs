// 可选：把已校验的 PDF 同步到 IMA 知识库（默认关闭，不传 kb_id 就什么都不做）。
// 用法：node upload_ima.mjs <输出目录> [--kb <知识库ID>] [--folder <文件夹ID>] [--dry] [--limit N]
//   --kb      也可用环境变量 IMA_KB_ID；缺省即跳过（不改退出码）
//   --dry     只打印「将上传 / 已跳过」清单，不联网、不需要凭证
// 依赖已安装的 ima-skill（其 ima_api.cjs / preflight-check.cjs / cos-upload.cjs）。
// 本地 PDF 一律保留：台账、sha256 校验与重跑都依赖它。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadIndex, alreadyDone } from './lib_index.mjs';

const args = process.argv.slice(2);
const OUT = args[0];
if (!OUT || OUT.startsWith('--')) {
  console.log('用法：node upload_ima.mjs <输出目录> [--kb <知识库ID>] [--folder <文件夹ID>] [--dry] [--limit N]');
  process.exit(2);
}
const opt = (name, def = '') => {
  const i = args.indexOf(`--${name}`);
  return i > 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const KB = opt('kb', process.env.IMA_KB_ID || '');
const FOLDER = opt('folder', '');
const DRY = args.includes('--dry');
const LIMIT = Number(opt('limit', '0')) || 0;

// ---------- 前置：ima-skill 与凭证 ----------
function findSkillDir() {
  const cands = [
    process.env.IMA_SKILL_DIR || '',
    path.join(os.homedir(), '.trae-cn', 'skills', 'ima-skill'),
    path.join(os.homedir(), '.workbuddy', 'skills', 'ima-skill'),
  ].filter(Boolean);
  return cands.find((d) => fs.existsSync(path.join(d, 'ima_api.cjs'))) || '';
}
function readCreds() {
  const env = { id: process.env.IMA_OPENAPI_CLIENTID || '', key: process.env.IMA_OPENAPI_APIKEY || '' };
  if (env.id && env.key) return env;
  const dir = path.join(os.homedir(), '.config', 'ima');
  const read = (f) => {
    try { return fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch { return ''; }
  };
  return { id: read('client_id'), key: read('api_key') };
}

// ---------- 待上传清单：只认「台账命中 + 已校验」 ----------
const ledgerFile = path.join(OUT, '_ima_uploaded.json');
let ledger = {};
try {
  ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8').replace(/^\uFEFF/, ''));
} catch { ledger = {}; }

const idx = loadIndex(OUT);
const todo = [];
const skipped = [];
for (const doi of Object.keys(idx)) {
  const done = alreadyDone(OUT, doi);
  if (!done) { skipped.push({ doi, why: '台账不符（文件缺失或 sha256 变了）' }); continue; }
  if (!done.verified) { skipped.push({ doi, why: '未通过 verify' }); continue; }
  const prev = ledger[doi];
  if (prev && prev.kb === KB && prev.sha256 === done.sha256) { skipped.push({ doi, why: '已上传过' }); continue; }
  todo.push({ doi, file: done.file, sha256: done.sha256, bytes: done.bytes || 0 });
}
if (LIMIT > 0) todo.length = Math.min(todo.length, LIMIT);

console.log(`待上传 ${todo.length} 篇，跳过 ${skipped.length} 篇${DRY ? '（dry run）' : ''}`);
for (const x of skipped) console.log(`SKIP ${x.doi}  ${x.why}`);
for (const x of todo) console.log(`  →  ${x.file}  ${(x.bytes / 1048576).toFixed(1)}MB  ${x.doi}`);

if (!KB) {
  console.log('未指定 --kb / IMA_KB_ID，跳过上传');
  process.exit(0);
}
if (DRY) {
  console.log(`\n[kb ${KB}] 以上将被上传；去掉 --dry 才会真正执行`);
  process.exit(0);
}
if (!todo.length) {
  console.log('没有需要上传的条目');
  process.exit(0);
}

const skillDir = findSkillDir();
if (!skillDir) {
  console.log('WARN 未找到 ima-skill（期待 ~/.trae-cn/skills/ima-skill 或 --skill），跳过上传');
  process.exit(0);
}
const creds = readCreds();
if (!creds.id || !creds.key) {
  console.log('WARN 未配置 IMA 凭证（~/.config/ima/client_id + api_key），跳过上传');
  process.exit(0);
}

// ---------- IMA 调用 ----------
function ima(apiPath, body) {
  const r = spawnSync(process.execPath, [
    path.join(skillDir, 'ima_api.cjs'), apiPath,
    JSON.stringify(body), JSON.stringify({ clientId: creds.id, apiKey: creds.key }),
  ], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) {
    let msg = (r.stderr || '').trim();
    try { msg = JSON.parse(msg).msg || msg; } catch { /* 保留原文 */ }
    throw new Error(`ima_api 失败：${msg || `exit ${r.status}`}`);
  }
  const j = JSON.parse(r.stdout);
  if (j.code !== 0) throw new Error(`IMA 返回 code=${j.code}：${j.msg}`);
  return j.data;
}

// 批量查重名：知识库里已有同名文件的直接跳过，不制造副本
let repeated = new Set();
try {
  const body = { params: todo.map((x) => ({ name: x.file, media_type: 1 })), knowledge_base_id: KB };
  if (FOLDER) body.folder_id = FOLDER;
  const data = ima('openapi/wiki/v1/check_repeated_names', body);
  repeated = new Set((data?.results || []).filter((r) => r.is_repeated).map((r) => r.name));
} catch (e) {
  console.log(`WARN 重名检查失败（${e.message}），继续按本地台账去重`);
}

function preflight(file) {
  const r = spawnSync(process.execPath, [
    path.join(skillDir, 'knowledge-base', 'scripts', 'preflight-check.cjs'), '--file', file,
  ], { encoding: 'utf8', timeout: 30000 });
  const j = JSON.parse(r.stdout || '{}');
  if (!j.pass) throw new Error(`预检未通过：${j.reason || '未知原因'}`);
  return j;
}

function cosUpload(file, cred, contentType) {
  const r = spawnSync(process.execPath, [
    path.join(skillDir, 'knowledge-base', 'scripts', 'cos-upload.cjs'),
    '--file', file,
    '--secret-id', String(cred.secret_id), '--secret-key', String(cred.secret_key), '--token', String(cred.token),
    '--bucket', String(cred.bucket_name), '--region', String(cred.region),
    '--cos-key', String(cred.cos_key), '--content-type', contentType,
    '--start-time', String(cred.start_time), '--expired-time', String(cred.expired_time),
    '--timeout', '300000',
  ], { encoding: 'utf8', timeout: 320000 });
  if (r.status !== 0) throw new Error(`COS 上传失败：${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
}

const report = [];
let fail = 0;
for (const it of todo) {
  const abs = path.join(OUT, it.file);
  if (repeated.has(it.file)) {
    report.push({ doi: it.doi, file: it.file, status: 'duplicate', reason: '知识库已有同名文件' });
    console.log(`DUP  ${it.file}  知识库已有同名文件，跳过`);
    continue;
  }
  try {
    const pf = preflight(abs);
    const media = ima('openapi/wiki/v1/create_media', {
      file_name: pf.file_name, file_size: pf.file_size, content_type: pf.content_type,
      knowledge_base_id: KB, file_ext: pf.file_ext,
    });
    if (!media?.media_id || !media?.cos_credential) throw new Error('create_media 未返回 media_id / cos_credential');
    cosUpload(abs, media.cos_credential, pf.content_type);
    const add = {
      media_type: pf.media_type, media_id: media.media_id, title: pf.file_name,
      knowledge_base_id: KB,
      file_info: { cos_key: media.cos_credential.cos_key, file_size: pf.file_size, file_name: pf.file_name },
    };
    if (FOLDER) add.folder_id = FOLDER;
    ima('openapi/wiki/v1/add_knowledge', add);

    ledger[it.doi] = { kb: KB, file: it.file, sha256: it.sha256, media_id: media.media_id, time: new Date().toISOString() };
    fs.mkdirSync(OUT, { recursive: true });
    const tmp = `${ledgerFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    fs.renameSync(tmp, ledgerFile);
    report.push({ doi: it.doi, file: it.file, status: 'ok', media_id: media.media_id });
    console.log(`OK   ${it.file}  media_id=${media.media_id}`);
  } catch (e) {
    fail++;
    report.push({ doi: it.doi, file: it.file, status: 'fail', reason: e.message });
    console.log(`FAIL ${it.file}  ${e.message}`);
  }
  await new Promise((s) => setTimeout(s, 1500));
}

fs.writeFileSync(path.join(OUT, '_ima_report.json'), JSON.stringify(report, null, 2));
const ok = report.filter((r) => r.status === 'ok').length;
console.log(`\nIMA 同步结束：成功 ${ok} / 跳过 ${skipped.length + report.filter((r) => r.status === 'duplicate').length} / 失败 ${fail}`);
if (fail) process.exitCode = 1;
