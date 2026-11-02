# Phase 3 · 锻造层与 revisions（v0.4.0）

> 上级索引：`../../memory/appendices/A04-功能范围与优先级.md`
> 目标：让书架里的 TXT 从"只读"变成"可锻造"——逐段改写、翻译、注释，写回源文件，并用 revisions 支持回滚与差异查看。
> **状态：已完成（2026-10-28，v0.4.0）** ｜ 工作日志：`../documents/worklog/W05-Phase3-锻造层与revisions-20261028.md`

## 1. 验收项（缺一不可）

| # | 验收 | 判定方式 |
|---|---|---|
| 1 | 锻造台入口 | 阅读页工具栏「锻造」按钮；书架 TXT 可用，EPUB / 磁盘临时文件禁用并给出中文原因 |
| 2 | 段落级改写 | 选中某章某段，输入新文字，保存后正文显示新文字（重开书仍是新文字） |
| 3 | 翻译 | 为段落录入译文；锻造台内原文/译文并列可查；不改动 TXT 正文 |
| 4 | 注释 | 为段落录入注释；锻造台内可查看、修改、清除 |
| 5 | 写回源文件 | 保存后书库副本 `source.txt` 更新为 UTF-8，正文段落被替换，章节标题/空行/其他行保持原样 |
| 6 | revisions 版本 | 每次保存生成一条版本记录（时间、说明、字节数），可在列表中查看 |
| 7 | 回滚 | 选中历史版本回滚，正文与译文/注释一起恢复；回滚前自动存档一条版本 |
| 8 | diff | 任一版本可查看与当前文本的行级差异，新增/删除着色并给出 `+N −M` 统计 |
| 9 | 连续锻造 | 回滚后继续改写、再保存，版本链继续递增，全程可 diff |
| 10 | 全中文 | 按钮、tooltip、错误提示无英文 |
| 11 | 产物可交付 | `build/Scrollforge.exe` 双击启动并完成 1~9 |

## 2. 本期范围

### 2.1 锻造台（阅读页右侧抽屉）

- 章节下拉框（默认定位到当前阅读章节）→ 段落列表 → 选中段落的编辑卡片。
- 段落列表每项显示序号、正文摘要；已有改写的标「改」，有译文标「译」，有注释标「注」。
- 编辑卡片三段：
  - **改写**：替换段落正文，单段约束（换行合并为一行），可「还原原文」。
  - **翻译**：手工录入译文（离线，无机器翻译引擎），仅存于覆盖层，不写进 TXT。
  - **注释**：为该段写批注，仅存于覆盖层。
- 底部「保存到源文件」显示待保存改动数；「放弃改动」丢弃未保存内容。

### 2.2 写回源文件

- 只对书架 TXT 生效；书源是 `<应用数据>/books/<id>/source.txt`。
- 段落 → 源文件行范围：`analyzeTxt()` 在识别章节时同步记录每段的起止行号；写回时**只替换这些行**，章节标题、分隔线、空行、前言等全部原样保留。
- 多个改写按行号倒序替换，避免行号漂移。
- 写回后文件统一为 UTF-8（无 BOM）、`\n` 换行；原字节（可能是 GB18030）完整存入 revision，可回滚。
- 保存后阅读页重新读取该书，正文立即反映改动。

### 2.3 revisions

- 目录：`<应用数据>/books/<id>/revisions/`
  - `<版本号>.source`：保存**前**的 `source.txt` 原始字节
  - `<版本号>.forge.json`：保存前的覆盖层（译文/注释/改写记录）
  - `<版本号>.json`：元信息 `{ id, createdAt, label, sourceBytes, note }`
- 版本号用毫秒时间戳，冲突时追加序号。
- 最多保留最近 30 个版本，超出按时间删除最旧的三个文件。
- 回滚：先把当前 `source.txt` 与覆盖层存为一个「回滚前自动存档」版本，再把目标版本写回；因此回滚本身也可撤销。

### 2.4 覆盖层

- `forge.json` 与 `source.txt` 同目录，结构 `{ version: 1, edits: { "<章序号>:<段序号>": { rewrite?, translate?, note? } } }`。
- 改写同时进入 TXT 正文与覆盖层；译文/注释只在覆盖层。
- 每次保存随版本一起快照，回滚时一起恢复。

### 2.5 diff

- 选中版本后，取该版本 `.source` 原始字节 → 解码 → 与当前 `source.txt` 逐行比较（方向：**此版本 → 当前**）。
- 行级 Myers diff，带 3 行上下文分组；`+N −M` 统计；大文本走前后缀裁剪 + 差异上限降级，避免卡死。

## 3. 明确不做

- 不做 EPUB 与磁盘临时文件的锻造（只支持书架 TXT）。
- 不接机器翻译 / 大模型：离线环境，无外部服务；译文由用户手工录入。
- 不做段落拆分/合并、整章重写、多段批量替换；改写严格保持"一段换一段"。
- 译文不排进正文，不做双语对照排版。
- 不做版本导出、版本合并、跨设备同步。
- 不改动章节标题与目录结构。

## 4. 技术要点

- `TxtChapter` 增加可选 `paragraphRanges: { start, end }[]`，与 `paragraphs` 一一对应；行号为 `raw.replace(/\r\n?/g,'\n').split('\n')` 的绝对下标，含 Gutenberg 头尾裁剪偏移。
- 熔接逻辑与行范围共用同一套循环，避免"看到的段落"与"写回的行"对不上。
- 写回前校验：段落范围数量与段落数一致、起止行递增、改写文本非空；任一不符则拒绝保存并给中文错误，不写坏源文件。
- 覆盖层键用「章序号:段序号」；改写保持单段，段落总数不变，键在保存/回滚后仍稳定。
- 二进制不经过前端：版本读取用 `tauri::ipc::Response` 返回字节，前端 `decodeText()` 统一嗅探编码。
- 版本元信息用 `serde_json`，文件名只允许 `[0-9A-Za-z_-]`，`valid_id` 复用书 id 校验。
- 阅读页刷新：保存/回滚后递增 `reloadToken`，重跑打开流程（源文件已变，重新解码、识别、建书）。
- diff 只渲染差异分组（上下文 3 行），避免整本 2 万行进 DOM。

## 5. 验收证据（`_testdata/shots/`）

| 验收 | 证据 |
|---|---|
| 锻造台入口 | `phase3-forge-open.png` |
| 段落列表与编辑卡片 | `phase3-forge-paragraph.png` |
| 改写 + 译文 + 注释 | `phase3-forge-edit.png` |
| 保存到源文件 | `phase3-forge-commit.png` |
| 正文已变化 | `phase3-forge-reader-updated.png` |
| 版本列表 | `phase3-forge-revisions.png` |
| 差异查看 | `phase3-forge-diff.png` |
| 回滚 | `phase3-forge-rollback.png` |
| 回滚后正文 | `phase3-forge-reader-rolledback.png` |
| 磁盘侧证 | `source.txt` 改动前后行内容、`revisions/` 目录文件清单 |
| 交付 exe | `phase3-final-exe.png`（v0.4.0，无远程调试端口） |

## 6. 后台自动化纪律

所有点击/截图在后台完成：WMI `Invoke-CimMethod Win32_Process Create` 启动进程脱离 shell 任务树；交互通过临时 `additionalBrowserArgs: "--remote-debugging-port=9333"` + CDP over WebSocket（`Runtime.evaluate` / `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Page.captureScreenshot`）；交付前删掉该字段并重构建，最终抓图用 `PrintWindow`。不使用 `SetForegroundWindow`、`SendInput`、真实鼠标移动，不占用用户显示器、鼠标与键盘（A07 §2、§7）。

## 7. 验收结果（2026-10-28 实测）

| # | 验收 | 结果 | 证据 |
|---|---|---|---|
| 1 | 锻造台入口 | 通过：书架 TXT 可开，EPUB/磁盘文件禁用 | `phase3-forge-open.png` |
| 2 | 段落级改写 | 通过：第一章第 1 段改写后阅读页显示新句 | `phase3-forge-edit.png`、`phase3-forge-reader-updated.png` |
| 3 | 翻译 | 通过：译文仅入 `forge.json`（361 字节），TXT 无英文 | `phase3-forge-edit.png` |
| 4 | 注释 | 通过：注释仅入 `forge.json` | `phase3-forge-edit.png` |
| 5 | 写回源文件 | 通过：`source.txt` 对应行替换，标题/空行/其余章节原样；UTF-8 无 BOM | 保存前后磁盘对照 |
| 6 | revisions | 通过：首次保存生成 1 条（623 字节原文件） | `phase3-forge-commit.png`、`phase3-forge-revisions.png` |
| 7 | 回滚 | 通过：回滚后 `source.txt` 与原 fixture 哈希一致，覆盖层清空，版本增至 2 条 | `phase3-forge-rollback.png`、`phase3-forge-reader-rolledback.png` |
| 8 | diff | 通过：`新增 1 行 · 删除 1 行`，仅目标行一删一增 | `phase3-forge-diff.png` |
| 9 | 连续锻造 | 通过：回滚后再存第 2 段，版本 3 条，最新 diff 仍 1 增 1 删 | `phase3-forge-resave.png`、`phase3-forge-resave-diff.png` |
| 10 | 全中文 | 通过 | 全部截图 |
| 11 | 产物可交付 | 通过：v0.4.0，3,495,424 字节，9333 端口关闭 | `phase3-final-exe.png` |

### 7.1 偏差与说明

- diff 统计为行级：改写段落产生的换行差异会按实际行数计，不按"段"计。
- 改写段落在源文件中不再保留原首行缩进（全角空格），显示端由 CSS 首行缩进补齐；如需保留原文缩进，后续可把缩进并入改写模板。
- 版本上限 30 条（含"回滚前自动存档"），本轮测试只产生 3 条。
