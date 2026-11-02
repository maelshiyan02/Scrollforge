# .agent · Scrollforge 多 agent 共享工作区

> **本目录是 Scrollforge 所有 AI agent 相关数据的唯一真身。**
> 项目记忆只放这里；工具自建的运行目录（如 `.workbuddy/`）不作为记忆载体。

## 目录职责

| 路径 | 放什么 |
|---|---|
| `memory/MEMORY.md` | **主记忆（≤3K 字符）**：框架 + 索引 + 底线。唯一被自动注入的文件 |
| `memory/appendices/` | 编号附录 `A01~A0x`（项目事实）+ `W00`（工作日志索引） |
| `memory/YYYY-MM-DD.md` | 每日工作日志（**只追加**） |
| `documents/plans/` | 计划书（`00` 为现行，`01` 为旧版留档） |
| `documents/analysis/` | 调研与分析报告 |
| `documents/worklog/` | 阶段工作日志本体 `W01~` |
| `specs/` | 阶段性规格（每个 Phase 一份） |
| `build-log/` | 构建记录（版本号、产物校验） |

## 验证工具包（仓库外：`<工作区>/_tools/scrollforge-verify/`）

交付前自己验收用，禁止虚报（详见 `memory/appendices/A07` 第 135–141 条）。
工具已移出项目仓库，避免二进制与一次性脚本污染待发布目录：

| 文件 | 用途 |
|---|---|
| `cdp.js` | 主力：经 WebView2 CDP 端口 `9222` 驱动页面 —— `node cdp.js shot out.png` / `eval "<js>"` / `click "<css>"` / `clickText "<文本>"` |
| `capture.exe` | 备用：`capture.exe "Scrollforge" out.png`，PrintWindow 后台抓图，不抢焦点 |
| `click.exe` | 备用：`click.exe "Scrollforge" x y`，PostMessage 投递点击（打不中 WebView2 时改用 `cdp.js`） |
| `screenshot-tool.exe` | 备用：前台激活后整窗截图 |

固定流程：`npx.cmd tauri build` → 覆盖 `build\Scrollforge.exe` 并核对时间戳 → `Invoke-CimMethod Win32_Process Create` 脱离启动 → `cdp.js` 截图/读 DOM → 逐条对照需求，未达成继续改。

> CDP 端口由 `app/src-tauri/tauri.conf.json` 窗口的 `additionalBrowserArgs` 开启（仅本机回环）。

## 给 AI agent 的读取顺序

1. 先读 `../_shared/index.md`（共享层：全局硬规则 + 方法论索引）。
2. 再读 `.agent/memory/MEMORY.md`（本项目框架 + 索引 + 底线）。
3. 动手前按索引里的「触发时机」读对应附录 `memory/appendices/A0x`。
4. 查历史决策与踩坑，先看 `memory/appendices/W00-工作日志索引.md`，再进 `documents/worklog/`。

## 🔴 三条纪律

1. **绝不写绝对路径**：项目根将来可能改名，文档用 `<项目根>` 占位或相对路径；脚本由自身位置推导根目录。
2. **与同级项目严格隔离**：`../SummonerLens`、`../Mangrove` 是独立仓库与记忆体系，禁止互相改文件；通用规则与可迁移方法放 `../_shared/`。
3. **参考代码库不是代码来源**：`_reference_src/` 内是 AGPL/GPL 项目，只读架构，**禁止复制任何一行代码**进本仓库（本项目锁定 MIT）。

## 记忆防截断规则（硬性）

- 主记忆 `MEMORY.md` ≤ 3K 字符，只放框架与索引。
- 正文一律下沉到编号附录 `A01~A0x`；主文件 ↔ 附录**双向链接**（主文件列附录路径 + 摘要，附录开头回指主文件）。
- 附录单篇超 ~8K 字符就再拆，保持「一篇一个主题 + 明确触发时机」。
- 每轮有实质产出，回写记忆（需要时拆附录 + 建链接），并登记进 `W00` 索引。

## 阶段工作日志规则

- **每个阶段结束必须写一份** `documents/worklog/Wxx-<阶段名>-<日期>.md`。
- 结构固定：目标 → 做了什么 → 验收证据（命令/截图/产物）→ 偏差与原因 → 下一步。
- 同时更新 `memory/appendices/W00-工作日志索引.md` 与当日 `memory/YYYY-MM-DD.md`。

## 踩坑归档规则

- 遇到问题并在**验证后**解决，立即把结论写进 `memory/appendices/A07-踩坑与规则.md`（一条一句话，可执行、可验收）。
- 只写已复现/已解决的坑；猜测不写。写清「现象 → 根因 → 正确做法」。
