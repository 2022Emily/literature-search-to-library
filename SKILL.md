---
name: literature-search-to-library
description: 学术文献从关键词检索到 PDF 入库的完整流程：OpenAlex 检索与排序、元数据补全、分析报告（含人工检查点）、按出版社通道下载 PDF 并三重校验；也支持只给 DOI 直接入库。Use when the user asks to search a topic by keywords and build a local PDF library, or to download full-text PDFs (Elsevier, AAAS, ACS, Wiley, Springer/Nature, RSC, MDPI) from DOIs.
metadata:
  version: "2.0.0"
  status: active
---

# 文献检索 → 全文入库

一个技能，两条路径。**先判断意图，再按需读分册**——没读对应分册之前，不要开始跑命令。

| 用户的说法 | 走哪条路 | 必读 |
|---|---|---|
| 「下载这几篇」「给我全文」+ DOI / 文章页 URL | 下载 | `references/download.md` |
| 「帮我查 X 方向」「找两年的文献」 | 检索 → 报告 → 选片 → 下载 | 先 `references/search.md`，下载段再读 `download.md` |

判断依据是**有没有关键词**，不是有没有 DOI。用户只给 DOI 时不要出分析报告，也不要弹检查点。

## 脚本定位

所有脚本都在 `<技能目录>\scripts\`，下文统一记作 `$S`。执行前先确定绝对路径：

```
Glob: **/scripts/search_multi.mjs   →  $S 取其所在目录
```

不要假设当前工作目录就是技能目录或仓库根。技能装在用户级目录（`%USERPROFILE%\.trae-cn\skills\` 或 `%USERPROFILE%\.workbuddy\skills\`）时同样按这条规则定位。

## 路径一：下载（DOI → PDF）

1. 先预演：`& "$S\run_batch.ps1" -Out <目录> -Items <清单> -Email <真实邮箱> -Dry`
2. 正式跑：去掉 `-Dry`。它自己启动 Edge、轮询端口，依次走 normalize → enrich → oa_route → dispatch → verify
3. 回报：新增几篇、失败几篇、每篇页数/大小、`_failed.json` 里各条的失败原因
4. 失败重跑：`-Retry`（只重跑失败条目），必要时再加 `-Reuse`

通道选择、参数含义、各出版社入口与常见失败对照，全部在 `references/download.md`。

## 路径二：检索（关键词 → 报告 → 选片 → 下载）

1. `node "$S\search_multi.mjs"` 出候选池与 `_search_report.json`
2. `node "$S\enrich_meta.mjs"` 补 `publisher` / `host` / `pii` / 摘要 / 印刷期
3. `node "$S\analyze_pool.mjs"` 出 `_analysis_draft.md`，**由你把 draft 补成 `_analysis.md`**
4. `python "$S\md2docx.py"` 导出同名 `_analysis.docx`（缺 `python-docx` 只提示、不阻塞）
5. **检查点**：出简报，同时给 Word 与 Markdown 两个链接，问「下载哪些 / 存到哪里」
6. 按用户选择跑 `run_batch.ps1`，再校验、写 `文献清单.md`

报告骨架、卡片格式、检查点三态兜底、简报模板，全部在 `references/search.md`。

## 不可省略的硬规则

- **检查点不可跳过**：`_analysis.md` 未生成，不许问「下哪些」；用户没确认范围与路径，不许建目录、不许预演、不许下载
- `AskUserQuestion` 只弹一次；被跳过或关闭不重弹，转文字待命
- 简报不能是信息唯一载体：检查点之后仍要给出可复制的编号与默认方案
- 「零被引·高影响刊」一节不能删：同年新刊场景下主排序键必然把高影响新文献压到末尾
- `IF≈` 不得写成「影响因子」，口径是 OpenAlex 近两年篇均被引
- 报告正文不得出现「速读卡 / 噪声 / 池子 / 候选池分析 / 子体系全景」
- 报告同时交 Word 与 Markdown 两份，简报里两个链接都要给
- 每条评述必须写局限；结尾必须回答「若只选 5 篇」
- 下载硬约束：**启动 Edge → 等端口 → 跑脚本必须在同一条 Shell 命令里**；Wiley 单篇间隔 ≥10 秒，Elsevier / AAAS / ACS / Springer / RSC / MDPI ≥4 秒
- 遇 Cloudflare / 验证码只提示并轮询等待，不自动破解；只处理有机构授权的文献
- 缺 `node` / Python / PyMuPDF / Edge 时先报原因并终止，不要空跑

## 环境

Node ≥ 22（全局 `fetch` 与 `WebSocket`）、Python 3.9+ 与 PyMuPDF、Microsoft Edge、机构网络（校园网 / VPN / CARSI）。导出 Word 另需 `python-docx`（`pip install python-docx`，缺失时只跳过 docx）。写非白名单磁盘与启动浏览器需要 `dangerouslyDisableSandbox`。
