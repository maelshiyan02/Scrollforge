---
title: 翻译三通道调用模式（Translate Pipeline）
description: Scrollforge 项目专用：翻译功能在三个界面（ForgePanel 整章/Editor 段落/Reader 划词）的调用方式、配置读取、草稿 vs 正式、术语表/翻译记忆链路差异。每次加新翻译入口复用此 skill。
scope: Scrollforge 项目
version: 1.0
tags: [translate, forge, epub-edit, annotation-tools, e6]
created: 2026-11-02
refs:
  - file: src/lib/translate.ts
    desc: translateOne / translateConfigFromPrefs / TranslateConfig / detectLanguage / languageLabel / pairLabel
  - file: src/lib/prefs.ts
    desc: translateMode / translateSource / translateTarget / translateStyle / translateUseTm 以及 Online/Local endpoint/key/model
  - file: src/components/ForgePanel.tsx
    desc: 通道 1：锻造器整章/段落翻译（完整链路：memory + glossary + 正式写回 forge.json → commit_forge 或 edit_write_blocks）
  - file: src/components/EpubEditPanel.tsx
    desc: 通道 3：编辑器段落翻译（每块「翻译这段」按钮 → translateOne → blockEdits.current[i] → 走 edit_write_blocks 写回链路）
  - file: src/components/AnnotationTools.tsx
    desc: 通道 2：阅读器划词翻译（轻量链路：无 memory/术语表，结果存 sessionStorage 草稿，关闭自动消失）
---

# 翻译三通道调用模式

## 一、三个通道的差异

| 维度 | 通道 1：ForgePanel 整章 | 通道 2：Reader 划词 | 通道 3：Editor 段落 |
|---|---|---|---|
| **入口位置** | ForgePanel 段落列表顶部「译本段」/「译本章」按钮 | AnnotationTools 划词工具栏「翻译一下」按钮 | EpubEditPanel 段落块右下角小按钮 |
| **调用粒度** | 整章循环或单段 | 选中的文字（通常一两句） | 一个完整段落块 |
| **TranslateConfig 来源** | `translateConfigFromPrefs(prefs)` | 同左 | 同左 |
| **术语表 glossary** | `parseGlossary(invoke('read_glossary'))` 完整加载 | **空数组**（轻量链路，不接后端） | 空数组（轻量） |
| **翻译记忆 memory** | `parseMemory(invoke('read_translation_memory'))` 完整加载 + 写回 rememberTranslation | **不传**（空对象或 undefined → translateOne 里 `useTm` 关掉） | 不传 |
| **结果去向** | `forge.json` 的 paragraphs 字段（正式内容） | sessionStorage `scrollforge:read-translate:${bookKey}:${cfi}`（草稿，关浏览器消失） | `blockEdits.current[i]` 设 dirty → edit_write_blocks 写回 EPUB 工作副本（正式内容） |
| **关闭后保留** | ✅ 永久（forge.json 是源文件） | ❌ 消失（sessionStorage） | ✅ 永久（EPUB 已写回） |
| **用户二次改写** | ForgePanel 里直接改 forge.json 再 commit | 无（就是草稿） | EpubEditPanel 段落预览里直接改，「应用改动」写回 |

## 二、TranslateConfig 统一来源

**所有通道都用 `translateConfigFromPrefs(prefs)`**，prefs 由组件 props 传入（`loadPrefs()` 初始化）。TranslateConfig 已扩展：

```ts
type TranslateConfig = {
  mode: 'auto' | 'local' | 'online'
  onlineEndpoint: string
  onlineKey: string
  onlineModel: string
  localEndpoint: string
  localModel: string
  style: 'literary' | 'faithful' | 'casual'
  useTm: boolean
  source: 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'ru' | 'es'  // 新增
  target: 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'ru' | 'es'          // 新增
}
```

translateOne 内部动态化 prompt：
```
请翻译下面这段{sourceLabel}（只输出{targetLabel}译文）：\n\n{masks.text}
```

## 三、translateOne 调用签名

```ts
async function translateOne(options: {
  config: TranslateConfig
  source: string               // 要翻译的原文
  glossary: GlossaryEntry[]    // 通道 1 传完整列表；通道 2/3 传 []
  memory?: TranslationMemoryState  // 通道 1 传完整 state；通道 2/3 不传
}): Promise<TranslateOutcome>
```

TranslateOutcome：
```ts
type TranslateOutcome = {
  text: string             // 译文（已繁转简、专名占位符已还原）
  engine: 'online' | 'local' | 'memory'  // 哪个引擎出的
  fellBack: boolean        // 在线失败回落本地
  warning?: string
  hits: GlossaryEntry[]    // 命中的术语
  masks: number            // 占位符总数
  restored: number         // 成功还原数
  elapsedMs: number
}
```

## 四、通道 3（Editor 段落翻译）标准接法

```tsx
// EpubEditPanel.tsx 每块里加按钮
<button
  className="blk-translate"
  data-tip="翻译这段（会替换块内正文）"
  aria-label="翻译这段"
  disabled={translating}
  onClick={async () => {
    setTranslating(true)
    const cfg = translateConfigFromPrefs(prefs)
    const original = row.html  // 或 block.textContent.trim()
    try {
      const outcome = await translateOne({
        config: cfg,
        source: original,
        glossary: [],
      })
      // 关键：直接把译文塞进去，标 dirty，走已有块写回链路
      blockEdits.current[i] = outcome.text
      setBlocks(prev => prev.map((r, j) => j === i ? { ...r, html: outcome.text } : r))
      onNotify(`已翻译（${outcome.engine === 'online' ? '在线' : '本地'} · ${outcome.elapsedMs.toFixed(0)}ms）`)
    } catch (err) {
      onNotify(`翻译失败：${String(err)}`)
    } finally {
      setTranslating(false)
    }
  }}
>
  <Icon name="translate" size={14} />
</button>
```

**重要约束**（复用 e6-block-write skill 规则）：
- 不要用 translateOne 的 innerHTML 直接块写回 API——译文是纯文本，用 `.textContent` 还原段落的 `<p>` 包裹，或者走 sanitizeInline（白名单 + XML 校验）再塞进 blockEdits。推荐：`sanitizeInline(outcome.text).xml`，保证 XHTML 合法。
- 块写回时 inner 字段带的是完整 inner XHTML，Rust apply_block_edits 会整段替换。如果你只想替换块内文字（不保留原始 inner HTML 里可能存在的脚注/链接结构），**推荐直接走 inner 字段**——反正翻译后就是一段正文。

## 五、通道 2（Reader 划词）标准接法（已实现）

```tsx
// AnnotationTools.tsx 工具栏按钮
const translateSelection = useCallback(async () => {
  if (!selection || translating) return
  setTranslating(true)
  const cfg = translateConfigFromPrefs(prefs)
  try {
    const outcome = await translateOne({ config: cfg, source: selection.text, glossary: [] })
    saveTranslation(bookKey, selection.cfi, selection.text, outcome.text, selection.index)
    scheduleAll()        // 重排译文字贴边位置
    clearSelection()
    onNotify(`已翻译（${engine} · ${outcome.elapsedMs.toFixed(0)}ms），关闭书本或软件后会消失`)
  } catch (err) { onNotify(`翻译失败：${String(err)}`) }
  finally { setTranslating(false) }
}, [selection, translating, prefs, bookKey, scheduleAll, clearSelection, onNotify])
```

草稿存储：sessionStorage，key = `scrollforge:read-translate:${bookKey}:${cfi}`。

## 六、已踩坑（防重犯）

1. **通道 2/3 不传 memory**：translateOne 内部 `if (config.useTm && memory) { ... }` 会先判断 memory 存在——不传 memory 就跳过翻译记忆，不会因为空对象误命中。但通道 1 必须传完整 memory state 才能命中。
2. **source === 'auto' 时 translateOne 内部会 detectLanguage()**；source 非 auto 时直接映射到 LanguageCode（fr/de/ru/es → unknown）。detectLanguage 只能判断中英日韩，其他语种的 `tmKey(lang, source)` 用 unknown 做 key，不会影响引擎请求（引擎会自动识别）。
3. **translateOne prompt 已动态化**，不要在通道里再硬编码 prompt 字符串——改 TranslateConfig 的 style / source / target 即可，translateOne 内部统一生成。
4. **通道 3 结果如果走 inner 字段**，译文要先 sanitizeInline（块内如果之前有脚注/链接 HTML，译文纯文本塞 inner 会把那些结构替换掉——这是设计选择：翻译后就是正文，原始 inner 被 replace；如果想保留原始 inner 结构里的脚注，需要更复杂的 DOM 级操作，目前不支持）。
