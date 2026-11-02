# 翻译工作流（TRANSLATION）

Scrollforge 的翻译不是「选中一段、弹个译文」的插件，而是三条各自闭环的通道：**阅读时看草稿、编辑时直接改稿、锻造时带记忆批量翻**。

## 1. 三条通道

| 通道 | 入口 | 引擎与上下文 | 写回位置 | 适合场景 |
|---|---|---|---|---|
| **1 · ForgePanel 锻造** | 阅读页锻造面板，逐段或整章 | 术语表 + 翻译记忆 | EPUB 源：直接写回 `working.epub`；TXT 源：写进 `forge.json` 覆盖层 | 整章/整书翻译，需要术语一致与历史复用 |
| **2 · 阅读器划词** | 选中文字 → 工具栏「翻译」 | 轻量链路（不带术语表与记忆） | `sessionStorage` 草稿，关软件即消失 | 随手查一句，不想污染正文 |
| **3 · 编辑器段落** | 编辑面板每个段落块的「翻译这段」 | 轻量链路（不带术语表与记忆） | 通过 `edit_write_blocks` 正式写回工作副本 | 边读边改，译文要成为正文的一部分 |

三者的差异是**写回策略**，不是引擎实现：都走同一套 `translateOne`（`app/src/lib/translate.ts`）与 Rust 命令 `translate_text`。

## 2. 引擎配置

设置页 →「翻译」卡片，可调整：

| 设置项 | 取值 | 说明 |
|---|---|---|
| 模式 | `auto` / `local` / `online` | `auto` = 优先在线，失败自动回落本地 |
| 在线接口 | 默认 `https://api.deepseek.com/v1` | 任意 OpenAI 兼容的 `/chat/completions` 接口 |
| 在线模型 | 默认 `deepseek-chat` | 选择不填时可能报错，请填实际模型名 |
| 在线 Key | 默认空 | **只存在本机 localStorage**，不会上传 |
| 本地接口 | 默认 `http://127.0.0.1:11434/v1` | Ollama / LM Studio 的兼容端点 |
| 本地模型 | 默认 `qwen2.5:7b` | 需先在本地引擎里 pull 好 |
| 风格 | `literary` / `faithful` / `casual` | 文学化 / 忠实 / 口语化，影响提示词 |
| 源语言 | `auto` 或 zh/en/ja/ko/fr/de/ru/es | `auto` 交由引擎识别 |
| 目标语言 | 默认 `zh` | 可改为其它语言 |
| 使用翻译记忆 | 开 / 关 | 命中记忆时不再请求引擎 |

偏好整体保存在 localStorage 的 `scrollforge:prefs` 键下（设备级，不随书走）。

> 🔒 **安全提醒**：API Key 以明文存于本机 localStorage。公用电脑请用「仅本地」模式，或每次用完清空 Key。本机设置文件不进入版本库。

## 3. 术语表（Glossary）

- 存放位置：应用数据目录 `translate/glossary.json`，由 Rust 命令读写，**跨书共用**。
- 支持 CSV / JSON 导入导出。CSV 允许 **2–4 列**：`原文,译文,类型,备注`；类型缺省为 `term`。
- 类型取值：

| 值 | 含义 |
|---|---|
| `person` | 人名 |
| `place` | 地名 |
| `org` | 组织名 |
| `term` | 通用术语 |

CSV 示例：

```csv
原文,译文,类型,备注
아리에스,阿里耶斯,person,男主角
테라,泰拉,place,
마도협회,魔法协会,org,
각성,觉醒,term,
```

**专名掩码机制**：送翻译前，术语表命中的专名会被替换为 `【T1】`…`【Tn】` 占位符；模型译文回来后，再把占位符还原成术语表里的**简体标准译名**。这样无论模型怎么发挥，人名、地名、组织名的一致性都是 100%。

## 4. 翻译记忆（Translation Memory）

- 存放位置：应用数据目录 `translate/memory.json`。
- 结构（版本 1）：

```json
{
  "version": 1,
  "entries": {
    "<原文哈希或原文>": {
      "source": "原文",
      "target": "译文",
      "from": "ko",
      "to": "zh",
      "engine": "online",
      "updatedAt": 1762100000000
    }
  }
}
```

- 命中记忆时直接复用译文，不再请求引擎（可在设置里关闭）。
- **用户手工修订的译文会覆盖记忆里的旧值**，下次同句自动采用修订版。

## 5. 提示词与后处理

一次翻译的完整链路：

```
分段 → 术语表匹配 → 专名替换为【Tn】→ 组装风格提示词（含 few-shot）
    → 引擎调用（在线 / 本地 / 自动回落）→ 繁转简（OpenCC t2cn，优先级最高）
    → 【Tn】还原为标准译名 → 一致性检查 → 写入翻译记忆
```

- **繁转简**在模型输出之后、写回之前强制执行（`opencc-js` 的 `tw → cn` 转换）。即使模型输出繁体，落库也一定是简体。
- 风格提示词分三档：文学化（允许成语、口语韵律）、忠实（贴近原文句法）、口语化（自然对话）。
- 源语言 `auto` 时由引擎自行判断；已知是韩文/英文时显式指定可减少误判。

## 6. 伪代码示例

**通道 2（阅读器划词，草稿）**

```ts
const cfg = { mode: prefs.translateMode, source: prefs.translateSource, target: prefs.translateTarget, /* ... */ }
const out = await translateOne(selectedText, cfg)   // 不传 glossary、不传 memory
showDraftBesideSelection(out.text)                  // 存 sessionStorage，随页面走
```

**通道 3（编辑器段落，正式写回）**

```ts
const fn = await translateOne(blockText, cfg)       // glossary: []，memory: 不传
const safe = sanitizeInline(fn.text)                // 白名单 + XML 合法性校验
blockEdits.current[i] = { html: safe }
setBlockDirty(i)
await invoke('edit_write_blocks', { editDir, relPath, edits })  // 只替换 dirty 块
```

**通道 1（整章，带术语与记忆）**

```ts
const out = await translateOne(text, cfg, glossary, memory)
if (isEpubSource) {
  await invoke('edit_write_blocks', { editDir, relPath, edits })
  await invoke('edit_save', { editDir, outputPath, createRevision: true })
} else {
  writeForgeOverlay(chapterIndex, paragraphIndex, out.text)  // TXT 覆盖层
}
```

## 7. 边界与已知限制

- 引擎必须在**用户自己配置**后才可用；仓库不内置任何模型权重。
- 划词与段落通道故意不带术语表/记忆，换取更快响应；要一致性请走锻造通道。
- 长段落会按引擎上下文上限切分，跨段落的指代可能丢失。
- 译文写回前会过 XML 合法性校验；含非法标签的译文会被拦下，需要人工处理。
