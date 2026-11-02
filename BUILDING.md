# 构建指南（BUILDING）

面向需要从源码跑起来或自己出包的开发者。命令均在 `<项目根>/app` 下执行。

## 1. 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | **≥ 20.19**（或 22.12+） | Vite 7 的最低要求；用 `node -v` 核对 |
| Rust | **≥ 1.77**（edition 2021） | 见 `app/src-tauri/Cargo.toml` 的 `rust-version` |
| MSVC 工具链 | Visual Studio 2022 Build Tools（C++ 桌面开发） | Windows 下 Tauri 的必需链接器 |
| WebView2 Runtime | 系统自带或单独安装 | Win10/11 通常已内置 |
| Java | **17+**（可选） | 仅 epubcheck 校验功能需要 |

本机（开发者的 Windows 约定，其他机器不强制）Rust 装在 `D:\dev\rust`，每次开新终端需先设置：

```powershell
$env:CARGO_HOME='D:\dev\rust\cargo'
$env:RUSTUP_HOME='D:\dev\rust'
$env:PATH='D:\dev\rust\cargo\bin;' + $env:PATH
```

## 2. 安装依赖

```powershell
cd app
npm install
```

## 3. 开发模式

```powershell
cd app
npm run tauri dev
```

前端单独调试可只用 `npm run dev`（Vite 起在 `http://localhost:1420`），但涉及后端命令的功能必须在 Tauri 里跑。

## 4. 生产构建

```powershell
cd app
npm run build          # tsc --noEmit 类型检查 + vite 打包到 app/dist
npm run tauri build    # 前端产物打进 exe
```

产物位置：`app/src-tauri/target/release/scrollforge.exe`。

仓库约定把最终交付物覆盖到 `<项目根>/build/Scrollforge.exe`，交付前核对**修改时间与字节数**：

```powershell
Copy-Item -LiteralPath 'app\src-tauri\target\release\scrollforge.exe' -Destination 'build\Scrollforge.exe' -Force
Get-Item -LiteralPath 'build\Scrollforge.exe' | Select-Object LastWriteTime,Length
```

> ⚠️ **必须用 `npm run tauri build`，不能只 `cargo build --release`**。后者不会把 Vite 产物打进二进制，运行时 WebView2 会加载不到资源。

## 5. 构建前必须存在的资源

以下目录体积较大，**不在 git 里**，新克隆的仓库需要自行准备：

| 路径 | 体积 | 用途 | 获取方式 |
|---|---|---|---|
| `app/public/pdfjs/` | ≈ 4.8 MB | PDF 只读渲染（pdf.mjs / worker / cmaps / standard_fonts） | 已随仓库提供；若缺失，从 pdfjs-dist 复制同名目录 |
| `app/src-tauri/resources/runtime/` | ≈ 46 MB | 内置便携 Java 运行时（`bin/ conf/ legal/ lib/`），保证打包后无需用户另装 JRE | 从 `<工作区>/_tools/jre21-epubcheck/` 或 `<工作区>/_tools/jdk/` 复制对应运行时文件 |
| `app/src-tauri/resources/epubcheck/` | ≈ 13 MB | epubcheck 4.2.6（`epubcheck.jar` + `lib/` + 许可文件） | 从 `<工作区>/_tools/epubcheck-4.2.6/` 拷入 |

缺 `runtime/` 或 `epubcheck/` 时前端仍可构建，但打包产物的「EPUB 检查」功能会失效。

## 6. 常见问题

| 现象 | 原因与处理 |
|---|---|
| 打包后打开是白屏 | 用了 `cargo build` 而不是 `tauri build`，前端资源没进包 |
| `error: linker link.exe not found` | 未装 MSVC Build Tools，或未在「x64 Native Tools 命令行」环境 |
| epubcheck 报 Java 相关错误 | 需要 Java 17+；PATH 里若有 32 位 Java 垫片会崩，改用 JDK 全路径 |
| 端口 `9222` 一直开着 | 调试时在 `tauri.conf.json` 开了 `additionalBrowserArgs`，**交付前必须删除该字段并重新构建** |
| 构建缓存巨大（`target/` 数 GB） | 正常；`app/src-tauri/target/` 已被 `.gitignore` 覆盖 |

## 7. 类型检查与快速自检

```powershell
cd app
npm run build      # tsc --noEmit + vite build，exit 0 即通过
cargo check        # 在 app/src-tauri 下执行，验证 Rust 侧
```
