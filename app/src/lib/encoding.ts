/**
 * 纯文本解码：按 BOM → UTF-8 → GB18030 的顺序嗅探。
 * 中文 TXT 大多数是 UTF-8 或 GB18030；UTF-16 只在带 BOM 时出现。
 */

export type DecodedText = {
  text: string
  /** 给用户看的中文编码名 */
  encoding: string
}

function tryDecode(bytes: Uint8Array, label: string, fatal: boolean): DecodedText | null {
  try {
    const text = new TextDecoder(label, { fatal }).decode(bytes)
    // 严格模式下出现替换字符也视为失败
    if (fatal && text.includes('\uFFFD')) return null
    return { text, encoding: label }
  } catch {
    return null
  }
}

export function decodeText(input: ArrayBuffer): DecodedText {
  const bytes = new Uint8Array(input)

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16LE' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16BE' }
  }

  const utf8 = tryDecode(bytes, 'utf-8', true)
  if (utf8) return { text: utf8.text, encoding: 'UTF-8' }

  const gb = tryDecode(bytes, 'gb18030', true)
  if (gb) return { text: gb.text, encoding: 'GB18030' }

  // 最后兜底：容错解码，至少让用户能读到内容
  return { text: new TextDecoder('gb18030').decode(bytes), encoding: 'GB18030（容错）' }
}
