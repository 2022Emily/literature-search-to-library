# 学术文献检索与全文入库（Literature Search → Full-Text Library）

一个 skill 覆盖两条路径：`literature-search-to-library` 从关键词出发，检索 → 分析报告 → 人工选片 → 下载；也可以直接给 DOI，跳过检索与报告。下载端覆盖 Elsevier / ScienceDirect、AAAS / Science.org、ACS、Wiley、Springer / Nature、RSC、MDPI 七家出版社，并带跨批次去重、失败清单与三重校验。

下载端解决的不是「怎么找到论文」，而是「已经在机构网络里、却拿不到 PDF」这段路：付费墙文章在浏览器里能看到全文，但 Node 直连会被 403、CORS 或 Cloudflare 挡住。脚本把浏览器当作授权会话的载体，只在浏览器内建立会话，再把字节取回来。

> **使用前提**：你必须通过所在机构（校园网 IP、VPN 或 CARSI）拥有目标文章的访问权。本项目不提供、也不会实现任何绕过付费墙、验证码或 DRM 的机制。

## 与其他文献下载工具的不同

常见的文献下载工具（各类 Unpaywall 封装、OA 抓取脚本、DOI 批量下载器）只取开放获取（OA）全文；你确实付过费的订阅内容，仍要在浏览器里一篇篇手点。本 skill 的下载端凭机构授权逐家打通付费墙，把订阅全文取回来：

| 维度 | 只取 OA 的工具 | 本 skill |
|---|---|---|
| 全文范围 | OA / bronze | 另加 Elsevier、AAAS、ACS、Wiley、Springer·Nature、RSC 六家付费墙（MDPI 全 OA，但要过 Cloudflare） |
| 如何授权 | 无需 | 机构 IP（多数）、CARSI 校方 IdP（Wiley）、浏览器会话复用 |
| 结果是否可信 | 看文件大小 | `%PDF-` 头 + 页数 + 首页关键词 + SHA256，另有跨批次 DOI 去重 |
| 半途失败怎么办 | 从头再跑 | `_failed.json` 只记失败条目，`-Retry` 补跑，台账 `_index.json` 防重下 |
| 选哪些下 | 自己翻 DOI 清单 | 关键词 → 排序候选池 → 带判断的分析报告（Word / Markdown）→ 人工选片 → 才下载 |

前提是你的机构已订阅该文献。难点不在「找到 PDF 地址」，而在「地址拿到了却取不回字节」：付费墙文章在浏览器里能看全文，Node 直连却会吃 403、CORS 或 Cloudflare。所以脚本把浏览器当作授权会话的载体——会话在浏览器里建，正文不在浏览器里读，字节取回来交给 Node 落盘。遇到人机验证只轮询等待人工通过，不破解验证码、DRM 或任何访问控制。

## 目录

- [与其他文献下载工具的不同](#与其他文献下载工具的不同)
- [能力范围](#能力范围)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [关键词 → PDF 闭环](#关键词--pdf-闭环)
- [产物说明](#产物说明)
- [可选：同步到 IMA 知识库](#可选同步到-ima-知识库默认关闭)
- [退出码](#退出码)
- [常见失败对照](#常见失败对照)
- [工作原理](#工作原理)
- [已知局限](#已知局限)
- [合规与免责](#合规与免责)

## 能力范围

| 出版社 | 通道脚本 | 授权方式 |
|---|---|---|
| 纯 OA / bronze | `oa_route.mjs`（Node 直链，不走浏览器） | 无需授权 |
| Elsevier / ScienceDirect | `sd_pull.mjs` | 机构 IP |
| AAAS / science.org | `aaas_pull.mjs` | 机构 IP |
| ACS | `generic_pull.mjs` | 机构 IP |
| Wiley | `wiley_cookie.mjs` | CARSI（校方 IdP） |
| Springer / Nature | `springer_pull.mjs` | 机构 IP |
| RSC | `rsc_pull.mjs` | 机构 IP |
| MDPI | `mdpi_pull.mjs` | 全 OA，但需浏览器过 Cloudflare |

输入是**已有的 DOI 或文章页 URL 清单**。要从关键词开始找文献，走同一个技能的检索路径（见 [关键词 → PDF](#关键词--pdf-闭环)）。

暂未覆盖：IEEE、AIP、IOP、Taylor & Francis、SAGE、Cambridge / Oxford、PNAS；附属材料（SI）也未覆盖。这类条目会落 `kind=unknown`，需要手工指定入口。

## 环境要求

- **Windows 10/11**（编排脚本 `run_batch.ps1` 是 PowerShell，Windows 自带的 5.1 与 PowerShell 7 都能跑；单个 node 脚本本身跨平台，但没有提供 macOS / Linux 的启动封装）
- **Microsoft Edge**（默认查找 `Program Files (x86)` 与 `Program Files` 两处；两处都没有时前置检查直接以退出码 2 终止，装在别处需手工改脚本里的路径）
- **Node.js ≥ 22**（用到全局 `fetch` 与 `WebSocket`，后者要到 22 才稳定）
- **Python 3.9+，且 `python` 在 PATH 中**（脚本用 `python` 调起，不认 `py` 启动器）；PyMuPDF 用 `pip install pymupdf`，导出 Word 报告另需 `pip install python-docx`（缺失时只跳过 docx，不影响检索与下载）
- 可访问 `api.openalex.org`、`api.crossref.org`、`api.semanticscholar.org`、`api.unpaywall.org`（仅传 `-Email` 时用到）、`doi.org` 及各出版社域名

## 安装

本仓库**根目录就是技能目录本身**：

```
literature-search-to-library/
├── SKILL.md              # 入口：判断意图、按需加载分册、硬规则
├── README.md
├── LICENSE
├── references/
│   ├── search.md         # 检索 → 报告 → 检查点 → 简报（关键词路径）
│   └── download.md       # 七家出版社通道 + 硬约束（下载路径）
└── scripts/              # 21 个脚本，检索与下载共用（md2docx.py 负责导出 Word 报告）
```

两种装法，任选其一：

1. **项目级**：把本目录放到项目的 `.trae/skills/literature-search-to-library/` 下；下文命令按这个位置书写，在项目根目录执行。
2. **用户级（全局）**：把本目录复制到 `%USERPROFILE%\.trae-cn\skills\literature-search-to-library\`（或 WorkBuddy 的 `%USERPROFILE%\.workbuddy\skills\literature-search-to-library\`），之后任意项目可用；此时把命令里的 `.trae\skills\literature-search-to-library` 换成 `~\.trae-cn\skills\literature-search-to-library`。

若用发布页的 zip 包：**解压后的根目录本身就是技能目录**（`SKILL.md`、`README.md`、`LICENSE`、`references/`、`scripts/` 直接平铺），把这个目录整个拷进 `skills\` 即可，不要再套一层同名文件夹。

也可以完全不依赖 skill 运行时，直接 `node .trae\skills\literature-search-to-library\scripts\xxx.mjs` 调用——脚本之间只通过相对路径和 JSON 文件通信。

## 快速开始

```powershell
# 1. 准备清单：一行一个 DOI，或 doi.org 链接，或出版社文章页 URL
#    10.1016/j.jmatprocs.2025.xxxxxx
#    https://pubs.rsc.org/en/content/articlelanding/2024/...
#    也可以直接给 JSON 数组 [{"doi": "...", "file": "..."}]

# 2. 一键跑完整链路（自己启动 Edge、轮询端口、依次执行七个步骤）
& .trae\skills\literature-search-to-library\scripts\run_batch.ps1 -Out D:\lib\my-topic -Items D:\lib\dois.txt -Email you@example.com
```

`-Email` 用于 Unpaywall（不传则只用 OpenAlex）。Unpaywall 不接受示例邮箱。

常用参数：

| 参数 | 作用 |
|---|---|
| `-Out` | 输出目录（PDF、台账、报告都放这里） |
| `-Items` | DOI 清单（`.txt` 或 `.json`） |
| `-Retry` | 只重跑 `_failed.json` 里的条目 |
| `-NoEdge` | 不开浏览器，仅做归一化 / 元数据 / OA 直取 |
| `-SkipVerify` | 跳过最后的 PDF 校验 |
| `-Port` | 调试端口，默认 9223 |
| `-Profile` | Edge 用户目录，默认当前目录下 `_edgeprofile` |
| `-Kb` | 可选：校验后把 PDF 另存一份到 IMA 知识库（也可设环境变量 `IMA_KB_ID`），见 [可选：同步到 IMA 知识库](#可选同步到-ima-知识库默认关闭) |
| `-SkipIma` | 即使配了 `-Kb` / `IMA_KB_ID` 也不上传 |

手工调试单个环节时，等价于这五步：

```powershell
$S = ".trae\skills\literature-search-to-library\scripts"
node "$S\normalize.mjs"   <输入> <Out>\_items_norm.json --port 9223
node "$S\enrich_meta.mjs" <Out>\_items_norm.json <Out>\_items_enriched.json
node "$S\oa_route.mjs"    <Out> <Out>\_items_enriched.json
node "$S\dispatch.mjs"    9223 <Out>
python "$S\verify_pdf.py" <Out> --meta <Out>\meta.json
```

## 关键词 → PDF 闭环

只给关键词也能跑通，走同一个技能的检索路径（脚本 `scripts/search_multi.mjs`，数据源 OpenAlex）：

```powershell
# 1. 检索：产出候选池 JSON + 排序表（被引年化 → 期刊档 → 相关度）
node .trae\skills\literature-search-to-library\scripts\search_multi.mjs pool.json `
  --query "perovskite solar cell" --from 2026 --to 2026 --email you@example.com

# 2. 补元数据：publisher / host / pii + 印刷期日期 + 三源摘要（下载阶段靠 host 路由，缺了会落 unknown）
node .trae\skills\literature-search-to-library\scripts\enrich_meta.mjs pool.json pool_enriched.json

# 3. 分析：生成 _analysis_draft.md，由 agent 按 SKILL.md 里的定稿骨架补成 _analysis.md（检查点的前置产物）
node .trae\skills\literature-search-to-library\scripts\analyze_pool.mjs pool_enriched.json

# 4. 导出 Word 版：产出同目录 _analysis.docx（标题层级、列表、表格、加粗均保留）
python .trae\skills\literature-search-to-library\scripts\md2docx.py _stage\<主题>\_analysis.md

# 5. 人工选片（先给 A 组逐篇简报（4–8 篇，格式同第三节评述）+ 两个待确认项，再问「下载哪些、存哪里」，可选同步进 IMA 知识库）

# 6. 下载 + 校验（要走 IMA 时加 -Kb <知识库ID>，见[可选：同步到 IMA 知识库](#可选同步到-ima-知识库默认关闭)）
& .trae\skills\literature-search-to-library\scripts\run_batch.ps1 -Out D:\lib\my-topic -Items pool_selected.json -Email you@example.com
```

检索侧已过滤无 DOI、仓储记录（Figshare 等 `dataset`）与无期刊来源的条目，所以候选池里的每一条都能进入下载阶段。排序键：被引年化 → 期刊档 → 相关度，不使用综合加权分；`IF≈` 取自 OpenAlex 近两年篇均被引，不是 JCR 官方影响因子。

## 产物说明

| 文件 | 内容 |
|---|---|
| `_items_norm.json` | 归一化后的条目（DOI、kind、file） |
| `_items_enriched.json` | 补上 `publisher` / `host` / `pii` / `title` / `journal` / `year` / `firstAuthor` |
| `meta.json` | 每个 PDF 的校验关键词与 DOI |
| `_oa_report.json` | 每条的去向：`oa` / `index` / `pending-browser`，以及 `status` |
| `_browser_pending.json` | 需要浏览器通道的条目，交给 `dispatch.mjs` |
| `_failed.json` | 失败清单（`doi`、`kind`、`reason`、`attempts`），成功即自动清除 |
| `_verify_report.json` | 三重校验明细（头、页数、关键词、SHA256） |
| `_index.json` | 跨批次台账：`DOI → 文件 + sha256 + 页数`，决定「这篇是否已完成」 |
| `_ima_uploaded.json` | 仅在使用 `-Kb` 时出现：`DOI → {知识库, 文件, sha256, media_id}`，防止重复上传 |
| `_ima_report.json` | 仅在使用 `-Kb` 时出现：本次上传的逐条结果（`ok` / `duplicate` / `fail`） |
| `_analysis.md` | 检索阶段的分析报告（检查点前置产物），由 agent 按定稿骨架补写 |
| `_analysis.docx` | 同一份报告的 Word 版，`md2docx.py` 生成；缺 `python-docx` 时不产出 |

`_index.json` 是去重与断点续跑的唯一依据。只要台账里同一 DOI 的 sha256 与磁盘文件一致，重跑时会直接跳过；反之会重新下载。

## 可选：同步到 IMA 知识库（默认关闭）

默认**纯本地**：不传 `-Kb` 就完全不联网、不上传，PDF 只落在 `-Out` 目录里。

如果你已经在用 IMA 知识库，可以让下载流程在**校验通过后**额外上传一份：

```powershell
& .trae\skills\literature-search-to-library\scripts\run_batch.ps1 -Out D:\lib\my-topic -Items dois.txt -Kb <知识库ID>
# 等价：$env:IMA_KB_ID = "<知识库ID>" 后再跑，或单跑
node .trae\skills\literature-search-to-library\scripts\upload_ima.mjs D:\lib\my-topic --kb <知识库ID> --dry    # 只看清单，不联网
node .trae\skills\literature-search-to-library\scripts\upload_ima.mjs D:\lib\my-topic --kb <知识库ID> [--folder <文件夹ID>] [--limit N]
```

- **上传是复制，不是搬家**：本地 PDF 永远保留（台账、重跑与去重都依赖它）。
- 只上传「台账命中 + 已通过校验（`verified` 非空）」的条目；未校验、sha256 变了、文件缺失的一律跳过并打印原因。
- 需要本机已装 `ima-skill`（从 `~/.trae-cn/skills/ima-skill` 或 `~/.workbuddy/skills/ima-skill` 读取其 `ima_api.cjs` / `preflight-check.cjs` / `cos-upload.cjs`），凭证放在 `~/.config/ima/client_id` + `api_key`，或设 `IMA_OPENAPI_CLIENTID` / `IMA_OPENAPI_APIKEY`。
- 缺知识库 ID、缺技能包、缺凭证都只打印一行原因后跳过，**不改变下载结果的退出码**；上传失败也仅 WARN。
- 同名文件在知识库里已存在时按「重复」跳过，不会制造 `_副本`。
- PDF 会先传到腾讯云 COS 再进知识库；对上传位置有合规要求时请先确认存储策略。

## 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 全部完成（或全部命中台账） |
| `1` | 跑完了，但有条目未取到 / 校验未通过（看 `_failed.json`、`_oa_report.json`、`_verify_report.json`） |
| `2` | 前置环境缺失（缺 `node`、缺 Python/PyMuPDF、找不到 Edge），未进入流程；`-NoEdge` 只跳过 Edge 检查，`-Dry` 跳过 Edge 与 Python 检查 |

`-NoEdge` 模式下没有浏览器通道接手，`pending-browser` 计为最终失败，返回 1。

## 常见失败对照

| 现象 | 原因 | 处理 |
|---|---|---|
| `ECONNREFUSED` / 无法连接端口 | 启动 Edge、轮询端口、跑脚本不在同一条命令里，Edge 被回收 | 统一用 `run_batch.ps1` |
| `人机验证未通过（已等 N 秒…）` | Cloudflare Turnstile 没通过 | 在 Edge 窗口勾选，再 `-Retry` |
| `无全文访问权限（页面未出现 FULL ACCESS）` | 本机构无该刊订阅 | 换渠道获取，脚本不会重试成功 |
| `需要 CARSI 登录` | 校方 IdP 会话过期 | 在该 Edge profile 里重新登录一次 |
| `WARN ... kind=unknown` | 候选池缺 `publisher` / `host` | 先跑 `enrich_meta.mjs`，仍缺则手工指定通道 |
| Wiley `CPE00002` | 请求频率过高 | 等待后重跑，脚本默认每篇间隔 10 秒 |
| `FAIL 页数不足 / 关键词未命中` | 下到了错误的页（付费墙 HTML、打印页）或扫描版 PDF | 看 `_verify_report.json` 的 `hits` 与 `textless` |

## 工作原理

1. **先 OA**：`oa_route.mjs` 查 OpenAlex（可选 Unpaywall）的 `pdf_url`，Node 直接下载并验 `%PDF-`。能白拿的绝不走浏览器。
2. **按 publisher / host 路由**：只用 Crossref 的 `publisher` 与 `link[].URL` 的 host 判定出版社，**不用 DOI 前缀兜底**（前缀只标识注册方，不标识托管域名）。
3. **浏览器建会话，不在浏览器里读正文**：
   - 同源 `fetch` → blob → `FileReader` 分块 base64 回传（AAAS、Springer、MDPI、ACS）
   - 让 PDF 真正加载后导出 cookie，Node 复用（Wiley）
   - 导航到签名直链后 Node 下载（RSC）
   - 导航到 assets 页后页内 fetch（Elsevier）
4. **三重校验**：`%PDF-` 头 + 页数 + 首页关键词，另有 SHA256 与重复 DOI 检测。
5. **台账**：校验通过写入 `_index.json`，后续批次按 DOI 去重。

关键约束：**启动 Edge → 轮询端口 200 → 跑脚本必须在同一条 Shell 命令里**，否则 Edge 会被回收。`run_batch.ps1` 已内置这段。

## 已知局限

- 单线程串行执行，单篇最坏 80–90 秒（等待轮询），大批量耗时较长。
- 出版社订阅是**按刊**的：同一出版社下有的期刊能取、有的被退回文章页，这是权限差异，不是脚本 bug。
- ACS 的 PDF 字节不稳定（同文两次下载长度相同但 SHA256 不同），因此去重以 DOI 为准。
- 出版社改版会导致入口选择器失效，报 `未找到 PDF 入口`。
- 无自动化测试（当前为手工实跑验证）。

## 合规与免责

- 本项目仅用于**下载你本人（或你所在机构）已付费订阅的文献**，供个人学术研究使用。
- 使用者需自行遵守出版社的用户协议（多数禁止系统性的批量抓取）、所在机构的网络与账号管理规定，以及所在国家的版权法。
- 脚本不会破解验证码、DRM 或任何访问控制；遇到人机验证时只轮询等待人工通过。
- 请控制请求频率，不要共享机构账号，不要将下载内容再分发。
- 因使用本工具产生的任何后果由使用者自行承担。

## 许可

[MIT](LICENSE) © 2026 Xiyue Huang

可以自由使用、修改、再分发，包括商用；保留版权与许可声明即可。软件按「现状」提供，不附带任何担保。
