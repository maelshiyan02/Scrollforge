import { useState } from 'react'
import Icon from './Icon'
import PageBar from './PageBar'
import {
  FEATURES,
  GROUP_LABEL,
  SHORTCUTS,
  SHORTCUT_SCOPE_LABEL,
  STATUS_LABEL,
} from '../lib/features'
import type { FeatureEntry, FeatureGroup, SettingMeta, ShortcutScope } from '../lib/features'

type Props = {
  onClose: () => void
}

const GROUP_ORDER: FeatureGroup[] = ['reading', 'editing', 'forge', 'translate', 'general']

/** 操作详解的导航图标：与功能清单保持同一套图标语义 */
const GROUP_ICON: Record<FeatureGroup, string> = {
  reading: 'auto_stories',
  editing: 'edit_note',
  forge: 'build',
  translate: 'translate',
  general: 'tune',
}
const SCOPE_ORDER: ShortcutScope[] = ['universal', 'shelf', 'reading', 'editing', 'forge']

function settingLine(setting: SettingMeta): string {
  if (setting.kind === 'select') {
    return `${setting.label}：${setting.options.map((item) => item.label).join(' / ')}`
  }
  if (setting.kind === 'number') {
    return `${setting.label}：${setting.min}–${setting.max}${setting.unit ?? ''}`
  }
  if (setting.kind === 'toggle') {
    return `${setting.label}：开关`
  }
  return setting.label
}

function matches(feature: FeatureEntry, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  return (
    feature.title.toLowerCase().includes(needle) ||
    feature.desc.toLowerCase().includes(needle) ||
    feature.where.toLowerCase().includes(needle) ||
    feature.settings.some(
      (setting) => setting.label.toLowerCase().includes(needle) || setting.hint.toLowerCase().includes(needle),
    )
  )
}

function shortcutMatches(keys: string, label: string, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  return keys.toLowerCase().includes(needle) || label.toLowerCase().includes(needle)
}

/** 独立帮助整页：左侧大纲 + 搜索，按场景讲快捷键，再按功能分区逐条说明 */
export default function HelpDialog({ onClose }: Props) {
  const [query, setQuery] = useState('')

  const jump = (id: string) => {
    document.getElementById(`help-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="help-page" role="dialog" aria-label="帮助说明书">
      <PageBar title="Scrollforge 说明书" icon="menu_book" onBack={onClose}>
        <span className="help-page__sub">按场景讲快捷键与操作要点 · Esc 关闭说明书</span>
      </PageBar>

      <div className="help-page__layout">
        <aside className="help-nav">
          <div className="help-nav__group">入门</div>
          <button onClick={() => jump('quick')}>
            <Icon name="rocket_launch" size={16} />
            <span>快速上手</span>
          </button>
          <button onClick={() => jump('modes')}>
            <Icon name="view_quilt" size={16} />
            <span>三档模式</span>
          </button>
          <button onClick={() => jump('shortcuts')}>
            <Icon name="keyboard" size={16} />
            <span>快捷键（分场景）</span>
          </button>
          <div className="help-nav__group">操作详解</div>
          {GROUP_ORDER.map((group) => (
            <button key={group} onClick={() => jump(`${group}-guide`)}>
              <Icon name={GROUP_ICON[group]} size={16} />
              <span>{GROUP_LABEL[group]}操作</span>
            </button>
          ))}
          <div className="help-nav__group">其他</div>
          <button onClick={() => jump('settings')}>
            <Icon name="settings" size={16} />
            <span>设置与存储</span>
          </button>
          <button onClick={() => jump('faq')}>
            <Icon name="help" size={16} />
            <span>常见问题</span>
          </button>
          <button onClick={() => jump('features')}>
            <Icon name="list" size={16} />
            <span>功能清单</span>
          </button>
        </aside>

        <div className="help-page__body">
          <div className="settings-search">
            <Icon name="search" size={16} />
            <input
              type="search"
              value={query}
              placeholder="搜索功能、设置项或快捷键"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && <button className="btn small" onClick={() => setQuery('')}>清空</button>}
          </div>

          <section className="help-section" id="help-quick">
            <h3>快速上手</h3>
            <ol className="help-steps">
              <li><b>导入书</b>：书架右上角「导入」选择文件，或直接把文件拖进窗口；文件夹导入会按子文件夹分组。</li>
              <li><b>打开书</b>：单击卡片进入阅读；进度自动保存，下次从上次位置继续。封面页会先出现，点「开始阅读」跳过前置页。</li>
              <li><b>调阅读体验</b>：顶栏「阅读设置」改字号、行距、页边距、竖排、双页与滚动/翻页；<kbd>Ctrl + 滚轮</kbd> 也能缩放。</li>
              <li><b>做笔记</b>：阅读时划词即可加批注、写译文草稿；这些内容只属于这本书，不写回原文件。</li>
              <li><b>改书 / 翻译</b>：EPUB 可直接按 <kbd>E</kbd> 进入编辑，按 <kbd>G</kbd> 进入锻造翻译；其它格式先在书架右键「转换为 EPUB」。</li>
            </ol>
          </section>

          <section className="help-section" id="help-modes">
            <h3>三档模式：阅读 / 编辑 / 锻造</h3>
            <p className="help-lead">
              三档共用同一个阅读外壳：同一本书、同一个顶栏和底栏，只是中间面板不同。按顶栏的模式按钮切换，
              快捷键 <kbd>E</kbd>（编辑）与 <kbd>G</kbd>（锻造）在阅读模式下可直接进入。
            </p>
            <table className="shortcut-table help-table">
              <thead>
                <tr><th>模式</th><th>用途</th><th>退出</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td><b>阅读</b></td>
                  <td>按原书排版阅读，记进度、划词批注、全屏看图。</td>
                  <td><kbd>Esc</kbd> 返回书架（有弹层时先逐层关闭）</td>
                </tr>
                <tr>
                  <td><b>编辑</b></td>
                  <td>只对 EPUB 工作副本改段落、源码、元数据、目录；可写回、重打包、另存、epubcheck。</td>
                  <td><kbd>Esc</kbd> 回阅读；有未保存改动会先确认</td>
                </tr>
                <tr>
                  <td><b>锻造</b></td>
                  <td>逐段翻译并沉淀译文草稿、术语表与翻译记忆；字典与 AI 润色都只动译文。</td>
                  <td><kbd>Esc</kbd> 回阅读，草稿自动保留</td>
                </tr>
              </tbody>
            </table>
            <p className="help-note">
              安全边界：编辑与锻造都先操作工作副本 / 草稿，<b>不会</b>直接改原书。写回、重打包、另存为都是显式按钮，
              失败时原文保持不动。切走编辑档若有脏改动，会弹确认，不会静默丢失。
            </p>
          </section>

          <section className="help-section" id="help-shortcuts">
            <h3>快捷键（按使用场景）</h3>
            <p className="help-lead">
              同一个键在不同页面含义不同，下面按场景分组。通用键在任何页面都成立；<kbd>Ctrl + Z</kbd> 是通用撤销，
              但只在编辑段落、译文框这类可撤销的地方生效。
            </p>
            {SCOPE_ORDER.map((scope) => {
              const rows = SHORTCUTS.filter(
                (item) => item.scope === scope && shortcutMatches(item.keys, item.label, query),
              )
              if (!rows.length) return null
              return (
                <div className="help-scope" key={scope}>
                  <h4>{SHORTCUT_SCOPE_LABEL[scope]}</h4>
                  <table className="shortcut-table">
                    <tbody>
                      {rows.map((item) => (
                        <tr key={`${scope}-${item.keys}-${item.label}`}>
                          <td><kbd>{item.keys}</kbd></td>
                          <td>{item.label}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            })}
            <p className="help-note">
              说明书页里 <kbd>Esc</kbd> 同样关闭整页（回到打开它之前的页面，从书架打开就是返回主页）；<kbd>F1</kbd> 可在任意页面开关这份说明书。
              阅读页的 <kbd>↑ ↓</kbd> 与滚轮是通用上下滑动；翻页排版请用 <kbd>← →</kbd>。
            </p>
          </section>

          <section className="help-section" id="help-reading-guide">
            <h3>阅读操作详解</h3>
            <ul className="help-tips">
              <li><b>翻页与滚轮</b>：翻页模式下 <kbd>← / → / PageUp / PageDown / 空格</kbd> 翻页；竖排或从右往左排版时方向自动反转。滚动模式下 <kbd>↑ ↓</kbd> 与滚轮连续滑动。</li>
              <li><b>跳章</b>：<kbd>Ctrl + ←</kbd> / <kbd>Ctrl + →</kbd> 按目录整章跳转；底栏左右两组按钮也能上/下章、上/下页，进度条可拖动。</li>
              <li><b>目录</b>：按 <kbd>T</kbd> 或点顶栏目录按钮；点击条目跳转，目录里的分组条目只作层级展示。</li>
              <li><b>全屏看图</b>：单击书内图片进入画廊，<kbd>← / →</kbd> 切换，<kbd>Esc</kbd> 退出；画廊只收原生尺寸足够的整页图，图标和装饰小图会被过滤。</li>
              <li><b>脚注</b>：点击脚注链接在浮层内查看，<kbd>Esc</kbd> 关闭；浮层里可以继续点链接跳转。</li>
              <li><b>缩放</b>：<kbd>Ctrl + 滚轮</kbd> 对普通书改字号，对固定版式（PDF / 漫画 / 扫描页）按倍率缩放整页；字号与行距对固定版式无效。</li>
              <li><b>进度</b>：翻页、跳章、拖动进度条都会保存；退出重开按 CFI 回到原位置。阅读历史只记路径与进度，本地书库才存副本。</li>
              <li><b>主题</b>：书架左下角菜单可切日间 / 护眼 / 夜间；阅读页顶栏也有主题按钮。</li>
            </ul>
          </section>

          <section className="help-section" id="help-editing-guide">
            <h3>编辑操作详解（EPUB）</h3>
            <ol className="help-steps">
              <li><b>进入</b>：阅读页按 <kbd>E</kbd>，或书架卡片右键「编辑」。非 EPUB 会提示先转换工作副本。</li>
              <li><b>四个视图</b>：<b>段落视图</b>按块编辑正文；<b>源码视图</b>直接改 XHTML；<b>元数据</b>改书名、作者、语言、封面；<b>目录</b>改层级、重命名、排序、增删节点。</li>
              <li><b>段落创作</b>：工具条可「新建段落 / 新标题 1–3 / 空行」，插在聚焦段之后；支持上移、下移、删除与撤销删除。新建块会先以高亮行出现，写入后才进源码。</li>
              <li><b>文字样式</b>：选中文字用粗体、斜体、下划线（<kbd>Ctrl + U</kbd>）、链接；链接既可填站内相对路径，也可填完整 URL。</li>
              <li><b>插图</b>：工具条「插入图片」从这本 EPUB 现有图片资源里挑选，自动按当前文件计算相对路径，避免跨目录死链。</li>
              <li><b>撤销 / 重做</b>：<kbd>Ctrl + Z</kbd> / <kbd>Ctrl + Shift + Z</kbd>，或工具条按钮。文字输入、删除、新建、上移下移都在撤销栈里；写回成功后坐标变化，撤销栈会重置。</li>
              <li><b>写回</b>：只提交改动块，其余段落逐字节保留；写回前做 XML 合法性校验。若块区间冲突会整体取消，不会写半个文件。</li>
              <li><b>重打包 / 另存 / 检查</b>：重打包生成 EPub；另存为不会覆盖原书；epubcheck 报告分级列出问题文件与行号。</li>
              <li><b>修订与回滚</b>：每次写回/重打包都会留修订记录，可在修订面板里 diff 与回滚到指定版本。</li>
            </ol>
            <p className="help-note">
              取舍：上移 / 下移交换的是两段的内容与标签，原块的 class / id 留在原位。若该段被目录锚点引用，
              锚点仍指向原来的位置，必要时请到目录视图手动调整。
            </p>
          </section>

          <section className="help-section" id="help-forge-guide">
            <h3>锻造 / 翻译操作详解</h3>
            <ol className="help-steps">
              <li><b>草稿</b>：进入锻造时按原文结构生成「forge-draft.json」，每段先放空译文占位；所有译文只写进草稿的 target，<b>不会覆盖原文</b>。</li>
              <li><b>逐段翻译</b>：选中段落点「译本段」，或用「译本章」批量补空段。已有译文默认保留，不会被静默覆盖。</li>
              <li><b>整章对照</b>：切到「整章对照」，原文在左、译文在右逐段成对，同一行天然同步，适合通读与统一语气。</li>
              <li><b>手工润色</b>：右侧译文框可直接改；<kbd>Ctrl + Z</kbd> 撤销当前段的上一步（AI 结果同样可撤）。</li>
              <li><b>AI 润色</b>：点「润色」让在线 / 本地 LLM 只改译文表达，不改原意并保留「【T1】」占位符。内置离线模型只做翻译，会提示切换引擎。</li>
              <li><b>术语表与记忆库</b>：术语表命中会提示并参与翻译；翻译记忆会把已确认的「原文 → 译文」沉淀下来，下次优先复用。</li>
              <li><b>保存</b>：显式保存才写草稿文件；退出锻造会自动 flush。写回 EPUB 仍是编辑档的显式动作。</li>
            </ol>
          </section>

          <section className="help-section" id="help-settings">
            <h3>设置与存储</h3>
            <ul className="help-tips">
              <li><b>三个目录</b>：阅读历史只记路径与进度；本地书库保存副本；最终成品是转换与导出的默认位置，都可单独指定。</li>
              <li><b>设置页结构</b>：左侧分类（文件夹与书库 / 导入 / 阅读 / 编辑 / 锻造 / 翻译 / 通用 / 快捷键 / 关于）。功能分区顶部有搜索框，功能卡点标题可展开收起。</li>
              <li><b>导入格式</b>：「设置 → 导入」勾选后才会出现在导入对话框；拖拽文件同样按这份清单过滤，小于阈值的文件会被忽略。</li>
              <li><b>保存</b>：底部「保存设置」才生效；「取消」或左上返回不保存。改动未保存时切分类不会丢，但关页会丢。</li>
              <li><b>快捷键速查</b>：「设置 → 快捷键」与这份说明书同源；两处内容永远一致，不会出现一处过期的说法。</li>
            </ul>
          </section>

          <section className="help-section" id="help-faq">
            <h3>常见问题</h3>
            <ul className="help-tips">
              <li><b>为什么按 E 进不了编辑？</b>只有 EPUB 能直接编辑；MOBI / AZW3 / PDF 等先在书架右键「转换为 EPUB」，会生成工作副本。</li>
              <li><b>译文会不会把原文改掉？</b>不会。锻造译文只进「forge-draft.json」；编辑器里「翻译」按钮也只改当前段的显示内容，需要你另行应用改动。</li>
              <li><b>写回失败怎么办？</b>看提示里的块号与原因（区间重叠、XML 非法、标签不支持）。失败时文件没有被写入，修正后重试即可。</li>
              <li><b>Esc 为什么有时不返回主页？</b>Esc 优先关闭最上层弹层（脚注 / 画廊 / 阅读设置 / 目录 / 设置 / 说明书），都关着时才返回书架；在说明书页按 Esc 直接返回主页。</li>
              <li><b>字号调了没变化？</b>固定版式（PDF / 漫画 / 扫描页）按整页缩放，字号、行距、页边距都不生效，请用 <kbd>Ctrl + 滚轮</kbd> 或阅读设置里的缩放。</li>
              <li><b>书打不开 / 封面丢失？</b>原文件被移动或删除时，历史记录会提示找不到；本地书库副本仍可打开。封面缺失会自动尝试从 EPUB 重新提取。</li>
              <li><b>撤销为什么没反应？</b>撤销只作用于编辑段落与译文框；源码视图和目录输入框用浏览器原生撤销。写回成功后编辑撤销栈会重置。</li>
            </ul>
          </section>

          <section className="help-section" id="help-features">
            <h3>功能清单</h3>
            {query && <p className="settings-hint">以下条目已按「{query}」过滤。</p>}
            {GROUP_ORDER.map((group) => {
              const items = FEATURES.filter((feature) => feature.group === group && matches(feature, query))
              if (items.length === 0) return null
              return (
                <div className="help-feature-group" id={`help-${group}`} key={group}>
                  <h4>{GROUP_LABEL[group]}功能</h4>
                  {items.map((feature) => (
                    <article className="help-feature" key={feature.id}>
                      <div className="help-feature__head">
                        <span className="help-feature__icon"><Icon name={feature.icon} size={16} /></span>
                        <b>{feature.title}</b>
                        <em className={`feature-tag ${feature.status === 'online' ? 'on' : feature.status === 'beta' ? 'beta' : ''}`}>
                          {STATUS_LABEL[feature.status]}
                        </em>
                      </div>
                      <p className="help-feature__where">{feature.where}</p>
                      <p className="help-feature__desc">{feature.desc}</p>
                      {feature.settings.length > 0 && (
                        <ul className="help-feature__settings">
                          {feature.settings.map((setting) => (
                            <li key={setting.label}>
                              <span>{settingLine(setting)}</span>
                              <small>{setting.hint}</small>
                            </li>
                          ))}
                        </ul>
                      )}
                    </article>
                  ))}
                </div>
              )
            })}
            {query && FEATURES.every((feature) => !matches(feature, query)) && (
              <p className="settings-hint">没有匹配「{query}」的功能条目；可以换个关键词再试。</p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
