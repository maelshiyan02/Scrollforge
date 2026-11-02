# W05 · Phase 3 锻造层与 revisions（2026-10-28）

> 索引：`../../memory/appendices/W00-工作日志索引.md`
> 规格：`../../specs/03-Phase3-锻造层与revisions.md`
> 版本：**v0.4.0**｜产物 `build/Scrollforge.exe`（3,495,424 字节）

## 1. 本轮目标

让书架里的 TXT 从"只读"变成"可锻造"：逐段改写、翻译、注释，改写写回 `source.txt`，每次保存前自动存档为 revision，可按版本回滚并查看行级差异。验收动作是**改一段 → 保存 → 回滚 → 再保存**，版本链递增且全程可 diff。

## 2. 实际改动

### 2.1 解析层：段落与源文件行号对齐（`src/lib/txt-chapters.ts`）

- 新增 `TxtParagraphRange { start, end }`，`TxtChapter` 增加可选 `paragraphRanges`，与 `paragraphs` 一一对应。
- 熔接循环改为 `reflowRanges(rawLines, base)`，在生成段落的同时记录其起止绝对行号；`reflowParagraphs()` 保留为只取文本的薄封装。
- `stripGutenberg()` 改为返回 `{ lines, offset }`，所有行号叠加裁剪偏移；分块兜底 `chunkLines(lines, base)` 同步记录块起点。
- 前言、章节正文、拆行回目后的正文起点都走同一套范围记录，保证"看到的段落"与"写回的行"一致。

### 2.2 Rust：revisions 与写回（`src-tauri/src/main.rs`）

| 命令 | 职责 |
|---|---|
| `read_forge_state(id)` | 读 `<书目>/forge.json`，不存在返回空串 |
| `commit_forge(id, text, forge, label, note)` | 先快照当前 `source.txt` + `forge.json` 到 `revisions/<版本>/`，再写入新正文与覆盖层，写元信息，裁剪到 30 条 |
| `list_revisions(id)` | 读 `revisions/*.json`，按 `createdAt` 倒序 |
| `read_revision(id, rev)` | 用 `tauri::ipc::Response` 返回版本原始字节（可能是 GB18030），前端嗅探编码 |
| `restore_revision(id, rev)` | 先把当前状态自动存档（"回滚前自动存档"），再恢复目标版本的 `.source` 与 `.forge.json` |

版本号用毫秒时间戳，目录冲突时追加 `-1`、`-2`；文件名经 `valid_id` 校验；单条版本三件套：`<id>.json` / `<id>.source` / `<id>.forge.json`。

### 2.3 前端：锻造台（`src/components/ForgePanel.tsx` + `src/lib/forge.ts`）

- **锻造台**：阅读页工具栏「锻造」打开右侧抽屉；章节下拉默认定位当前阅读章节（`locatedRef` 只定位一次，保存刷新后不重置）。
- **段落列表**：序号 + 两行摘要；已有改写/译文/注释分别标「改」「译」「注」。
- **编辑卡片**：原文引用块 + 改写 / 译文 / 注释三个输入框；改写可「还原原文」。
- **保存**：`applyRewrites()` 按行范围倒序替换，只动正文行，标题、空行、前言不动；范围缺失或重叠的段落跳过并统计，不写出错位正文；保存后触发 `reloadToken` 让 Reader 重新解码建书。
- **版本区**：时间、说明、快照字节数；「差异」按钮取该版本 `.source` 与当前 `source.txt` 比对；「回滚」有确认条，回滚前自动存档。
- **diff**：行级 Myers（编辑距离上限 1500），前后缀裁剪，3 行上下文分组，新增/删除着色 + `新增 N 行 · 删除 M 行`，超限降级为整块删/增。
- **只读边界**：EPUB、磁盘临时文件没有书库源文件，「锻造」按钮禁用并给中文原因。

## 3. 验收结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 锻造台入口 | 通过：书架 TXT 可开；EPUB/磁盘文件禁用（中文 tooltip） | `phase3-forge-open.png` |
| 2 | 段落级改写 | 通过：第一章第 1 段改为「雾散了，屏幕亮起来……」，保存后阅读页显示新文字 | `phase3-forge-edit.png`、`phase3-forge-reader-updated.png` |
| 3 | 翻译 | 通过：译文「The fog lifted and the screen lit up…」入覆盖层，TXT 不含英文 | `forge.json` 内容、`phase3-forge-edit.png` |
| 4 | 注释 | 通过：注释「开篇从"雾气"转到"屏幕"……」入覆盖层 | `forge.json` 内容 |
| 5 | 写回源文件 | 通过：`source.txt` 第 5–6 行合并替换为新句，第一章标题、空行、后两章原样；文件为 UTF-8 无 BOM | 保存前后 `source.txt` 对照 |
| 6 | revisions | 通过：首次保存生成 1 条版本（623 字节，原文件） | `phase3-forge-commit.png`、`phase3-forge-revisions.png` |
| 7 | 回滚 | 通过：回滚后 `source.txt` 与原始 fixture **哈希一致**，覆盖层清空，版本列表增至 2 条（含「回滚前自动存档」517 字节） | `phase3-forge-rollback.png`、`phase3-forge-reader-rolledback.png` |
| 8 | diff | 通过：新版 → 当前显示 `新增 1 行 · 删除 1 行`，仅第 8 行一删一增 | `phase3-forge-diff.png` |
| 9 | 连续锻造 | 通过：回滚后再改第 2 段并保存，版本增至 3 条（`改写 1 段` / `回滚前自动存档` / `改写 1 段`），最新版本 diff 仍为 1 增 1 删 | `phase3-forge-resave.png`、`phase3-forge-resave-diff.png` |
| 10 | 全中文 | 通过 | 截图与文案逐项检查 |
| 11 | 产物可交付 | 通过：`build/Scrollforge.exe` v0.4.0 双击启动；重建后 9333 端口关闭 | `phase3-final-exe.png` |

实测链路记录：

1. 打开《锻造试验稿》（3 章）→ 锻造台默认落到「第一章 旧稿」。
2. 第 1 段写改写 + 译文 + 注释 → 待保存 1 段 → 保存 → 提示「已写回源文件，改写 1 段；版本 2026-10-28 13:26:21 可回滚」→ 阅读页正文变为新句。
3. 版本区点「差异」：`新增 1 行 · 删除 1 行`，第 8 行原文红、新句绿。
4. 点「回滚」→ 确认 → 正文恢复原句，`source.txt` 哈希回到原始文件，版本变 2 条。
5. 回滚后改第 2 段 → 保存 → 版本变 3 条，最新 diff 仍是 1 增 1 删。
6. 关闭 app、删除临时调试参数、重建并复制到 `build/`；WMI 启动 + `PrintWindow` 抓图，实测 `Test-NetConnection 9333 = False`。

## 4. 关键问题与修正

1. **手写测试书库 meta.json 字段名错**：`BookMeta` 走 `serde(rename_all = "camelCase")`，写成 `byte_len` / `imported_at` 会导致 `list_books` 反序列化失败 → 书架空白。改用 `byteLen` / `importedAt` 后正常（另见 A07 第 44 条）。
2. **保存提示被"已回到上次位置"盖掉**：`Reader` 重载结束统一提示位置恢复，正好压住"已保存"。改为只有首次加载（`reloadToken === 0`）才提示位置。
3. **保存后锻造台章节跳回第一章**：面板拿到新的 analysis 时又执行了一次"定位当前章节"。加 `locatedRef`，只定位一次。
4. **行号必须叠加 Gutenberg 偏移**：裁剪头尾后若直接按裁剪后的下标写回，会整体错位。`stripGutenberg` 返回 `offset`，所有范围加上偏移（A07 第 45 条）。
5. **测试书 fixture 的段落数少**：最初脚本按"待保存 3 段"等待超时，实际只有 1 段被改（译文/注释只改覆盖层）。断言改为按实际改动段数。
6. **PrintWindow 抓最终 exe**：WebView2 窗口用 `PrintWindow(hwnd, hdc, 2)` 可拿到书架画面（63 KB PNG），无需前台、无需截图工具。

## 5. 后台自动化（沿用 Phase 2 纪律）

- 启动：WMI `Invoke-CimMethod Win32_Process Create`；交互：临时 `--remote-debugging-port=9333` + CDP（`Runtime.evaluate` / `Page.captureScreenshot`）。
- 全流程未移动真实鼠标、未发系统按键、未调用 `SetForegroundWindow`；临时端口在交付前删除并重建，最终 exe 实测端口关闭。
- 截图证据：`_testdata/shots/phase3-*.png`（12 张）。

## 6. 已知欠账（不阻塞本轮）

- 翻译为手工录入，无机器翻译/大模型接入（离线、无外部服务）。
- 只支持书架 TXT；EPUB、磁盘临时文件不可锻造。
- 改写严格"一段换一段"，不做拆分/合并、整章重写、批量替换。
- 译文不进正文，无双语对照排版；版本不导出、不合并、不同步。
- `forge.json` 与 `revisions/` 均为明文 JSON，未加密。

## 7. 下一步（Phase 4）

按 A04：TTS（默认系统语音、可切在线、可导入离线音色包）、竖排细节、彩页策略、内置说明书、命令面板。锻造层可先留接口，等 TTS 的朗读段落定位与锻造段落索引复用同一套范围数据。
