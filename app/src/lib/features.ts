import type { Prefs } from './prefs'

/** 功能注册表：设置页「功能」、F1 说明书都从这里生成，避免文档与界面漂移。 */

export type FeatureStatus = 'online' | 'beta' | 'planned'

/** 功能分区：设置页左侧导航、帮助页章节都按这个分组 */
export type FeatureGroup = 'reading' | 'editing' | 'forge' | 'translate' | 'general'

export const GROUP_LABEL: Record<FeatureGroup, string> = {
  reading: '阅读',
  editing: '编辑',
  forge: '锻造',
  translate: '翻译',
  general: '通用',
}

export type PrefKey = keyof Prefs

type SettingCommon = {
  label: string
  /** 一句人话解释，直接显示在设置项下方与说明书里 */
  hint: string
  disabled?: boolean
}

export type SettingMeta =
  | (SettingCommon & { kind: 'toggle'; key?: PrefKey })
  | (SettingCommon & {
      kind: 'select'
      key?: PrefKey
      options: { value: string; label: string }[]
    })
  | (SettingCommon & {
      kind: 'number'
      key?: PrefKey
      min: number
      max: number
      step?: number
      unit?: string
    })
  | (SettingCommon & {
      kind: 'text'
      key?: PrefKey
      placeholder?: string
      /** API Key 等敏感内容用密码框显示 */
      secret?: boolean
    })
  | (SettingCommon & { kind: 'note'; action?: 'storage' | 'glossary' | 'translateTest' | 'translateModel' })

export type FeatureEntry = {
  id: string
  icon: string
  title: string
  status: FeatureStatus
  group: FeatureGroup
  /** 入口位置，F1 说明书里做「在界面中高亮该按钮」的文字指引 */
  where: string
  desc: string
  settings: SettingMeta[]
}

export const STATUS_LABEL: Record<FeatureStatus, string> = {
  online: '已上线',
  beta: '实验中',
  planned: '规划中',
}

export const FEATURES: FeatureEntry[] = [
  {
    id: 'appearance',
    icon: 'palette',
    title: '外观与护眼',
    status: 'online',
    group: 'general',
    where: '设置页「功能」切面；书架与阅读页顶栏最右的调色按钮（日间 → 护眼 → 夜间循环）',
    desc:
      '日间是纸白底，保持原有观感；护眼是低饱和绿纸面，整体亮度与蓝光观感都更低；夜间是深灰纸面，不用纯黑以避免暗环境光晕。' +
      '阅读页正文、锻造台、EPUB 编辑页、弹窗全部跟随；图片与封面三档都不反色，夜间只轻微降亮。',
    settings: [
      {
        kind: 'select',
        key: 'theme',
        label: '界面主题',
        hint: '日间=纸白；护眼=绿纸面；夜间=深灰。顶栏调色按钮可随时轮换，选择会记住。',
        options: [
          { value: 'day', label: '日间（纸白）' },
          { value: 'eye', label: '护眼（绿纸面）' },
          { value: 'night', label: '夜间（深灰）' },
        ],
      },
      {
        kind: 'note',
        label: '覆盖范围与边界',
        hint:
          '阅读正文会跟随主题换底色与文字色；EPUB 编辑页随三档切换（日间浅色、夜间深色）。' +
          'PDF / CBZ 是固定版式，页面内容按原样渲染，只把周围舞台变暗。',
      },
    ],
  },
  {
    id: 'reading',
    icon: 'auto_stories',
    title: '阅读与彩页',
    status: 'online',
    group: 'reading',
    where: '阅读页顶栏：目录、单双页、横竖排、分页/滚动、排版（整页缩放）、彩页与插图',
    desc:
      'EPUB / MOBI / AZW3 / FB2 / CBZ / ZIP / PDF 直接按原书排版渲染；TXT / Markdown / HTML 走文本排版。' +
      '彩页画廊支持 EPUB 与 CBZ，点击插图可全屏查看。',
    settings: [
      {
        kind: 'select',
        key: 'readerFlow',
        label: '默认翻页方式',
        hint: '打开图书时用分页还是连续滚动；阅读页顶栏可随时切换。',
        options: [
          { value: 'paginated', label: '分页（左右翻页）' },
          { value: 'scrolled', label: '连续滚动' },
        ],
      },
      {
        kind: 'toggle',
        key: 'readerDoublePage',
        label: '默认双页',
        hint: '宽屏时一屏显示两页；窄窗口下仍可手动切回单页。',
      },
      {
        kind: 'toggle',
        key: 'readerVertical',
        label: '默认竖排（右→左）',
        hint: '日文轻小说与中文古籍常用；横排仍是默认。',
      },
      {
        kind: 'note',
        label: '彩页与插图',
        hint: '阅读页顶栏「彩页与插图」按钮：EPUB/CBZ 单独浏览整页大图，PDF 是固定版式，用整页缩放查看。',
      },
    ],
  },
  {
    id: 'shelf',
    icon: 'local_library',
    title: '书架',
    status: 'online',
    group: 'general',
    where: '书架顶栏：网格 / 列表 / 3D 书架、排序、分类切面、刷新与设置',
    desc: '阅读历史与本地书库并存；网格、列表、3D 书架三视图，按最近阅读、导入时间或书名排序。',
    settings: [
      {
        kind: 'select',
        key: 'shelfView',
        label: '默认视图',
        hint: '打开应用时书架的默认呈现方式；顶栏可随时切换。',
        options: [
          { value: 'grid', label: '网格（封面墙）' },
          { value: 'list', label: '列表（详细信息）' },
          { value: 'shelf3d', label: '3D 书架（书脊）' },
        ],
      },
      {
        kind: 'select',
        key: 'shelfSort',
        label: '默认排序',
        hint: '最近阅读优先适合追更；按书名适合整理书库。',
        options: [
          { value: 'recent', label: '最近阅读' },
          { value: 'imported', label: '导入时间' },
          { value: 'title', label: '书名' },
        ],
      },
      {
        kind: 'note',
        label: '3D 书架背景',
        hint: '暖白背板 + 浅木搁板 + 书挡投影；书太多时可切回网格或列表。',
      },
    ],
  },
  {
    id: 'editing',
    icon: 'edit_note',
    title: '编辑',
    status: 'online',
    group: 'editing',
    where: '阅读页左上角「阅读 / 编辑」切换；编辑器内文件树、源码、段落、目录、元数据标签',
    desc:
      '解包 EPUB、编辑源码与段落、目录树与元数据写回、保存并重打包、另存为、epubcheck。' +
      '每次保存可生成 revision，回滚也留档。',
    settings: [
      {
        kind: 'number',
        key: 'editorBlockFont',
        label: '段落预览字号',
        hint: '编辑器「段落」标签里正文的字号，也可在框内 Ctrl+滚轮临时缩放。',
        min: 11,
        max: 34,
        unit: 'px',
      },
      {
        kind: 'number',
        key: 'editorSrcFont',
        label: '源码字号',
        hint: '源码视图的等宽字号，也可在框内 Ctrl+滚轮临时缩放。',
        min: 9,
        max: 28,
        unit: 'px',
      },
      {
        kind: 'toggle',
        key: 'editorAutoRebuild',
        label: '源码停顿后自动重建预览',
        hint: '在「预览 + 源码」并排视图里，停止输入 700ms 后自动刷新预览；关掉后需手动点「刷新预览」。',
      },
      {
        kind: 'toggle',
        key: 'editorCreateRevision',
        label: '保存时生成 revision',
        hint: '「保存并重打包」会在 .history 里留一份可回滚的副本；另存为不生成 revision。',
      },
    ],
  },
  {
    id: 'convert',
    icon: 'sync_alt',
    title: '转换与新建书',
    status: 'online',
    group: 'general',
    where: '书架顶栏「新建书」与「转换」；书卡右键「转换为 EPUB」「导出文本」',
    desc:
      'TXT / Markdown / HTML / FB2 / CBZ / PDF 转 EPUB；EPUB 可导出 TXT / Markdown / HTML。' +
      '新建书支持封面、样式预设、树形目录与插图。',
    settings: [
      {
        kind: 'select',
        key: 'convertPreset',
        label: '新建书默认样式',
        hint: '只影响新建书向导的初始选中项，生成后仍可在编辑器里改 style.css。',
        options: [
          { value: 'zh-serif', label: '中文宋体' },
          { value: 'en-serif', label: '英文衬线' },
          { value: 'minimal', label: '极简无衬线' },
        ],
      },
      {
        kind: 'toggle',
        key: 'convertIndent',
        label: '转换时首行缩进两字',
        hint: '转换向导的默认选项；预览里可随时改。',
      },
      {
        kind: 'toggle',
        key: 'convertCenterHeading',
        label: '转换时章节标题居中',
        hint: '转换向导的默认选项；预览里可随时改。',
      },
      {
        kind: 'note',
        label: '输出目录',
        hint: '转换与导出的默认落盘位置，可在「文件夹与书库 → 最终成品」里修改。',
        action: 'storage',
      },
    ],
  },
  {
    id: 'forge',
    icon: 'build',
    title: '锻造（TXT 精修）',
    status: 'beta',
    group: 'forge',
    where: '阅读页顶栏「锻造」；只对从书架打开的 TXT 图书可用',
    desc: '逐段改写、翻译、注释并写回 TXT 源文件，先快照再写回，可查看 diff 与回滚。',
    settings: [
      {
        kind: 'note',
        label: '适用范围',
        hint: '仅 TXT；EPUB 请用「编辑」面板，其它格式先转成 EPUB 工作副本。',
      },
    ],
  },
  {
    id: 'translate',
    icon: 'translate',
    title: '翻译',
    status: 'online',
    group: 'translate',
    where: '阅读页「锻造台」：逐段「译本段」、整章「译本章」；设置 → 功能 → 翻译',
    desc:
      '韩译中 / 英译中：术语表 + 人称地名表先锁定专名，再交给本地或在线引擎翻译，' +
      '译后统一繁转简并回写翻译记忆。在线失败会自动回落到本地。',
    settings: [
      {
        kind: 'select',
        key: 'translateMode',
        label: '引擎模式',
        hint:
          '自动：先在线，失败则回落本地；仅本地适合断网；仅在线适合已配好云端密钥；' +
          '百度两档都用 APP ID + 密钥：通用版 QPS=1、大模型版 QPS=10 且支持翻译指令。' +
          '百度两档翻译整章时会把整章段落合并成一次请求，按段落行对齐回填。',
        options: [
          { value: 'auto', label: '自动（在线 → 本地回落）' },
          { value: 'local', label: '仅本地引擎' },
          { value: 'online', label: '仅在线引擎' },
          { value: 'baidu', label: '百度翻译（通用文本翻译）' },
          { value: 'baiduLlm', label: '百度翻译（大模型，支持翻译指令）' },
        ],
      },
      {
        kind: 'select',
        key: 'translateBackend',
        label: '本地引擎实现',
        hint: '内置：ONNX 离线模型，首次需下载（约 900MB），之后断网可用；HTTP：连接 Ollama / LM Studio。',
        options: [
          { value: 'builtin', label: '内置离线模型（NLLB）' },
          { value: 'http', label: '本机 HTTP（Ollama / LM Studio）' },
        ],
      },
      {
        kind: 'text',
        key: 'translateModelDir',
        label: '离线模型存放位置',
        hint: '模型文件（约 900MB）落在这个目录下的 nllb_600m；默认放在 Scrollforge 主目录，避免占 C 盘。',
        placeholder: 'D:\\AI Coding Project Management\\Scrollforge\\models',
      },
      {
        kind: 'note',
        label: '内置离线模型',
        hint: '约 900MB，首次下载后可完全断网翻译；模型只存在本机，不上传任何内容。下载进度与落盘路径见下方。',
        action: 'translateModel',
      },
      {
        kind: 'text',
        key: 'translateOnlineEndpoint',
        label: '在线接口地址',
        hint: 'OpenAI 兼容的 /chat/completions 服务，例如 https://api.deepseek.com/v1。',
        placeholder: 'https://api.deepseek.com/v1',
      },
      {
        kind: 'text',
        key: 'translateOnlineKey',
        label: '在线 API Key',
        hint: '只保存在本机偏好里，不会写进书籍文件或翻译记忆。',
        placeholder: 'sk-…',
        secret: true,
      },
      {
        kind: 'text',
        key: 'translateOnlineModel',
        label: '在线模型名',
        hint: '与接口地址配套的模型标识，例如 deepseek-chat。',
        placeholder: 'deepseek-chat',
      },
      {
        kind: 'text',
        key: 'translateBaiduAppId',
        label: '百度翻译 APP ID',
        hint: '百度翻译开放平台 → 开发者信息 里的 APP ID；只在引擎模式选「百度翻译」时使用。',
        placeholder: '2024xxxxxxxxxxxxxx',
      },
      {
        kind: 'text',
        key: 'translateBaiduKey',
        label: '百度翻译密钥',
        hint: '开发者信息里的密钥，只存本机；不要填 API Key。通用文本翻译免费用量为 100 万字符。',
        placeholder: '密钥（字母 + 数字）',
        secret: true,
      },
      {
        kind: 'note',
        label: '百度翻译限制',
        hint:
          '通用版不支持提示词，译文风格与通用术语不生效；大模型版会把风格与术语写成翻译指令（reference），效果更贴近文学化要求。' +
          '两档都仍会对人名地名做占位符保护；通用版免费额度 QPS=1，大模型版 QPS=10，整章翻译会按约 2000 字/次自动分批。' +
          '所有译文落库前统一繁转简，包括原文括号里的繁体汉字注释。',
      },
      {
        kind: 'text',
        key: 'translateLocalEndpoint',
        label: '本地接口地址',
        hint: 'Ollama / LM Studio 等本地服务的 OpenAI 兼容地址；断网也能用。',
        placeholder: 'http://127.0.0.1:11434/v1',
      },
      {
        kind: 'text',
        key: 'translateLocalModel',
        label: '本地模型名',
        hint: '本地已下载的模型，例如 qwen2.5:7b；模型包由你在本地服务里管理。',
        placeholder: 'qwen2.5:7b',
      },
      {
        kind: 'select',
        key: 'translateStyle',
        label: '译文风格',
        hint: '文学化适合小说；忠实适合资料；口语化适合轻小说与日常对话。',
        options: [
          { value: 'literary', label: '文学化（自然书面语）' },
          { value: 'faithful', label: '忠实（少润色）' },
          { value: 'casual', label: '口语化（轻快）' },
        ],
      },
      {
        kind: 'select',
        key: 'translateSource',
        label: '源语言',
        hint: '自动：让引擎识别原文；明确指定时翻译更准，适合特定语种的书。',
        options: [
          { value: 'auto', label: '自动识别' },
          { value: 'zh', label: '中文' },
          { value: 'en', label: '英文' },
          { value: 'ja', label: '日文' },
          { value: 'ko', label: '韩文' },
          { value: 'fr', label: '法文' },
          { value: 'de', label: '德文' },
          { value: 'ru', label: '俄文' },
          { value: 'es', label: '西班牙文' },
        ],
      },
      {
        kind: 'select',
        key: 'translateTarget',
        label: '目标语言',
        hint: '译文要写成什么语言；默认中文。',
        options: [
          { value: 'zh', label: '中文' },
          { value: 'en', label: '英文' },
          { value: 'ja', label: '日文' },
          { value: 'ko', label: '韩文' },
          { value: 'fr', label: '法文' },
          { value: 'de', label: '德文' },
          { value: 'ru', label: '俄文' },
          { value: 'es', label: '西班牙文' },
        ],
      },
      {
        kind: 'toggle',
        key: 'translateUseTm',
        label: '优先使用翻译记忆',
        hint: '同一原文译过一次后直接复用；你在锻造台里的修改会覆盖旧记忆。',
      },
      {
        kind: 'note',
        label: '术语表与人名地名表',
        hint: '专名翻译前锁定为占位符，译后还原成简体译名，一致性 100%；可导入导出 CSV / JSON。',
        action: 'glossary',
      },
      {
        kind: 'note',
        label: '测试引擎连接',
        hint: '用一句极短文本确认地址、密钥、模型是否可用；失败会给出中文原因。',
        action: 'translateTest',
      },
    ],
  },
  {
    id: 'tts',
    icon: 'record_voice_over',
    title: '朗读',
    status: 'planned',
    group: 'reading',
    where: '规划中：阅读页顶栏将新增「听书」按钮',
    desc: '按章朗读、语速与音色调校；默认系统语音，可切在线引擎与离线音色包。',
    settings: [
      {
        kind: 'toggle',
        label: '启用朗读',
        hint: 'R7 之后落地，当前不生效。',
        disabled: true,
      },
    ],
  },
  {
    id: 'experimental',
    icon: 'science',
    title: '实验',
    status: 'beta',
    group: 'general',
    where: '阅读页固定版式（PDF / 漫画 / 固定版式 EPUB）',
    desc: '不进正式验收的新交互先放在这里；出问题可随时关掉，不影响书库与文件。',
    settings: [
      {
        kind: 'toggle',
        key: 'experimentalFixedWheelZoom',
        label: '固定版式 Ctrl+滚轮缩放',
        hint: 'PDF / 漫画页面上按住 Ctrl 滚轮按倍率缩放整页；关掉后只能从「整页缩放」面板调整。',
      },
    ],
  },
]

/** 快捷键按使用场景分组：说明书与设置页都按这个顺序展示 */
export type ShortcutScope = 'universal' | 'shelf' | 'reading' | 'editing' | 'forge'

export const SHORTCUT_SCOPE_LABEL: Record<ShortcutScope, string> = {
  universal: '通用（任何页面）',
  shelf: '书架主页',
  reading: '阅读模式',
  editing: '编辑模式',
  forge: '锻造 / 翻译模式',
}

export const SHORTCUTS: { keys: string; label: string; scope: ShortcutScope }[] = [
  // 通用
  { keys: 'Esc', label: '关闭当前弹层 / 返回上一层；阅读页没有弹层时返回书架；设置与说明书整页按 Esc 关闭', scope: 'universal' },
  { keys: 'F1', label: '打开或关闭帮助说明书（阅读页、设置页、说明书页内都可用）', scope: 'universal' },
  { keys: 'Ctrl + ,', label: '打开设置整页（书架与阅读页）', scope: 'universal' },
  { keys: '滚轮 / ↑ ↓', label: '上下滚动长页面：说明书、设置列表、阅读页滚动排版', scope: 'universal' },
  { keys: 'Ctrl + Z', label: '撤销：编辑模式撤销段落改动，锻造模式撤销当前译文改动', scope: 'universal' },
  { keys: 'Ctrl + Shift + Z', label: '重做：编辑模式恢复刚撤销的段落改动', scope: 'universal' },
  // 书架
  { keys: '滚轮 / ↑ ↓', label: '在书架与书单里上下浏览', scope: 'shelf' },
  { keys: '单击书籍', label: '打开这本书；右键卡片可编辑 / 转换 / 删除', scope: 'shelf' },
  { keys: '拖拽文件到窗口', label: '按「设置 → 导入」勾选的格式导入', scope: 'shelf' },
  // 阅读
  { keys: '← / PageUp', label: '上一页（竖排或从右往左排版时方向自动反转）', scope: 'reading' },
  { keys: '→ / PageDown / 空格', label: '下一页', scope: 'reading' },
  { keys: 'Ctrl + ← / Ctrl + →', label: '上一章 / 下一章（按目录跳转，不逐页翻）', scope: 'reading' },
  { keys: '↑ ↓', label: '滚动排版时上下滑动', scope: 'reading' },
  { keys: 'T', label: '展开 / 收起目录侧栏', scope: 'reading' },
  { keys: 'E', label: '进入编辑模式（仅 EPUB；其它格式需先转换为 EPUB 工作副本）', scope: 'reading' },
  { keys: 'G', label: '进入锻造 / 翻译模式（需要已解析出章节）', scope: 'reading' },
  { keys: 'Ctrl + 滚轮', label: '缩放：普通书改字号，固定版式（PDF / 漫画）按倍率缩放整页', scope: 'reading' },
  { keys: '← / →（全屏看图）', label: '切换上一张 / 下一张插图；Esc 关闭', scope: 'reading' },
  { keys: '单击书内图片', label: '打开全屏看图', scope: 'reading' },
  { keys: 'Esc', label: '依次关闭脚注 / 画廊 / 阅读设置 / 目录；都关着时返回书架', scope: 'reading' },
  // 编辑
  { keys: 'Ctrl + Z', label: '撤销段落改动（文字、删除、新建、上移下移都算一步）', scope: 'editing' },
  { keys: 'Ctrl + Shift + Z', label: '重做段落改动', scope: 'editing' },
  { keys: 'Ctrl + U', label: '给选中文字加 / 去下划线（粗体、斜体、链接同在有按钮）', scope: 'editing' },
  { keys: 'Ctrl + 滚轮', label: '缩放源码框 / 段落预览字号', scope: 'editing' },
  { keys: 'Esc', label: '回到阅读模式；有未保存改动时先弹确认', scope: 'editing' },
  // 锻造
  { keys: 'Ctrl + Z', label: '撤销当前段译文（含 AI 翻译 / 润色结果）', scope: 'forge' },
  { keys: 'Esc', label: '回到阅读模式（不改动原文，译文留在草稿里）', scope: 'forge' },
]
