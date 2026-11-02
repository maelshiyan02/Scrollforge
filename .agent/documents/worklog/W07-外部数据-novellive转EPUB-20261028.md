# W07 · 外部数据 · novellive《Ending Maker》转 EPUB 并入书库（2026-10-28）

## 目标

把 `https://novellive.app/book/ending-maker/1` 的《Ending Maker》（韩轻英译）按站点顺序抓全，做成标准 EPUB 3，产出到 `_testdata/out/ending-maker.epub`，用 Scrollforge 验收后导入固定书库。

## 抓取

- 复用 `_shared` 下已验证的后台 CDP 路线：headless Chromium + 自写极简 CDP 客户端（`D:\开发缓存\ending-maker-work\cdp.mjs`），不弹可见窗口、不碰键鼠。
- 目录：站点书页 `/book/<slug>/<page>`，列表容器 `.m-newest2 ul.ul-list5`，每页 40 条，`.index-container-btn` 的 Last 链接给末页；16 页取全 634 条，标题保留原样（`Chapter 12 - EPISODE 12 - COUNT CHASE (1)`、`SIDE STORY 12`）。
- 正文：章节页 `.m-read .txt`，取 P / IMG / 标题节点；清掉 `.pf-wrapper`、`ins`、`pf-*` 容器、广告 `img`、`Visit and read more novel...` 推广句；开头与目录同名的重复标题按归一化字符串比对后删除。
- 节流 250ms + 单章 3 次重试；634/634 成功、0 失败、无空章；与目录逐条对账 `missing=[]`。
- 站点该书正文无插图（`images=0`），只有一张封面。

## 产物结构

- EPUB 3 / UTF-8 / `dc:language=en`；spine = `cover.xhtml` → `text/ch0001…ch0634.xhtml`。
- `mimetype` 为 ZIP 首条目、store、无 extra；`dcterms:modified` 无毫秒；`nav.xhtml`（635 条含 Cover）+ `toc.ncx`（634 点）双目录；封面 `properties="cover-image"`。
- 封面：Novel Updates 系列页原图 `https://cdn.novelupdates.com/images/2020/07/Ending-Maker-cover-img.jpg`（480×672，128,425 字节）。
- 体积 13,019,872 字节；ZIP 642 条目 = mimetype + container + 6 个 OPF/导航/样式/封面页 + 1 封面 + 634 章。

## 自检

- `verify-epub.mjs`：mimetype 首项/store/无 extra、container→OPF、modified 格式、cover-image、nav/NCX 全无死链且条目数对得上、章节 634 → 全 PASS，0 error。
- `check-data.mjs`：634 行全 ok、0 fail、0 空章、无过短章（最短段落级正文仍 >1200 字符）、无残留广告、`missing=[]`。
- 正文统计：9,905,447 字符 / 1,792,624 词（段落级，不含标题与标记）。

## Scrollforge 验收（后台 CDP 附着 9333）

- 目录面板 635 节（Cover + 634 章），与 xhtml 数、nav 条目数三方一致。
- 跳 `Chapter 289` → 47%，连点下一页 `fraction 0.46983 → 0.46990`，翻页正常；返回书架再打开 → 恢复 47%；**完整关进程再启动**后重新打开 → 仍恢复到 `Chapter 289 / 47%`（`section 300`），进度记忆跨重启有效。
- 3D 书架：封面正常显示，英文书脊整行旋转且未截断；`spine-latin` 折列沿用 W06 的修复。
- 彩页面板：该书抽出 1 张（封面 480×672），点击可看大图；正文无插图，符合预期。

## 交付

- 样本包：`Scrollforge/_testdata/out/ending-maker.epub`
- 正式版：`build/Scrollforge.exe` v0.6.1（3,870,720 字节），`additionalBrowserArgs` 的调试端口已移除并重建，实测 9333 不通。
- 固定书库：`library/1793190939528/`（`source.epub` 13,019,872 字节 + `cover.jpg` 128,425 字节，`storage=library`，分组「网络小说」）。

## 欠账

- 站点目录标题对 Side Story 只给通用编号，正文首段才有真实小标题，目录与正文标题不完全一致（保留站点原文，未改写）。
- 抓取脚本与中间数据留在 `D:\开发缓存\ending-maker-work\`，未纳入仓库。
