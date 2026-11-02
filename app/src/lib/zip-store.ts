/**
 * 极简 ZIP 打包器：只写"存储"（method 0）条目，不压缩。
 *
 * EPUB 只要求 `mimetype` 作为第一个条目、且不做压缩；其余条目用 store 方式
 * 仍然是合法 ZIP，第三方阅读器可直接解包。这样就不必引入压缩库，
 * 也避免复制任何 GPL 代码。
 */

export type ZipEntry = {
  /** 归档内路径，一律用 / 分隔，且只允许 ASCII */
  name: string
  data: Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day =
    ((Math.max(1980, date.getFullYear()) - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate()
  return { time, date: day }
}

/**
 * 生成 ZIP。调用方负责保证 `mimetype` 排在第一位（EPUB 规范硬要求）。
 */
export function createZip(entries: ZipEntry[], modified = new Date()): Uint8Array {
  const encoder = new TextEncoder()
  const { time, date } = dosDateTime(modified)

  const records = entries.map((entry) => {
    if (!/^[\x20-\x7e]+$/.test(entry.name)) {
      throw new Error(`压缩包内路径只能使用 ASCII：${entry.name}`)
    }
    return {
      name: encoder.encode(entry.name),
      data: entry.data,
      crc: crc32(entry.data),
      offset: 0,
    }
  })

  let total = 22
  for (const record of records) {
    total += 30 + record.name.length + record.data.length
    total += 46 + record.name.length
  }

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let at = 0

  for (const record of records) {
    record.offset = at
    view.setUint32(at, 0x04034b50, true) // 本地文件头
    view.setUint16(at + 4, 20, true) // 解压所需版本
    view.setUint16(at + 6, 0, true) // 标志位
    view.setUint16(at + 8, 0, true) // 压缩方式：存储
    view.setUint16(at + 10, time, true)
    view.setUint16(at + 12, date, true)
    view.setUint32(at + 14, record.crc, true)
    view.setUint32(at + 18, record.data.length, true)
    view.setUint32(at + 22, record.data.length, true)
    view.setUint16(at + 26, record.name.length, true)
    view.setUint16(at + 28, 0, true) // 无额外字段
    at += 30
    out.set(record.name, at)
    at += record.name.length
    out.set(record.data, at)
    at += record.data.length
  }

  const centralStart = at
  for (const record of records) {
    view.setUint32(at, 0x02014b50, true) // 中央目录项
    view.setUint16(at + 4, 20, true) // 制作版本
    view.setUint16(at + 6, 20, true) // 解压所需版本
    view.setUint16(at + 8, 0, true)
    view.setUint16(at + 10, 0, true)
    view.setUint16(at + 12, time, true)
    view.setUint16(at + 14, date, true)
    view.setUint32(at + 16, record.crc, true)
    view.setUint32(at + 20, record.data.length, true)
    view.setUint32(at + 24, record.data.length, true)
    view.setUint16(at + 28, record.name.length, true)
    view.setUint16(at + 30, 0, true) // extra
    view.setUint16(at + 32, 0, true) // comment
    view.setUint16(at + 34, 0, true) // 起始磁盘号
    view.setUint16(at + 36, 0, true) // 内部属性
    view.setUint32(at + 38, 0, true) // 外部属性
    view.setUint32(at + 42, record.offset, true)
    at += 46
    out.set(record.name, at)
    at += record.name.length
  }

  view.setUint32(at, 0x06054b50, true) // 中央目录结束记录
  view.setUint16(at + 4, 0, true)
  view.setUint16(at + 6, 0, true)
  view.setUint16(at + 8, records.length, true)
  view.setUint16(at + 10, records.length, true)
  view.setUint32(at + 12, at - centralStart, true)
  view.setUint32(at + 16, centralStart, true)
  view.setUint16(at + 20, 0, true)

  return out
}
