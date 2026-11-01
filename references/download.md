# 下载分册：出版社全文下载

> 由 `SKILL.md` 按需加载。出现「下载 / 取 PDF / 给我全文 / 这批 DOI」这类需求时读本文件；关键词检索见 `search.md`。

按出版社选通道。先判断授权状态，再取字节；取字节优先交给 Node，浏览器只负责建立授权会话。

脚本统一放在 `<技能目录>\scripts\`，下文写作 `$S`（由 `SKILL.md` 的 Glob 规则定位成绝对路径）。看到 `scripts/xxx` 或 `.\scripts\xxx` 一律按 `$S\xxx` 理解。

## 一键编排（首选）

整条链路已封进 `scripts/run_batch.ps1`，它自己启动 Edge、轮询端口、按顺序跑完全部脚本，避免手工拼装出错：

```powershell
.\scripts\run_batch.ps1 -Out <输出目录> -Items <doi清单.txt|items.json> [-Email 你的邮箱] [-Retry] [-NoEdge] [-SkipVerify] [-Dry] [-Reuse] [-Kb <IMA知识库ID>] [-SkipIma]
```

- 输入可以是纯 DOI、`https://doi.org/...`、或出版社文章页 URL，一行一条，也可以是 JSON 数组
- `-Retry` 只重跑 `_failed.json` 里的条目
- `-NoEdge` 跳过浏览器（仅做 normalize / enrich / OA 直取）；此时没有通道接手 `pending-browser`，这些条目按最终失败计入退出码 1
- `-Dry` 预演：不起 Edge、不下载付费墙文献、不校验；normalize / enrich / OA 直取照跑，dispatch 只打印分派结果，退出码恒为 0。用于开跑前确认「有几篇会被判 unknown、各通道各几篇」
- `-Reuse` 复用上一次的 `_items_enriched.json`，跳过 normalize 与 enrich（不再打 Crossref / OpenAlex）；修完下载问题后重跑只需 `-Reuse -Retry`
- `-Kb <知识库ID>` 校验通过后把 PDF **另外上传**一份到 IMA 知识库（本地文件保留，见「可选：同步到 IMA 知识库」）；等价环境变量 `IMA_KB_ID`；不传就完全跳过
- `-SkipIma` 即使配了 `IMA_KB_ID` 或 `-Kb` 也不上传
- 开跑前先做前置检查：缺 `node`、缺 `python`/PyMuPDF（`pip install pymupdf`）、缺 Edge 可执行文件时，直接报原因并以退出码 2 终止，不会跑到一半才炸
- 写非白名单盘需 `dangerouslyDisableSandbox: true`

阶段依次为 `[1/7]` Edge、`[2/7]` normalize、`[3/7]` enrich、`[4/7]` oa_route、`[5/7]` dispatch、`[6/7]` verify、`[7/7]` 可选的 IMA 同步。

等价的手工四步（调试单个环节时用）：

```powershell
node scripts/normalize.mjs <输入> <输出目录>\_items_norm.json --port 9223
node scripts/enrich_meta.mjs <输出目录>\_items_norm.json <输出目录>\_items_enriched.json
node scripts/oa_route.mjs <输出目录> <输出目录>\_items_enriched.json
node scripts/dispatch.mjs 9223 <输出目录>
python scripts/verify_pdf.py <输出目录> --meta <输出目录>\meta.json
```

## 输入归一化

`scripts/normalize.mjs` 把混着 DOI、doi.org 链接、文章页 URL 的清单统一成 items：

- 直接从字符串里抓 `10.xxxx/...`，因此 `doi.org` 与大部分出版社文章页都能就地解析
- 少数页面 URL 不含 DOI（RSC 新版 `/cs/article/{vol}/{issue}/{page}/{id}/...`、ScienceDirect PII 页），按 URL 形状还原；仍失败时用 `--port` 让浏览器读 `meta[name="citation_doi"]` 反查
- 解析不出的条目会逐条列出并返回码 1，不会静默丢条

## 标准入口：先 OA，再浏览器

拿到 DOI 清单后，**先跑 `scripts/oa_route.mjs`**，不要直接开浏览器：

```powershell
node scripts/oa_route.mjs <输出目录> <items.json> [email]
```

它做三件事：

1. 查 OpenAlex 的 OA 位置（配置了真实邮箱时叠加 Unpaywall），只取 `pdf_url`，Node 直接下载并验 `%PDF-`；命中后同样登记台账，重跑不会重下；
2. 未命中的按候选池里的 `publisher` / `host` 识别出版社，写成 `<输出目录>/_browser_pending.json`；两者都缺失则记为 `unknown`，不猜；
3. Elsevier 会自动从 Crossref 补 `pii`。

并发 4 篇（`CONC=4`），结果按输入顺序回填，`_oa_report.json` / `_browser_pending.json` 的条目顺序与清单一致。

另外读 `<输出目录>/_index.json` 做**跨批次 DOI 去重**：同一 DOI 已在台账里、且文件体积与 sha256 都对得上（哪怕换了文件名）就记 `route: "index"` 直接跳过。台账由抓取脚本与 OA 直取落盘时登记（`verified: null`），`verify_pdf.py` 通过校验后补 `verified` 时间戳，因此跳过校验也不会丢台账。

输出两个文件：

- `_oa_report.json`：每条 `{doi, route, status}`，`route` 为 `oa` / `index` / `pending-browser`，`status` 为 `ok` / `pending-browser` / `skip`
- `_browser_pending.json`：交给 `scripts/dispatch.mjs` 自动分派（见「自动分派」）

实测：Nature Communications（金色 OA）直接取到 2.93 MB / 8 页；ACS、Wiley、Elsevier、AAAS 正确落到 pending。

注意事项：

- **Unpaywall 不接受示例邮箱**（返回 422 "Please use your own email address"）。必须传入真实邮箱，或设环境变量 `UNPAYWALL_EMAIL`；不传时只用 OpenAlex。
- OpenAlex 连续调用会 429，脚本已内置 3 次退避重试；大批量时建议传 `mailto` 并控制并发。
- 只尝试 `pdf_url`。`landing_page_url`（PubMed、文章页）一律跳过，免得把 HTML 当 PDF。

## 检索阶段补全元数据

检索结果通常只有 DOI、标题、期刊，**缺 `publisher` 和真实的 PDF 托管域名**。而 DOI 前缀只标识注册方，不标识托管域名（实测 10.1002 的 Advanced 系列也有落在裸 `onlinelibrary.wiley.com` 的），单靠前缀会路由错。

因此在检索输出与 `oa_route.mjs` 之间插一步：

```powershell
node scripts/enrich_meta.mjs <候选池.json> <候选池_enriched.json> [--meta meta.json]
```

- 从 Crossref 取 `publisher`、`link[].URL` 的 host、Elsevier 的 `pii`，以及 `title` / `journal` / `year` / `firstAuthor`
- `host` 跳过 `api.*` 的 TDM 端点（Wiley 的 `api.wiley.com`、Elsevier 的 `api.elsevier.com` 是给机器取的接口，浏览器打不开），取能落地文章页的那个域名；`publisher` 独立判定，不受影响
- Crossref 缺失时回退 OpenAlex 的 `host_organization_name`（此时 host 为空）
- 保留原字段不变，只新增上述字段；`file` 为空时按 `{年}_{首作者}_{DOI后缀}.pdf` 生成，保证可复现且唯一
- 顺带写 `<输出目录>/meta.json`，为每个文件生成 3 个校验关键词（取标题里最长的实词），直接喂给 `verify_pdf.py --meta`

实测 40 条候选：publisher 与 host 均 40/40 命中；host 分布为 api.elsevier.com 13、pubs.acs.org 8、advanced.onlinelibrary.wiley.com 7、onlinelibrary.wiley.com 4、link.springer.com 3、nature.com 2、mdpi.com 2、rsc.org 1。跳过 `api.*` 之后，那 13 条 Elsevier 的 host 会变成空，出版社判定改由 `publisher` 承担。

`oa_route.mjs` 只用这两个字段判定出版社（缺失记 `unknown`，`dispatch.mjs` 会交给通用兜底试一次），并把 `host` 透传进 `_browser_pending.json`；`wiley_cookie.mjs` 按该字段选域名，加载后还会用 `location.href` 的真实地址取字节，避免裸域名 302 到 `advanced.*` 时拿不到正文。

**不要用 DOI 前缀做兜底**：前缀只标识注册方，`10.1002` 里既有 `advanced.*` 也有裸域名，`10.1007` 还混着清华大学出版社的期刊。实测按前缀路由会把 Advanced 系列的正常文献派错通道。

## 自动分派

`_browser_pending.json` 非空时，用 `scripts/dispatch.mjs` 一次跑完，不必逐类手选脚本：

```powershell
node scripts/dispatch.mjs 9223 <输出目录> [--dry] [--retry-failed]
```

- 按 `kind` 分组：`elsevier`→`sd_pull`、`aaas`→`aaas_pull`、`acs`→`generic_pull`、`wiley`→`wiley_cookie`、`springer`→`springer_pull`、`rsc`→`rsc_pull`、`mdpi`→`mdpi_pull`、`ieee`→`ieee_pull`
- 执行顺序 elsevier → aaas → acs → wiley → springer → rsc → mdpi → ieee，避免 Elsevier 的 assets 页被顶掉
- `--dry` 只打印分派结果，不实际下载，建议先跑一次
- `--retry-failed` 改读 `<输出目录>/_failed.json`，只重跑上次失败的条目（会自动从 `_items_enriched.json` 补回 host / pii）
- `kind` 为 `unknown` 时不再跳过：交给 `generic_pull.mjs` 的**通用兜底**，按三级入口取字节——① 文章页 `meta[name="citation_pdf_url"]`；② 页内 PDF 链接（排除 `downloadTable` / `downloadRef` / `downloadSupplement` 这类非正文链接）；③ 页面数据里的 `.pdf` 路径（SAGE 中国区代理站只发这个，留在文章页直接取，不导航）。三级都取不到才记进 `_failed.json`
- 有通道失败时退出码为 1，失败条目统一落 `_failed.json`（`{doi, kind, script, file, reason, attempts, first, last}`），成功则自动清除该条

## 失败清单与断点续跑

每个抓取脚本 FAIL 时都会调 `lib_fail.mjs` 写 `<输出目录>/_failed.json`，成功则删除对应条目；因此重复跑同一目录不会漏掉、也不会重复累计：

```powershell
node scripts/dispatch.mjs 9223 <输出目录> --retry-failed
```

`attempts` 会累加，`reason` 是最后一次的失败原因。清单为空时删除该文件。

写入走「临时文件 + rename」，中断不会留下半截 JSON；万一文件已损坏，读取时会另存为 `_failed.json.corrupt-<时间戳>.json` 并打印 `WARN`，再按空清单继续，不会静默当成「没有失败」而覆盖掉原有记录。

## 硬约束

- 写非白名单磁盘（如 `K:`）与启动浏览器，需 `dangerouslyDisableSandbox: true`。
- **启动 Edge → 等端口 200 → 跑脚本必须在同一条 Shell 命令里**，否则 Edge 被回收，报 `ECONNREFUSED`。
- Edge 必须独立 `--user-data-dir`，调试端口 9223。
- 单篇间隔：Springer / RSC / MDPI / ACS 为 4 秒，Wiley 建议 ≥10 秒（高频会返回 `CPE00002`）。
- 遇 Cloudflare Turnstile 只打印提示并轮询等待，不自动破解。

启动模板（`run_batch.ps1` 已内置这段，手工调单个脚本时才需要）：

```powershell
$edge="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"; if (!(Test-Path $edge)) { $edge="C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
Start-Process $edge -ArgumentList '--remote-debugging-port=9223','--user-data-dir=<profile>','--no-first-run','--no-default-browser-check','about:blank'
for($i=0;$i -lt 40;$i++){ try { if((Invoke-WebRequest 'http://127.0.0.1:9223/json/version' -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200){ break } } catch {}; Start-Sleep -Milliseconds 500 }
node scripts/<脚本> 9223 <输出目录> <items.json>
```

## 出版社对照

| 出版社 | 授权 | 入口 | 取字节 |
|---|---|---|---|
| AAAS / science.org | 机构 IP，页面显示 `FULL ACCESS` | `a[href*="/doi/pdf/"][href$="download=true"]` | 见下方专用流程，脚本 `scripts/aaas_pull.mjs` |
| Elsevier / ScienceDirect | 机构 IP | `a[href*="/pdfft?"]`，href 自带 md5/pid 令牌 | 导航到该 URL，落到 `pdf.sciencedirectassets.com/...main.pdf`，再页内 fetch。Node 直连签名 URL 会 403 |
| Wiley | CARSI（校方 IdP，如 `cas.your-school.edu.cn`；脚本按 `cas.` / `idp.` / `login` / `identity` / `sso` 通用特征识别登录页） | 文章页需出现所属机构名（由 IP 或 CARSI 决定）；入口 `/doi/pdfdirect/{DOI}` | 见下方专用流程 |
| ACS | 机构 IP | 文章页 `a[href*="/doi/pdf/"]` | 留在**文章页**同源 fetch `/doi/pdf/{DOI}`，**不要导航**到该地址 |
| Springer / Nature | 机构 IP（`link.springer.com` 实测付费墙文献可直接取） | `link.springer.com/article/{DOI}` 或 `www.nature.com/articles/{slug}` | 见下方专用流程，脚本 `scripts/springer_pull.mjs` |
| MDPI | 全 OA | 路径为 `/{issn}/{vol}/{issue}/{article}`，无法由 DOI 拼出 | 见下方专用流程，脚本 `scripts/mdpi_pull.mjs` |
| RSC / pubs.rsc.org | 机构 IP（页面显示所属机构名） | 文章页 `meta[name="citation_pdf_url"]` | 见下方专用流程，脚本 `scripts/rsc_pull.mjs` |
| IEEE / ieeexplore.ieee.org | 机构 IP | `/stampPDF/getPDF.jsp?tp=&arnumber=<n>`（`arnumber` 从 `/document/<n>` 还原，`stamp.jsp` 是 iframe 外壳不可用） | 见下方专用流程，脚本 `scripts/ieee_pull.mjs` |
| 纯 OA / bronze | 无需授权 | OpenAlex `pdf_url`（可选 Unpaywall） | Node 直链，成功率≈100%，由 `oa_route.mjs` 自动处理，优先走 |
| 其他（未点名适配：AIP、IOP、T&F、SAGE、CUP/OUP、PNAS…） | 视出版社而定（本机构是否订阅） | `citation_pdf_url` → 页内 PDF 链接 → 页面数据里的 `.pdf` 路径 | `generic_pull.mjs` 通用兜底：同源 fetch，非 `%PDF-` 即记失败。实测 AIP / IOP / CUP / OUP / T&F / SAGE 六家各 1 篇均取到正文 |

## AAAS 专用流程

实现见 `scripts/aaas_pull.mjs`，已在 Science 正刊实跑通过（6 页 / 1.32 MB / PASS）。

1. 打开 `https://doi.org/{DOI}` 落到文章页，**不要**直接开 PDF 地址（会触发附件下载，CDP 读不到正文）
2. 轮询等待三件事同时成立：Cloudflare 放行、页面出现 `FULL ACCESS`、存在 `a[href*="/doi/pdf/"][href$="download=true"]`
3. 在该文章页内 `fetch(pdfPath,{credentials:'include'})` 取 blob，按 2 MB 分块 base64 回传

要点：

- 授权判据是页面文本里的 `FULL ACCESS`（或 `Access through your institution`），不是 PDF 链接本身；没有这个标识直接报"无全文访问权限"，不要反复重试。
- Cloudflare 首访会停在"请稍候…"，一般 10–20 秒自行放行，脚本每 2 秒轮询一次。
- 同源 fetch 无需签名令牌，也不受 `?download=true` 影响。

## Springer / Nature 专用流程

实现见 `scripts/springer_pull.mjs`，已在 `link.springer.com` 的付费墙文献（J. Mater. Sci.，6.7 MB / 15 页）与 gold OA 文献（Nano-Micro Letters，11.2 MB / 20 页）实跑通过。

1. 打开文章页，**不要**开 PDF 地址：
   - `link.springer.com/article/{DOI}`
   - `www.nature.com/articles/{slug}`（`slug` 取 DOI 斜杠后部分）
2. 优先取页面上的 `a[href*="/content/pdf/"]` 或 `a[href$=".pdf"]`；取不到时用默认路径 `/content/pdf/{DOI}.pdf`、`/articles/{slug}.pdf`
3. 在文章页内同源 `fetch(pdfPath,{credentials:'include'})` 取 blob，2 MB 分块回传

要点：

- 授权靠机构 IP，`link.springer.com` 在本机构网络内可直接取付费墙文献，不需要 CARSI。
- 页面若出现 `Buy article` / `Access this article` 且无 `Access through your institution`，脚本立即报"无全文访问权限"，不空等。
- 遇 `idp.` / `sso` / `login` 跳转即报错提示人工登录。
- 返回 HTML 而非 `%PDF-`（多为付费墙页）视为失败，最多重试 6 次。

## MDPI 专用流程

实现见 `scripts/mdpi_pull.mjs`，实测 2 篇全部 PASS（Energies 14 页 / 3.85 MB、J 17 页 / 5.89 MB），重复运行字节稳定。

MDPI 全 OA，但**不能 Node 直连**：`https://www.mdpi.com/{文章路径}/pdf` 在 Node 侧返回 200 + `text/html` 约 2.2 KB 的 Cloudflare 挑战页，不是 PDF。

1. 让浏览器打开 `https://doi.org/{DOI}`，由 doi.org 解析出真实文章页；**不要**自己拼路径
2. 轮询到 `location.hostname === 'www.mdpi.com'` 且 pathname 形如 `/{issn}/{vol}/{issue}/{article}`
3. 取 PDF 地址：优先页面上的 `a[href*="mdpi-res.com"]`（CDN 直链），取不到用同源 `{path}/pdf`
4. 在该文章页内同源 fetch，2 MB 分块回传

要点：

- **路径拼不出来**：MDPI 用 ISSN + 卷 / 期 / 文章号，DOI 后缀（如 `en15228340`）无法唯一还原 `1996-1073/15/22/8340`。要靠 doi.org 解析或 Crossref 的 `resource.primary.URL`。
- 页脚 `a[href$=".pdf"]` **不可信**，常指向期刊宣传单；只认 `mdpi-res.com` 与本文章路径下的 `/pdf`。
- Cloudflare 首访会有 5–20 秒校验页，脚本每 2 秒轮询，最多 25 次。
- 取回非 `%PDF-` 视为失败，最多重试 6 次（多为挑战页未被放行）。

## RSC 专用流程

实现见 `scripts/rsc_pull.mjs`，实测 4 篇 PASS：Mater. Adv. 4.6 MB / 10 页、J. Mater. Chem. A 两篇 1.2 MB（11 页、10 页）、RSC Adv. 0.8 MB / 12 页。

RSC 是最挑取字节方式的一家，两条常见路线都不可行：

- Node 直连 `pubs.rsc.org/.../article-pdf/...` → 403，返回 5938 B HTML 拦截页
- 文章页内 `fetch(pdfUrl)` → `TypeError: Failed to fetch`（RSC 对 XHR 取 PDF 直接断连，不是 CORS）

唯一可行路径：**浏览器顶层导航**。RSC 会把 PDF 地址 302 到 `rscj.silverchair-cdn.com` 的 CloudFront 签名直链，这个直链在 Node 侧可直接下载（实测带不带 cookie 都能取到）。

1. 浏览器打开 `https://doi.org/{DOI}`，等落到 `pubs.rsc.org`
2. 取 `meta[name="citation_pdf_url"]` 的 content（PDF 路径含文章内部 id，**拼不出来**）
3. `Page.navigate` 到该 PDF 地址，轮询到 `document.contentType === 'application/pdf'` 或 URL 变成 `silverchair-cdn.com`
4. 读回 `location.href`（此时是签名直链），Node 直接 GET，验 `%PDF-` 落盘

要点：

- **签名直链有时效**，必须在导航后立刻使用，不能存下来隔天复用。
- 判据是「URL 被退回 `/article-abstract?...redirectedFrom=PDF`」即无全文权限，直接报错，不要重试。实测 *Sustainable Energy & Fuels* 2021 的一篇被退回，而 *J. Mater. Chem. A* 同一次跑通，说明是期刊级订阅差异，不是脚本问题。
- 页面文本出现所属机构名说明机构 IP 已被识别，可以作为授权已生效的旁证。

## IEEE 专用流程

实现见 `scripts/ieee_pull.mjs`，实测 IEEE Access 一篇 PASS（7.4 MB / 11 页，arnumber=11271199）。

- DOI 只落地到 `ieeexplore.ieee.org/document/{arnumber}`，PDF 地址**拼不出来**；先取 `arnumber`（页面路径 `/document/<n>`，或 `citation_pdf_url` 里的 `arnumber=`）
- 文章页的 `citation_pdf_url` 常指向 `stamp.jsp`，那是 iframe 外壳，取回是 HTML；正文在 `/stampPDF/getPDF.jsp?tp=&arnumber=<n>&ref=`
- 在文章页内同源 fetch 该地址，最多重试 6 次；`stamp.jsp` 只在 `/stampPDF/` 连续失败时作为备选
- 机构未订阅时该地址返回 HTML 或跳登录页，按「取回非 PDF」记失败，脚本不尝试任何登录流程

## Wiley 专用流程（顺序不可调换）

页内 fetch 不可行：`onlinelibrary.wiley.com` 会 302 到 `advanced.onlinelibrary.wiley.com`，跨域被 CORS 拦。直接导航只得到插件渲染的 PDF，CDP 读不到正文。

正确顺序：

1. 导航到 `https://advanced.onlinelibrary.wiley.com/doi/pdfdirect/{DOI}`
2. 轮询到 `document.contentType === 'application/pdf'`（说明授权会话已建立）
3. `Storage.getCookies` 导出全部 `.wiley.com` cookie
4. Node 侧带同一 `User-Agent` 与 `Referer` 复用这套 cookie 请求同一 URL
5. 校验并落盘

**在 PDF 加载之前导出 cookie 一定失败**（403 `Just a moment...`），这是最容易踩的坑。

域名选择：只认 `advanced.onlinelibrary.wiley.com` 与 `onlinelibrary.wiley.com`。检索阶段补的 `host` 若是 `api.wiley.com`（Crossref 的 TDM 端点）或为空，脚本按 `advanced.*` → 裸域名各试一次，先加载出 PDF 的那个就用。全新 Edge profile 首访常被 Cloudflare 拦 30–60 秒，页面标题仍是「正在进行安全验证」时不要当成无权限，脚本会继续轮询；同一 profile 过了一次之后会留下 clearance，后续批次直接放行。

实现见 `scripts/wiley_cookie.mjs`。

## ACS 专用要点

`generic_pull.mjs` 默认流程是"找入口 → 导航到 PDF → 页内 fetch"，这对 ACS 不成立：

- ACS 的 `/doi/pdf/{DOI}` 不在脚本的 `isPdfPage` 判定内（该判定只认 `sciencedirectassets.com`、`.pdf` 结尾、`/epdf/`），导航后会卡在等待。
- 导航到 PDF 地址还会让浏览器用插件渲染，CDP 读不到文档正文。

正确做法：**始终留在 `pubs.acs.org` 文章页**，直接 `fetch('/doi/pdf/{DOI}', {credentials:'include'})` 取 blob。同源，带机构 IP 授权，无需令牌。

`generic_pull.mjs` 已内置该分支：items 里 `kind: "acs"`，或落地 host 为 `pubs.acs.org` 时自动走，重试 6 次（每次间隔 4 秒）以避开 Cloudflare 首访等待。

```json
[{ "doi": "10.1021/acsnano.5cxxxxx", "kind": "acs", "file": "xxx.pdf" }]
```

## 校验（三重，缺一不可）

- `%PDF-` 文件头
- 页数 ≥3，且与文献篇幅相符
- 首页文本命中标题、刊名或 DOI 关键词
- SHA256 去重

只验文件头会把 MDPI 宣传单当正文。校验代码见 `scripts/verify_pdf.py`。

单文件：

```powershell
python scripts/verify_pdf.py <文件> <关键词1> <关键词2>
```

批量（整目录）：

```powershell
python scripts/verify_pdf.py <目录> [--meta meta.json]
```

`meta.json` 形如 `{ "文件名.pdf": { "doi": "...", "keywords": ["a","b"] } }`，`enrich_meta.mjs` 会自动生成，一般不用手写。批量模式逐篇出表、检测 SHA256 重复与重复 DOI、写 `_verify_report.json`，任一 FAIL 退出码为 1。不给关键词时只验文件头与页数；扫描版 PDF（无文本层）会单独标注，不会误判为内容不符。

批量校验还会维护 `<目录>/_index.json`（DOI → 文件 / SHA256 / 页数 / `downloaded` / `verified`），`oa_route.mjs` 用它做跨批次去重；已失效（文件被删）的条目会在下次校验时自动剔除。写入是「临时文件 + rename」的原子替换，中断不会留下半截 JSON。

## 可选：同步到 IMA 知识库（默认关闭）

默认纯本地：不传 `-Kb` 就不联网、不上传，行为与以前完全一致。需要把已校验的 PDF 另存一份到 IMA 知识库时，在 `run_batch.ps1` 上带一个知识库 ID：

```powershell
.\scripts\run_batch.ps1 -Out <输出目录> -Items <清单> -Kb <IMA知识库ID>          # 或先设 $env:IMA_KB_ID
node scripts\upload_ima.mjs <输出目录> --kb <知识库ID> --dry                    # 只看清单，不联网
node scripts\upload_ima.mjs <输出目录> --kb <知识库ID> [--folder <文件夹ID>] [--limit N]
```

- 只上传「台账命中 + `verified` 非空」的条目；未校验、sha256 变了、文件缺失的一律跳过并打印原因
- 上传是**复制**：本地 PDF 永远保留（台账、重跑与去重都依赖它），不要指望用它「省本地空间」
- 依赖本机已装的 `ima-skill`（从 `~/.trae-cn/skills/ima-skill` 或 `~/.workbuddy/skills/ima-skill` 读取其 `ima_api.cjs` / `preflight-check.cjs` / `cos-upload.cjs`），凭证放在 `~/.config/ima/client_id` + `api_key`（或用 `IMA_OPENAPI_CLIENTID` / `IMA_OPENAPI_APIKEY`）
- 缺知识库 ID、缺 ima-skill、缺凭证都只打印一行原因后跳过，**不改变下载结果的退出码**；真实上传失败也仅 WARN
- 本地台账 `_ima_uploaded.json` 记录 `doi → {kb, file, sha256, media_id}`，同一 kb + 同一 sha256 不会重复上传；知识库里已有同名文件时按「重复」跳过，不制造 `_副本`
- PDF 会上传到腾讯云 COS 后再进知识库；对上传有合规限制的机构请先确认存储策略

## 已存在文件（SKIP 判据）

`validPdf()` 只是前置过滤：体积 ≥100 KB **且** 前 5 字节为 `%PDF-`，它只说明「这里有个像样的 PDF」，**不代表这篇已经下完了**。

真正的完成判据是 `scripts/lib_index.mjs` 的台账命中：同一 DOI + 文件存在 + 体积一致 + **sha256 一致**。因此：

- 台账命中 → `SKIP`，日志区分「已校验」与「未校验」
- 文件存在但台账无记录 → 先改名为 `<原名>.unverified.pdf` 留档，再重新下载（不静默覆盖）
- 体积或 sha256 与台账不符（文件被替换/截断）→ 视为未完成，重新下载
- 台账里该 DOI 记录的仍是别的文件名 → 照样命中，说明这篇已在库里

## 输入格式

```json
[{ "doi": "10.1002/adma.2025xxxxx", "file": "2025_AdvMat_xxx.pdf" }]
```

`file` 可以省略，`enrich_meta.mjs` 会补一个 `{年}_{首作者}_{DOI后缀}.pdf`。`oa_route.mjs` 只按 `publisher` / `host` 判定 `kind`，缺失记 `unknown`；手工写 items 时请带上这两项，或先跑一遍 `enrich_meta.mjs`。Elsevier 的 `pii` 会自动从 Crossref 补。

所有脚本统一用 `lib_pdf.mjs` 的 `readJson()` 读取输入，会剥离 UTF-8 BOM——PowerShell 5 的 `Set-Content` 默认带 BOM，直接 `JSON.parse` 会报 `Unexpected token '﻿'`。

抓取脚本共享两个库：`lib_cdp.mjs`（连 Edge、开关标签页、页内分块取字节、Node 直下）与 `lib_fail.mjs`（失败清单）。新增出版社时只需写「取字节」那段，不必再复制 CDP 样板。

## 已知局限

- **仍建议先在检索阶段补 `publisher` / `host`**（`enrich_meta.mjs`）。缺这两项会落 `unknown`，此时才走通用兜底；点名通道（pii、cookie 复用）比兜底更稳。已移除 DOI 前缀兜底，因为它无法区分同一前缀下的不同托管域名。
- 10.1007 取 `publisher` 后可区分 Springer 与清华大学出版社（Nano-Micro Letters）。后者不归 Springer 托管，会落 `springer` 通道并被判为无全文访问权限，需人工指定入口。
- RSC 的订阅是**按刊**的：本机构对 *J. Mater. Chem. A*、*Mater. Adv.*、*RSC Adv.* 有权限，但 *Sustainable Energy & Fuels* 实测被退回文章页。同一批清单里出现 RSC 的 FAIL 时，先怀疑该刊未订阅，再查脚本。
- MDPI 虽是全 OA，`oa_route` 偶尔能直取（OpenAlex 的 `pdf_url` 指向 `mdpi-res.com` CDN 时），多数情况指向 `www.mdpi.com/.../pdf` 会被 Cloudflare 拦而落到 pending。因此 MDPI 走浏览器通道属正常，不必当成路由失败。
- ACS 的 PDF **不是字节稳定的**：同一篇文章两次下载长度相同（12,514,031 字节）但 SHA256 不同。因此去重以 `_index.json` 的 DOI 为准，SHA256 只用来发现同目录内的内容重复。
- 仍无专用通道的出版社：AIP、IOP、Taylor & Francis、SAGE、Cambridge / Oxford、PNAS。这些会落 `unknown` 走通用兜底（实测六家各 1 篇均通过）；兜底仍失败时先补 `publisher` / `host` 再 `-Retry`，不要按 DOI 前缀手工指定通道。
- 附属材料（SI）尚未覆盖：RSC 的 `article-supplement`、Wiley / Elsevier 的 supplementary 链接都还没接。
