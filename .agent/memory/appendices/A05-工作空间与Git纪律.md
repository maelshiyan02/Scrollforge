# A05 · 工作空间与 Git 纪律

> 上级索引：`../MEMORY.md` §0 ｜ 相关：`../../../_shared/memory/appendices/A05-工作空间与Git纪律.md`（通用版）

**触发时机**：碰 git、目录、跨项目引用、搬迁之前。

## 1. 工作区布局

```
<工作区根>/
  _shared/            共享层：全局硬规则、方法论 kb、通用附录（不在任何 git 仓库内）
  Scrollforge/        ← 本项目
  SummonerLens/       同级独立项目
  Mangrove/           同级独立项目
```

- 🔴 只改 `Scrollforge/` 内的文件；`../SummonerLens`、`../Mangrove` 一律不碰。
- 通用规则写进 `../_shared/`，项目专属事实写进本目录。

## 2. 本项目目录

```
<项目根>/
  .agent/         记忆与文档（本目录）
  app/            工程（前端 + src-tauri）
  build/          交付产物（Scrollforge.exe）
  icon.png        品牌图标（源）
  _reference_apps/ 参考软件隔离安装（git 忽略）
  _reference_src/  参考源码（git 忽略，只读）
  _testdata/       测试样本与截图（git 忽略）
```

## 3. Git 纪律

- **显式 add**：逐个文件 `git add <path>`；🔴 禁止 `git add -A` / `git add .`。
- 提交前 `git status` 必须干净（除本次有意改动）。
- 以下一律不提交：`_reference_apps/`、`_reference_src/`、`_testdata/`、`app/node_modules/`、`app/src-tauri/target/`、`build/`（产物按需另议）。
- 许可证文件（foliate-js 的 LICENSE）必须随代码提交。

## 4. 路径纪律

- 文档中不写死本机绝对路径，用 `<项目根>` 或相对路径。
- 脚本一律由自身位置推导根目录。

## 5. 环境事实

- 本机 Rust 不在 PATH，需 `CARGO_HOME=D:\dev\rust\cargo`、`RUSTUP_HOME=D:\dev\rust\rustup`（详见 A02 §4）。环境迁移时更新这一条。
