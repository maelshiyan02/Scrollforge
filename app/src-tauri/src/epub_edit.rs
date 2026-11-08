//! EPUB 编辑器核心：解包 / 重打包 / OPF 解析 / 安全校验 / 内置 epubcheck
//!
//! 许可证约束：本模块只处理自有代码（MIT），不依赖任何 AGPL/GPL 库。
//! zip crate (MIT) + quick-xml (MIT) 是唯一新增依赖。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Read, Write, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;
use std::os::windows::process::CommandExt;
use zip::{ZipArchive, ZipWriter, CompressionMethod};
use zip::write::FileOptions;

// ──────────────────────────────────────────────────────
// 数据结构
// ──────────────────────────────────────────────────────

/// 解包后每个条目的清单（写入 _index.json）
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EntryInfo {
    pub path: String,           // 归档内路径（/ 分隔）
    pub media_type: String,     // 推断的 MIME
    pub id: Option<String>,     // manifest 里的 id（若在 OPF 声明）
    pub role: String,           // text / style / image / font / other
    pub size: u64,              // 原始字节数
    pub crc: u32,               // CRC32（解包时算）
    pub compressed: u64,        // ZIP 内压缩后大小
    pub stored: bool,           // 是否存储（不压缩）
}

/// OPF manifest 条目
#[derive(Serialize, Deserialize, Clone)]
pub struct ManifestItem {
    pub id: String,
    pub href: String,
    pub media_type: String,
    #[serde(default)]
    pub properties: Option<String>,
}

/// OPF metadata
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpfMetadata {
    pub identifier: String,
    pub title: String,
    pub language: String,
    #[serde(default)]
    pub creator: Option<String>,
    #[serde(default)]
    pub cover_image: Option<String>,
    #[serde(default)]
    pub modified: Option<String>,
}

/// 目录树节点（nav.xhtml 用）
#[derive(Serialize, Deserialize, Clone)]
pub struct TocNode {
    pub label: String,
    pub href: String,
    #[serde(default)]
    pub children: Vec<TocNode>,
}

/// 工作副本摘要
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EditWorkspace {
    pub book_id: String,
    pub origin_path: String,
    pub origin_size: u64,
    pub origin_modified: i64,
    pub edit_dir: String,
    pub opf_path: String,          // 从 container.xml 解析出的相对路径
    pub opf_abs: String,           // 绝对路径
    pub entries: Vec<EntryInfo>,
    pub metadata: OpfMetadata,
    pub revisions: Vec<String>,    // 快照时间戳列表
}

/// epubcheck 检查结果
#[derive(Serialize, Deserialize, Clone)]
pub struct CheckResult {
    pub level: String,    // fatal / error / warning / info / ok
    pub code: String,      // OPF-073 / PKG-021 等
    pub message: String,
    pub path: Option<String>,
    pub line: Option<u32>,
}

/// 文件内容（前端读取用，文本或 base64 二选一）
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub rel_path: String,
    pub mime: String,
    pub text: Option<String>,
    pub base64: Option<String>,
    pub size: u64,
}

// ──────────────────────────────────────────────────────
// 安全校验
// ──────────────────────────────────────────────────────

const MAX_ENTRIES: usize = 20_000;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GB

/// 解包前安全检查：路径穿越、DRM、ZIP 炸弹
pub fn validate_epub(bytes: &[u8]) -> Result<(), String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("不是合法的 EPUB (ZIP 解析失败): {}", e))?;

    let total = archive.len();
    if total == 0 { return Err("压缩包为空".into()); }
    if total > MAX_ENTRIES {
        return Err(format!("条目数 {} 超过上限 {}", total, MAX_ENTRIES));
    }

    let mut sum: u64 = 0;
    for i in 0..total {
        let file = archive.by_index(i).map_err(|e| format!("读条目失败: {}", e))?;
        let name = file.name();

        // 路径穿越
        let normalized = name.replace('\\', "/");
        if normalized.contains("..") || normalized.starts_with('/') {
            return Err(format!("危险路径: {}", name));
        }

        // mimetype 必须在第一个位置
        if i == 0 && name != "mimetype" {
            return Err("mimetype 不是第一个条目，非法 EPUB".into());
        }

        // DRM 拒绝
        if normalized == "META-INF/encryption.xml" {
            return Err("该 EPUB 含 DRM（META-INF/encryption.xml），不支持编辑".into());
        }

        sum += file.size() as u64;
        if sum > MAX_TOTAL_BYTES {
            return Err("解压总字节超过 2GB 上限，疑似 ZIP 炸弹".into());
        }
    }

    Ok(())
}

// ──────────────────────────────────────────────────────
// 解包
// ──────────────────────────────────────────────────────

pub fn unpack_epub(epub_path: &Path, edit_dir: &Path) -> Result<EditWorkspace, String> {
    let bytes = fs::read(epub_path)
        .map_err(|e| format!("读源文件失败: {}", e))?;

    validate_epub(&bytes)?;

    let mut archive = ZipArchive::new(Cursor::new(&bytes))
        .map_err(|e| format!("ZIP 解析失败: {}", e))?;

    // 清旧解包
    if edit_dir.exists() {
        fs::remove_dir_all(edit_dir)
            .map_err(|e| format!("清理旧工作副本失败: {}", e))?;
    }
    fs::create_dir_all(edit_dir)
        .map_err(|e| format!("创建工作副本目录失败: {}", e))?;

    let mut entries = Vec::new();
    let mut manifest_map: HashMap<String, (String, String)> = HashMap::new(); // href -> (id, media_type)
    let mut opf_rel = String::new();
    let mut opf_dir = String::new();
    let mut mimetype_ok = false;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).unwrap();
        let name = file.name().to_string();
        let normalized = name.replace('\\', "/");

        // 解包到磁盘
        let out_path = edit_dir.join(&normalized);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).ok();
        }
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).ok();
        fs::write(&out_path, &buf).ok();

        let is_mimetype = normalized == "mimetype";
        if is_mimetype {
            mimetype_ok = true;
            let content = String::from_utf8_lossy(&buf);
            if content.trim() != "application/epub+zip" {
                return Err(format!("mimetype 内容错误: '{}'", content.trim()));
            }
        }

        // 推断 MIME
        let mime = infer_mime_str(&normalized);
        let role = infer_role_str(&normalized, &mime);

        entries.push(EntryInfo {
            path: normalized.clone(),
            media_type: mime,
            id: None,
            role,
            size: file.size() as u64,
            crc: file.crc32(),
            compressed: file.compressed_size() as u64,
            stored: file.compression() == CompressionMethod::Stored,
        });

        // 读 container.xml 找 OPF
        if normalized == "META-INF/container.xml" {
            opf_rel = parse_container(&buf)?;
            // 推导 OPF 所在目录
            if let Some(idx) = opf_rel.rfind('/') {
                opf_dir = opf_rel[..=idx].to_string();
            }
        }
        // 读 OPF 拿 manifest
        else if normalized == opf_rel {
            manifest_map = parse_opf_manifest(&buf, &opf_dir)?;
        }
    }

    if !mimetype_ok {
        return Err("没找到 mimetype 条目".into());
    }
    if opf_rel.is_empty() {
        return Err("没找到 META-INF/container.xml".into());
    }

    // OPF 可能排在 container.xml 之前，循环里的顺序匹配会漏；这里从已解压文件补解析一次
    if manifest_map.is_empty() {
        let opf_probe = edit_dir.join(&opf_rel);
        if let Ok(buf) = fs::read(&opf_probe) {
            manifest_map = parse_opf_manifest(&buf, &opf_dir)?;
        }
    }

    // 回填 manifest id
    for entry in entries.iter_mut() {
        if let Some((id, _)) = manifest_map.get(&entry.path) {
            entry.id = Some(id.clone());
        }
    }

    // 读 OPF metadata
    let opf_abs = edit_dir.join(&opf_rel);
    let opf_bytes = fs::read(&opf_abs).unwrap_or_default();
    let mut metadata = parse_opf_metadata(&opf_bytes)?;
    metadata.cover_image = cover_item(&String::from_utf8_lossy(&opf_bytes))
        .map(|(_, href, _)| format!("{}{}", opf_dir, href));

    // 写 _index.json
    let index_json = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("序列化 _index.json 失败: {}", e))?;
    fs::write(edit_dir.join("_index.json"), &index_json).ok();

    // 准备 revisions 目录
    let revisions_dir = edit_dir.parent().unwrap().join("revisions");
    fs::create_dir_all(&revisions_dir).ok();

    Ok(EditWorkspace {
        book_id: format!("edit_{}", chrono_now()),
        origin_path: epub_path.to_string_lossy().to_string(),
        origin_size: bytes.len() as u64,
        origin_modified: file_mtime(epub_path),
        edit_dir: edit_dir.to_string_lossy().to_string(),
        opf_path: opf_rel,
        opf_abs: opf_abs.to_string_lossy().to_string(),
        entries,
        metadata,
        revisions: Vec::new(),
    })
}

// ──────────────────────────────────────────────────────
// 重打包
// ──────────────────────────────────────────────────────

pub fn pack_epub(edit_dir: &Path, output_path: &Path) -> Result<(), String> {
    // 清旧包
    if output_path.exists() {
        fs::remove_file(output_path).ok();
    }

    let file = fs::File::create(output_path)
        .map_err(|e| format!("创建输出文件失败: {}", e))?;
    let mut writer = ZipWriter::new(file);

    let entries = sorted_entries(edit_dir)?;

    // 第一条 mimetype 必须 STORED（A07 第 42 条）
    let (mimetype_data, _) = entries.first().ok_or("没有条目")?;
    writer.start_file("mimetype", FileOptions::<()>::default().compression_method(CompressionMethod::Stored))
        .map_err(|e| format!("写 mimetype 失败: {}", e))?;
    writer.write_all(mimetype_data).ok();

    // 其余 DEFLATED
    for (data, rel_path) in entries.iter().skip(1) {
        writer.start_file(rel_path, FileOptions::<()>::default().compression_method(CompressionMethod::Deflated))
            .map_err(|e| format!("写 {} 失败: {}", rel_path, e))?;
        writer.write_all(data).ok();
    }

    writer.finish().map_err(|e| format!("ZIP 结束失败: {}", e))?;

    Ok(())
}

fn sorted_entries(edit_dir: &Path) -> Result<Vec<(Vec<u8>, String)>, String> {
    let mut result = Vec::new();
    walk_dir(edit_dir, edit_dir, &mut result)?;

    // 确保 mimetype 是第一个
    result.sort_by(|(_, a), (_, b)| {
        if a == "mimetype" { std::cmp::Ordering::Less }
        else if b == "mimetype" { std::cmp::Ordering::Greater }
        else { a.cmp(b) }
    });

    Ok(result)
}

fn walk_dir(base: &Path, dir: &Path, out: &mut Vec<(Vec<u8>, String)>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.file_name().map(|n| n == "_index.json").unwrap_or(false) {
            continue;
        }
        if path.file_name().map(|n| n == "_blocks.json").unwrap_or(false) {
            continue;
        }
        let rel = path.strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");

        if path.is_dir() {
            walk_dir(base, &path, out)?;
        } else {
            let data = fs::read(&path).map_err(|e| e.to_string())?;
            out.push((data, rel));
        }
    }
    Ok(())
}

// ──────────────────────────────────────────────────────
// OPF 解析（quick-xml 0.31）
// ──────────────────────────────────────────────────────

fn parse_container(buf: &[u8]) -> Result<String, String> {
    let content = String::from_utf8_lossy(buf);
    // 回退：正则（比 serde::from_str 更稳）
    let start = content.find("full-path=\"").ok_or("container.xml 格式错误")? + 11;
    let end = content[start..].find('"').ok_or("container.xml 路径截断")?;
    let path = content[start..start + end].to_string();
    if path.is_empty() {
        return Err("container.xml 里没找到 rootfile".into());
    }
    Ok(path)
}

fn parse_opf_manifest(buf: &[u8], opf_dir: &str) -> Result<HashMap<String, (String, String)>, String> {
    let s = String::from_utf8_lossy(buf);
    let mut map: HashMap<String, (String, String)> = HashMap::new();

    let mut reader = quick_xml::Reader::from_str(&s);
    reader.trim_text(true);

    let mut in_manifest = false;
    let mut buf_key = Vec::new();

    loop {
        match reader.read_event_into(&mut buf_key) {
            // 兼顾外部 EPUB 的写法：<item .../> 是 Empty 事件，自家生成的可能是 Start
            Ok(quick_xml::events::Event::Start(ref e) | quick_xml::events::Event::Empty(ref e)) => {
                let local = e.local_name();
                let local_bytes: &[u8] = local.as_ref();
                if local_bytes == b"manifest" {
                    in_manifest = true;
                } else if in_manifest && local_bytes == b"item" {
                    let mut id = String::new();
                    let mut href = String::new();
                    let mut media = String::new();
                    for attr in e.attributes().flatten() {
                        let k = attr.key.local_name();
                        let kb: &[u8] = k.as_ref();
                        let v = String::from_utf8_lossy(&attr.value).to_string();
                        match kb {
                            b"id" => id = v,
                            b"href" => href = v,
                            b"media-type" => media = v,
                            _ => {}
                        }
                    }
                    if !id.is_empty() && !href.is_empty() {
                        // 相对 OPF 目录拼接绝对路径
                        let full_href = if href.starts_with('/') {
                            href.trim_start_matches('/').to_string()
                        } else {
                            format!("{}{}", opf_dir, href)
                        };
                        map.insert(full_href.replace('\\', "/"), (id, media));
                    }
                }
            }
            Ok(quick_xml::events::Event::End(ref e)) => {
                let local = e.local_name();
                if local.as_ref() == b"manifest" { break; }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf_key.clear();
    }

    Ok(map)
}

/// 解析 OPF spine（reading order）：返回 idref 列表（按 content 顺序）。
/// 不含 playOrder（EPUB3 playOrder 也支持）。
pub fn parse_opf_spine(buf: &[u8]) -> Result<Vec<String>, String> {
    let s = String::from_utf8_lossy(buf);
    let mut reader = quick_xml::Reader::from_str(&s);
    reader.trim_text(true);

    let mut ids = Vec::new();
    let mut in_spine = false;
    let mut buf_key = Vec::new();

    loop {
        match reader.read_event_into(&mut buf_key) {
            // <itemref .../> 在多数 EPUB 中是自闭合标签（Empty），必须一并处理
            Ok(quick_xml::events::Event::Start(ref e) | quick_xml::events::Event::Empty(ref e)) => {
                let local = e.local_name();
                let lb: &[u8] = local.as_ref();
                if lb == b"spine" {
                    in_spine = true;
                } else if in_spine && lb == b"itemref" {
                    let mut idref = String::new();
                    for attr in e.attributes().flatten() {
                        let k = attr.key.local_name();
                        let kb: &[u8] = k.as_ref();
                        let v = String::from_utf8_lossy(&attr.value).to_string();
                        if kb == b"idref" { idref = v; }
                    }
                    if !idref.is_empty() {
                        ids.push(idref);
                    }
                }
            }
            Ok(quick_xml::events::Event::End(ref e)) => {
                let local = e.local_name();
                if local.as_ref() == b"spine" { break; }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf_key.clear();
    }

    Ok(ids)
}

fn parse_opf_metadata(buf: &[u8]) -> Result<OpfMetadata, String> {
    let s = String::from_utf8_lossy(buf);
    let mut reader = quick_xml::Reader::from_str(&s);
    reader.trim_text(true);

    let mut result = OpfMetadata {
        identifier: String::new(),
        title: String::new(),
        language: String::from("en"),
        creator: None,
        cover_image: None,
        modified: None,
    };

    let mut buf_key = Vec::new();
    let mut buf_text = String::new();
    let mut in_metadata = false;
    let mut current_tag: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf_key) {
            Ok(quick_xml::events::Event::Start(ref e)) => {
                let local = e.local_name();
                let lb: &[u8] = local.as_ref();
                if lb == b"metadata" {
                    in_metadata = true;
                }
                if in_metadata {
                    let name = String::from_utf8_lossy(lb).to_string();
                    current_tag = Some(name);
                    buf_text.clear();
                }
            }
            Ok(quick_xml::events::Event::Text(e)) => {
                if in_metadata {
                    buf_text.push_str(&String::from_utf8_lossy(&e));
                }
            }
            Ok(quick_xml::events::Event::CData(e)) => {
                if in_metadata {
                    buf_text.push_str(&String::from_utf8_lossy(&e));
                }
            }
            Ok(quick_xml::events::Event::End(ref e)) => {
                let local = e.local_name();
                if local.as_ref() == b"metadata" { break; }
                if in_metadata {
                    let key = current_tag.clone().unwrap_or_default();
                    let text = buf_text.trim().to_string();
                    buf_text.clear();
                    current_tag = None;

                    if !text.is_empty() {
                        if key.ends_with("identifier") || key == "identifier" {
                            if result.identifier.is_empty() {
                                result.identifier = text;
                            }
                        } else if key.ends_with("title") || key == "title" {
                            if result.title.is_empty() {
                                result.title = text;
                            }
                        } else if key == "language" || key.ends_with("language") {
                            result.language = text;
                        } else if key == "creator" || key.ends_with("creator") {
                            result.creator = Some(text);
                        } else if key.contains("modified") {
                            result.modified = Some(text);
                        }
                    }
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf_key.clear();
    }

    Ok(result)
}

// ──────────────────────────────────────────────────────
// E2：元数据写回（书名 / 作者 / 语言 / 封面）
// ──────────────────────────────────────────────────────

fn escape_xml_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn local_name(name: &str) -> &str {
    match name.rsplit_once(':') {
        Some((_, local)) => local,
        None => name,
    }
}

/// 找 [from, to) 内第一个本地名为 local 的开始标签 → (标签起点, '>' 位置, 原始名)
fn find_start_tag(raw: &str, local: &str, from: usize, to: usize) -> Option<(usize, usize, String)> {
    let mut i = from;
    while i + 1 < to {
        let rel = raw[i..to].find('<')?;
        let start = i + rel;
        if start + 1 >= to { return None; }
        let first = raw.as_bytes()[start + 1];
        if first == b'/' || first == b'?' || first == b'!' {
            i = start + 1;
            continue;
        }
        let open_end = start + raw[start..to].find('>')?;
        let head = &raw[start + 1..open_end];
        let name_end = head
            .find(|c: char| c.is_ascii_whitespace() || c == '/')
            .unwrap_or(head.len());
        let name = &head[..name_end];
        if local_name(name) == local {
            return Some((start, open_end, name.to_string()));
        }
        i = open_end + 1;
    }
    None
}

/// 取标签（`<item id="x" href="y">`）里的属性值
fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let mut from = 0;
    while let Some(pos) = tag[from..].find(attr) {
        let start = from + pos;
        let before_ok = start == 0 || tag.as_bytes()[start - 1] == b' ';
        if before_ok {
            let rest = tag[start + attr.len()..].trim_start();
            if let Some(r) = rest.strip_prefix('=') {
                let r = r.trim_start();
                if let Some(quote) = r.chars().next().filter(|c| *c == '"' || *c == '\'') {
                    let inner = &r[1..];
                    if let Some(end) = inner.find(quote) {
                        return Some(inner[..end].to_string());
                    }
                }
            }
        }
        from = start + attr.len();
    }
    None
}

fn block_range(raw: &str, open: &str, close: &str) -> Option<(usize, usize)> {
    let start = raw.find(open)?;
    let open_end = start + raw[start..].find('>')?;
    let close_start = open_end + raw[open_end..].find(close)?;
    Some((open_end + 1, close_start))
}

fn insert_before(raw: &str, pos: usize, elem: &str) -> String {
    let mut head = raw[..pos].to_string();
    if !head.ends_with('\n') {
        head.push('\n');
    }
    head.push_str("  ");
    head.push_str(elem);
    head.push('\n');
    head.push_str(&raw[pos..]);
    head
}

/// 改写或插入一个 dc:* 元素；value 为空串时写成空元素内容（保留标签）
fn set_dc_field(raw: &str, local: &str, value: &str) -> String {
    let (mstart, mend) = match block_range(raw, "<metadata", "</metadata>") {
        Some(v) => v,
        None => return raw.to_string(),
    };
    let escaped = escape_xml_text(value);

    if let Some((start, open_end, name)) = find_start_tag(raw, local, mstart, mend) {
        let self_closing = raw[start..open_end].trim_end().ends_with('/');
        if self_closing {
            let replacement = format!("<{}>{}</{}>", name, escaped, name);
            return format!("{}{}{}", &raw[..start], replacement, &raw[open_end + 1..]);
        }
        let close_tag = format!("</{}>", name);
        if let Some(rel) = raw[open_end + 1..mend].find(&close_tag) {
            let close_start = open_end + 1 + rel;
            return format!("{}{}{}", &raw[..open_end + 1], escaped, &raw[close_start..]);
        }
    }

    // 原文件没有这个元素 → 补在 </metadata> 前
    let prefix = if raw.contains("xmlns:dc") { "dc:" } else { "" };
    let elem = format!("<{}{}>{}</{}{}>", prefix, local, escaped, prefix, local);
    insert_before(raw, mend, &elem)
}

fn package_version(raw: &str) -> String {
    let start = match raw.find("<package") {
        Some(v) => v,
        None => return String::new(),
    };
    let open_end = match raw[start..].find('>') {
        Some(v) => start + v,
        None => return String::new(),
    };
    attr_value(&raw[start..=open_end], "version").unwrap_or_default()
}

/// manifest 里的封面条目 → (id, href, media-type)
fn cover_item(raw: &str) -> Option<(String, String, String)> {
    let (mstart, mend) = block_range(raw, "<manifest", "</manifest>")?;

    let mut i = mstart;
    while let Some((start, open_end, _)) = find_start_tag(raw, "item", i, mend) {
        let tag = &raw[start..=open_end];
        let is_cover = attr_value(tag, "properties")
            .map(|p| p.split_whitespace().any(|v| v == "cover-image"))
            .unwrap_or(false);
        if is_cover {
            let id = attr_value(tag, "id").unwrap_or_default();
            let href = attr_value(tag, "href").unwrap_or_default();
            let media = attr_value(tag, "media-type").unwrap_or_else(|| infer_mime_str(&href));
            return Some((id, href, media));
        }
        i = open_end + 1;
    }

    // EPUB2：<meta name="cover" content="ID"/>
    let meta_id = meta_cover_id(raw)?;
    let mut i = mstart;
    while let Some((start, open_end, _)) = find_start_tag(raw, "item", i, mend) {
        let tag = &raw[start..=open_end];
        if attr_value(tag, "id").as_deref() == Some(meta_id.as_str()) {
            let href = attr_value(tag, "href").unwrap_or_default();
            let media = attr_value(tag, "media-type").unwrap_or_else(|| infer_mime_str(&href));
            return Some((meta_id, href, media));
        }
        i = open_end + 1;
    }
    None
}

fn meta_cover_id(raw: &str) -> Option<String> {
    let (mstart, mend) = block_range(raw, "<metadata", "</metadata>")?;
    let mut i = mstart;
    while let Some((start, open_end, _)) = find_start_tag(raw, "meta", i, mend) {
        let tag = &raw[start..=open_end];
        if attr_value(tag, "name").as_deref() == Some("cover") {
            if let Some(id) = attr_value(tag, "content") {
                return Some(id);
            }
        }
        i = open_end + 1;
    }
    None
}

fn insert_manifest_item(raw: &str, id: &str, href: &str, mime: &str, epub3: bool) -> Result<String, String> {
    let pos = raw.find("</manifest>").ok_or("OPF 里没有 manifest")?;
    let props = if epub3 { r#" properties="cover-image""# } else { "" };
    let elem = format!(r#"<item id="{}" href="{}" media-type="{}"{}/>"#, id, href, mime, props);
    Ok(insert_before(raw, pos, &elem))
}

fn ensure_meta_cover(raw: &str, id: &str) -> String {
    if meta_cover_id(raw).is_some() {
        return raw.to_string();
    }
    match raw.find("</metadata>") {
        Some(pos) => insert_before(raw, pos, &format!(r#"<meta name="cover" content="{}"/>"#, id)),
        None => raw.to_string(),
    }
}

fn image_ext_mime(path: &Path) -> (String, String) {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "png" => ("png".into(), "image/png".into()),
        "webp" => ("webp".into(), "image/webp".into()),
        "gif" => ("gif".into(), "image/gif".into()),
        "svg" => ("svg".into(), "image/svg+xml".into()),
        _ => ("jpg".into(), "image/jpeg".into()),
    }
}

/// 把表单写进工作副本的 OPF（封面文件一并替换）；真正打包仍走 edit_save。
pub fn apply_metadata(
    edit_dir: &Path,
    opf_rel: &str,
    title: &str,
    creator: &str,
    language: &str,
    cover_src: Option<&Path>,
) -> Result<OpfMetadata, String> {
    let opf_abs = edit_dir.join(opf_rel);
    let mut raw = fs::read_to_string(&opf_abs).map_err(|e| format!("读 OPF 失败: {}", e))?;
    let opf_dir = match opf_rel.rfind('/') {
        Some(i) => &opf_rel[..=i],
        None => "",
    };
    let epub3 = package_version(&raw).starts_with('3');

    if let Some(src) = cover_src {
        if !src.exists() {
            return Err(format!("封面文件不存在: {}", src.display()));
        }
        // 已有封面时直接覆盖原文件本身，不改 manifest：
        // cover.xhtml / nav 里对 cover.jpg 的引用不会失效，包里也不会留下孤儿文件。
        let edit_rel = match cover_item(&raw) {
            Some((_, href, _)) if !href.is_empty() && !href.contains("..") => {
                format!("{}{}", opf_dir, href)
            }
            _ => {
                let (ext, mime) = image_ext_mime(src);
                let id = if raw.contains("id=\"cover-image\"") { "cover-image-2" } else { "cover-image" };
                let href = format!("images/cover.{}", ext);
                raw = insert_manifest_item(&raw, id, &href, &mime, epub3)?;
                if !epub3 {
                    raw = ensure_meta_cover(&raw, id);
                }
                format!("{}{}", opf_dir, href)
            }
        };
        let dest = edit_dir.join(&edit_rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let bytes = fs::read(src).map_err(|e| format!("读封面图失败: {}", e))?;
        fs::write(&dest, bytes).map_err(|e| format!("写封面图失败: {}", e))?;
    }

    raw = set_dc_field(&raw, "title", title.trim());
    raw = set_dc_field(&raw, "creator", creator.trim());
    raw = set_dc_field(&raw, "language", language.trim());

    fs::write(&opf_abs, raw.as_bytes()).map_err(|e| format!("写 OPF 失败: {}", e))?;

    let mut meta = parse_opf_metadata(raw.as_bytes())?;
    meta.cover_image = cover_item(&raw).map(|(_, href, _)| format!("{}{}", opf_dir, href));
    Ok(meta)
}

// ──────────────────────────────────────────────────────
// E3：目录树（nav.xhtml / toc.ncx）读写 / 章节改名 / 全书扫描
// ──────────────────────────────────────────────────────

/// 目录文档：nav 与 ncx 的合并视图；href 统一为「归档根相对路径」，可带 #fragment
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TocDocument {
    pub nav_path: Option<String>,
    pub ncx_path: Option<String>,
    pub tree: Vec<TocNode>,
    pub issues: Vec<String>,
}

/// 全书扫描报告
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub unused_images: Vec<String>,
    pub orphan_files: Vec<String>,
    pub duplicate_ids: Vec<String>,
    pub broken_links: Vec<String>,
    pub toc_spine_mismatch: Vec<String>,
}

fn escape_xml_attr(s: &str) -> String {
    escape_xml_text(s).replace('"', "&quot;")
}

/// 按归档根解析相对路径（处理 . / ..），不保留首尾斜杠
fn norm_join(base_dir: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if !base_dir.is_empty() {
        for p in base_dir.trim_matches('/').split('/') {
            if !p.is_empty() { parts.push(p); }
        }
    }
    for p in rel.split('/') {
        match p {
            "" | "." => {}
            ".." => { parts.pop(); }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn split_frag(href: &str) -> (&str, &str) {
    match href.split_once('#') {
        Some((p, f)) => (p, f),
        None => (href, ""),
    }
}

fn strip_frag_path(href: &str) -> String {
    split_frag(href).0.to_string()
}

fn dir_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    }
}

/// target 相对 from_dir 的路径（归档根相对 → 某目录相对）
fn rel_from_dir(target: &str, from_dir: &str) -> String {
    let t: Vec<&str> = if target.is_empty() { vec![] } else { target.split('/').collect() };
    let f: Vec<&str> = if from_dir.is_empty() { vec![] } else { from_dir.split('/').collect() };
    let mut common = 0usize;
    while common < t.len() && common < f.len() && t[common] == f[common] {
        common += 1;
    }
    let mut out = String::new();
    for _ in common..f.len() { out.push_str("../"); }
    out.push_str(&t[common..].join("/"));
    if out.is_empty() { out = ".".into(); }
    out
}

fn resolve_href(base_dir: &str, href: &str) -> String {
    let (p, frag) = split_frag(href);
    let resolved = if p.is_empty() {
        String::new()
    } else if p.starts_with('/') {
        norm_join("", p.trim_start_matches('/'))
    } else {
        norm_join(base_dir, p)
    };
    if frag.is_empty() { resolved } else { format!("{}#{}", resolved, frag) }
}

/// 属性值解析：允许带命名空间前缀（epub:type 的 local 为 type）
fn attr_value_ns(tag: &str, local: &str) -> Option<String> {
    let mut from = 0usize;
    while let Some(pos) = tag[from..].find(local) {
        let start = from + pos;
        let before = if start == 0 { b' ' } else { tag.as_bytes()[start - 1] };
        let after = tag.as_bytes().get(start + local.len()).copied().unwrap_or(b' ');
        if (before == b' ' || before == b':') && (after == b'=' || after == b' ') {
            let rest = tag[start + local.len()..].trim_start();
            if let Some(r) = rest.strip_prefix('=') {
                let r = r.trim_start();
                if let Some(q) = r.chars().next().filter(|c| *c == '"' || *c == '\'') {
                    let inner = &r[1..];
                    if let Some(end) = inner.find(q) {
                        return Some(inner[..end].to_string());
                    }
                }
            }
        }
        from = start + local.len();
    }
    None
}

/// 元素范围：返回 (开始标签起点, 内容起点, 内容终点, 结束标签之后位置)
fn element_range(raw: &str, local: &str, from: usize) -> Option<(usize, usize, usize, usize)> {
    let (start, open_end, name) = find_start_tag(raw, local, from, raw.len())?;
    let inner_start = open_end + 1;
    if raw[start..=open_end].trim_end().ends_with("/>") {
        return Some((start, inner_start, inner_start, inner_start));
    }
    let tag_local = local_name(&name).to_string();
    let mut depth = 1usize;
    let mut i = open_end + 1;
    while i + 1 < raw.len() {
        let rel = raw[i..].find('<')?;
        let s = i + rel;
        if s + 1 >= raw.len() { break; }
        let c = raw.as_bytes()[s + 1];
        let e = s + raw[s..].find('>')?;
        if c == b'!' || c == b'?' {
            i = e + 1;
            continue;
        }
        if c == b'/' {
            let head = raw[s + 2..e].trim();
            let nm = head.split_whitespace().next().unwrap_or("");
            if local_name(nm) == tag_local {
                depth -= 1;
                if depth == 0 { return Some((start, inner_start, s, e + 1)); }
            }
        } else {
            let head = &raw[s + 1..e];
            let nm = head
                .split(|ch: char| ch.is_ascii_whitespace() || ch == '/')
                .next()
                .unwrap_or("");
            let self_closing = head.trim_end().ends_with('/');
            if local_name(nm) == tag_local && !self_closing { depth += 1; }
        }
        i = e + 1;
    }
    None
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in s.chars() {
        if ch == '<' { in_tag = true; }
        else if ch == '>' { in_tag = false; }
        else if !in_tag { out.push(ch); }
    }
    xml_unescape(&out)
}

fn read_text(edit_dir: &Path, rel: &str) -> Result<String, String> {
    fs::read_to_string(edit_dir.join(rel))
        .map_err(|e| format!("读 {} 失败: {}", rel, e))
}

/// OPF manifest 全量条目 → (id, 根相对 href, media-type, properties)
fn opf_items(raw: &str, opf_dir: &str) -> Vec<(String, String, String, Option<String>)> {
    let mut out = Vec::new();
    let (mstart, mend) = match block_range(raw, "<manifest", "</manifest>") {
        Some(v) => v,
        None => return out,
    };
    let mut i = mstart;
    while let Some((start, open_end, _)) = find_start_tag(raw, "item", i, mend) {
        let tag = &raw[start..=open_end];
        let id = attr_value(tag, "id").unwrap_or_default();
        let href = attr_value(tag, "href").unwrap_or_default();
        if !id.is_empty() && !href.is_empty() {
            out.push((
                id,
                resolve_href(opf_dir, &href),
                attr_value(tag, "media-type").unwrap_or_default(),
                attr_value(tag, "properties"),
            ));
        }
        i = open_end + 1;
    }
    out
}

fn toc_paths(opf_raw: &str, opf_dir: &str) -> (Option<String>, Option<String>) {
    let items = opf_items(opf_raw, opf_dir);
    let mut nav = None;
    let mut ncx = None;
    for (_, href, media, props) in items {
        if props
            .as_deref()
            .map(|p| p.split_whitespace().any(|t| t == "nav"))
            .unwrap_or(false)
        {
            nav = Some(href.clone());
        }
        if media == "application/x-dtbncx+xml" || href.ends_with(".ncx") {
            ncx = Some(href);
        }
    }
    (nav, ncx)
}

// ── 目录解析 ──

fn parse_nav_tree(raw: &str, nav_dir: &str) -> Option<Vec<TocNode>> {
    let mut i = 0usize;
    while let Some((start, open_end, _)) = find_start_tag(raw, "nav", i, raw.len()) {
        let tag = &raw[start..=open_end];
        let is_toc = attr_value_ns(tag, "type")
            .map(|v| v.split_whitespace().any(|t| t == "toc"))
            .unwrap_or(false);
        if is_toc {
            let (_, inner_s, inner_e, _) = element_range(raw, "nav", start)?;
            let (ol_s, ol_oe, _) = find_start_tag(raw, "ol", inner_s, inner_e)?;
            let (_, oi_s, oi_e, _) = element_range(raw, "ol", ol_s)?;
            let _ = ol_oe;
            return Some(parse_li_list(raw, oi_s, oi_e, nav_dir));
        }
        i = open_end + 1;
    }
    None
}

fn parse_li_list(raw: &str, from: usize, to: usize, base_dir: &str) -> Vec<TocNode> {
    let mut items = Vec::new();
    let mut i = from;
    while let Some((s, _oe, _)) = find_start_tag(raw, "li", i, to) {
        let (_, in_s, in_e, end) = match element_range(raw, "li", s) {
            Some(v) => v,
            None => break,
        };
        let mut label = String::new();
        let mut href = String::new();

        // 子列表起点：用于把 <a>/<span> 的扫描范围限制在嵌套列表之前
        let ol_pos = find_start_tag(raw, "ol", in_s, in_e).map(|(p, _, _)| p);
        let head_end = ol_pos.unwrap_or(in_e);

        if let Some((a_s, a_oe, _)) = find_start_tag(raw, "a", in_s, head_end) {
            if let Some(h) = attr_value(&raw[a_s..=a_oe], "href") {
                href = resolve_href(base_dir, &h);
            }
            let (_, ai_s, ai_e, _) = element_range(raw, "a", a_s)
                .unwrap_or((a_s, a_oe + 1, a_oe + 1, a_oe + 1));
            label = strip_tags(&raw[ai_s..ai_e]).trim().to_string();
        }
        if label.is_empty() {
            if let Some((sp_s, sp_oe, _)) = find_start_tag(raw, "span", in_s, head_end) {
                let (_, si_s, si_e, _) = element_range(raw, "span", sp_s)
                    .unwrap_or((sp_s, sp_oe + 1, sp_oe + 1, sp_oe + 1));
                label = strip_tags(&raw[si_s..si_e]).trim().to_string();
            }
        }
        if label.is_empty() {
            label = strip_tags(&raw[in_s..head_end]).trim().to_string();
        }

        let mut children = Vec::new();
        if let Some((ol_s, _ol_oe, _)) = find_start_tag(raw, "ol", in_s, in_e) {
            if let Some((_, oi_s, oi_e, _)) = element_range(raw, "ol", ol_s) {
                children = parse_li_list(raw, oi_s, oi_e, base_dir);
            }
        }

        items.push(TocNode { label, href, children });
        i = end;
    }
    items
}

fn parse_ncx_tree(raw: &str, ncx_dir: &str) -> Option<Vec<TocNode>> {
    let (nm_s, nm_oe, _) = find_start_tag(raw, "navMap", 0, raw.len())?;
    let (_, inner_s, inner_e, _) = element_range(raw, "navMap", nm_s)?;
    let _ = nm_oe;
    Some(parse_navpoints(raw, inner_s, inner_e, ncx_dir))
}

fn parse_navpoints(raw: &str, from: usize, to: usize, base_dir: &str) -> Vec<TocNode> {
    let mut items = Vec::new();
    let mut i = from;
    while let Some((s, _oe, _)) = find_start_tag(raw, "navPoint", i, to) {
        let (_, in_s, in_e, end) = match element_range(raw, "navPoint", s) {
            Some(v) => v,
            None => break,
        };
        let child_pos = find_start_tag(raw, "navPoint", in_s, in_e).map(|(p, _, _)| p);
        let head_end = child_pos.unwrap_or(in_e);

        let mut label = String::new();
        if let Some((lb_s, lb_oe, _)) = find_start_tag(raw, "navLabel", in_s, head_end) {
            let (_, li_s, li_e, _) = element_range(raw, "navLabel", lb_s)
                .unwrap_or((lb_s, lb_oe + 1, lb_oe + 1, lb_oe + 1));
            if let Some((t_s, t_oe, _)) = find_start_tag(raw, "text", li_s, li_e) {
                let (_, ti_s, ti_e, _) = element_range(raw, "text", t_s)
                    .unwrap_or((t_s, t_oe + 1, t_oe + 1, t_oe + 1));
                label = strip_tags(&raw[ti_s..ti_e]).trim().to_string();
            }
        }

        let mut href = String::new();
        if let Some((c_s, c_oe, _)) = find_start_tag(raw, "content", in_s, head_end) {
            if let Some(src) = attr_value(&raw[c_s..=c_oe], "src") {
                href = resolve_href(base_dir, &src);
            }
        }

        let children = if child_pos.is_some() {
            parse_navpoints(raw, child_pos.unwrap(), in_e, base_dir)
        } else {
            Vec::new()
        };
        items.push(TocNode { label, href, children });
        i = end;
    }
    items
}

// ── 目录写回 ──

fn first_descendant_href(node: &TocNode) -> Option<String> {
    if !node.href.is_empty() { return Some(node.href.clone()); }
    for c in &node.children {
        if let Some(h) = first_descendant_href(c) { return Some(h); }
    }
    None
}

fn toc_href_attr(href: &str, base_dir: &str) -> String {
    let (p, frag) = split_frag(href);
    let rel = if p.is_empty() { String::new() } else { rel_from_dir(p, base_dir) };
    let mut s = rel;
    if !frag.is_empty() { s.push('#'); s.push_str(frag); }
    escape_xml_attr(&s)
}

fn render_nav_items(items: &[TocNode], base_dir: &str, depth: usize) -> String {
    let pad = "  ".repeat(depth);
    let mut s = String::new();
    for it in items {
        let label = escape_xml_text(&it.label);
        if it.children.is_empty() {
            if it.href.is_empty() {
                s.push_str(&format!("\n{}<li><span>{}</span></li>", pad, label));
            } else {
                s.push_str(&format!(
                    "\n{}<li><a href=\"{}\">{}</a></li>",
                    pad,
                    toc_href_attr(&it.href, base_dir),
                    label
                ));
            }
        } else {
            let head = if it.href.is_empty() {
                format!("<span>{}</span>", label)
            } else {
                format!("<a href=\"{}\">{}</a>", toc_href_attr(&it.href, base_dir), label)
            };
            s.push_str(&format!("\n{}<li>{}", pad, head));
            s.push_str(&format!("\n{}  <ol>", pad));
            s.push_str(&render_nav_items(&it.children, base_dir, depth + 2));
            s.push_str(&format!("\n{}  </ol>\n{}</li>", pad, pad));
        }
    }
    s
}

fn nav_depth(items: &[TocNode]) -> usize {
    items
        .iter()
        .map(|n| 1 + nav_depth(&n.children))
        .max()
        .unwrap_or(0)
}

fn write_nav(raw: &str, tree: &[TocNode], nav_dir: &str) -> Result<String, String> {
    let mut i = 0usize;
    let mut nav_inner: Option<(usize, usize)> = None;
    while let Some((start, open_end, _)) = find_start_tag(raw, "nav", i, raw.len()) {
        let tag = &raw[start..=open_end];
        let is_toc = attr_value_ns(tag, "type")
            .map(|v| v.split_whitespace().any(|t| t == "toc"))
            .unwrap_or(false);
        if is_toc {
            if let Some((_, s, e, _)) = element_range(raw, "nav", start) {
                nav_inner = Some((s, e));
            }
            break;
        }
        i = open_end + 1;
    }
    let (inner_s, inner_e) = nav_inner.ok_or("nav.xhtml 里没有 epub:type=\"toc\" 的 nav")?;
    let (ol_s, _ol_oe, _) = find_start_tag(raw, "ol", inner_s, inner_e)
        .ok_or("目录 nav 里没有 <ol>")?;
    let (_, oi_s, oi_e, _) = element_range(raw, "ol", ol_s).ok_or("目录 <ol> 结构异常")?;
    let body = render_nav_items(tree, nav_dir, 2);
    Ok(format!("{}{}\n  {}", &raw[..oi_s], body, &raw[oi_e..]))
}

fn render_ncx_points(items: &[TocNode], base_dir: &str, depth: usize, counter: &mut u32) -> String {
    let pad = "  ".repeat(depth + 1);
    let mut s = String::new();
    for it in items {
        let target = match first_descendant_href(it) {
            Some(h) => h,
            None => continue,
        };
        *counter += 1;
        let n = *counter;
        let label = escape_xml_text(&it.label);
        // 不写 playOrder：分组节点的 content 会与首个同目标子项重复，
        // 同目标不同 playOrder 会被 epubcheck 判为错误（RSC-005）。
        s.push_str(&format!("\n{}<navPoint id=\"navpoint-{}\">", pad, n));
        s.push_str(&format!("\n{}  <navLabel><text>{}</text></navLabel>", pad, label));
        s.push_str(&format!(
            "\n{}  <content src=\"{}\"/>",
            pad,
            toc_href_attr(&target, base_dir)
        ));
        if !it.children.is_empty() {
            s.push_str(&render_ncx_points(&it.children, base_dir, depth + 1, counter));
            s.push_str(&format!("\n{}</navPoint>", pad));
        } else {
            s.push_str(&format!("\n{}</navPoint>", pad));
        }
    }
    s
}

fn write_ncx(raw: &str, tree: &[TocNode], ncx_dir: &str) -> Result<String, String> {
    let (nm_s, _nm_oe, _) = find_start_tag(raw, "navMap", 0, raw.len())
        .ok_or("toc.ncx 里没有 navMap")?;
    let (_, inner_s, inner_e, _) = element_range(raw, "navMap", nm_s).ok_or("navMap 结构异常")?;
    let mut counter = 0u32;
    let body = render_ncx_points(tree, ncx_dir, 0, &mut counter);
    let mut out = format!("{}{}\n  {}", &raw[..inner_s], body, &raw[inner_e..]);
    let depth = nav_depth(tree).to_string();
    out = set_meta_content(&out, "dtb:depth", &depth);
    Ok(out)
}

/// 改 `<meta name="X" content="Y">` 的 content；没有则不动
fn set_meta_content(raw: &str, name: &str, value: &str) -> String {
    let mut i = 0usize;
    while let Some((s, oe, _)) = find_start_tag(raw, "meta", i, raw.len()) {
        let tag = &raw[s..=oe];
        if attr_value(tag, "name").as_deref() == Some(name) {
            if let Some(pos) = tag.find("content=\"") {
                let vs = s + pos + 9;
                if let Some(rel) = raw[vs..].find('"') {
                    let ve = vs + rel;
                    return format!("{}{}{}", &raw[..vs], value, &raw[ve..]);
                }
            }
        }
        i = oe + 1;
    }
    raw.to_string()
}

/// spine 顺序按目录顺序重排：目录外条目保持原顺序在前，目录内条目按目录出现顺序
fn sync_spine(raw: &str, opf_dir: &str, toc_hrefs: &[String]) -> String {
    let mut id_to_path: HashMap<String, String> = HashMap::new();
    for (id, href, _, _) in opf_items(raw, opf_dir) {
        id_to_path.insert(id, href);
    }
    let (sstart, send) = match block_range(raw, "<spine", "</spine>") {
        Some(v) => v,
        None => return raw.to_string(),
    };
    let mut itemrefs: Vec<(String, String)> = Vec::new();
    let mut j = sstart;
    while let Some((s, oe, _)) = find_start_tag(raw, "itemref", j, send) {
        let tag = raw[s..=oe].to_string();
        let idref = attr_value(&tag, "idref").unwrap_or_default();
        itemrefs.push((idref, tag));
        j = oe + 1;
    }
    if itemrefs.is_empty() { return raw.to_string(); }

    let targets: HashSet<String> = toc_hrefs.iter().map(|h| strip_frag_path(h)).collect();
    let mut ordered: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for (idref, _) in &itemrefs {
        let p = id_to_path.get(idref).cloned().unwrap_or_default();
        if !targets.contains(&p) && seen.insert(idref.clone()) {
            ordered.push(idref.clone());
        }
    }
    let mut path_to_idref: HashMap<String, String> = HashMap::new();
    for (idref, _) in &itemrefs {
        if let Some(p) = id_to_path.get(idref) {
            path_to_idref.insert(p.clone(), idref.clone());
        }
    }
    for h in toc_hrefs {
        let key = strip_frag_path(h);
        if let Some(idref) = path_to_idref.get(&key) {
            if seen.insert(idref.clone()) {
                ordered.push(idref.clone());
            }
        }
    }
    for (idref, _) in &itemrefs {
        if seen.insert(idref.clone()) {
            ordered.push(idref.clone());
        }
    }

    let mut body = String::new();
    for idref in &ordered {
        if let Some((_, tag)) = itemrefs.iter().find(|(i, _)| i == idref) {
            body.push_str("\n    ");
            body.push_str(tag);
        }
    }
    format!("{}{}\n  {}", &raw[..sstart], body, &raw[send..])
}

fn collect_hrefs(tree: &[TocNode], out: &mut Vec<String>) {
    for n in tree {
        if !n.href.is_empty() { out.push(n.href.clone()); }
        collect_hrefs(&n.children, out);
    }
}

fn trees_equal(a: &[TocNode], b: &[TocNode]) -> bool {
    if a.len() != b.len() { return false; }
    for (x, y) in a.iter().zip(b.iter()) {
        if x.label.trim() != y.label.trim() { return false; }
        // 分组节点在 nav 里没有链接，ncx 又必须有 content src，这里只比两者都有 href 的情况
        if !x.href.is_empty() && !y.href.is_empty()
            && strip_frag_path(&x.href) != strip_frag_path(&y.href) { return false; }
        if !trees_equal(&x.children, &y.children) { return false; }
    }
    true
}

/// 读取目录（nav 优先，ncx 兜底）
pub fn read_toc(edit_dir: &Path, opf_rel: &str) -> Result<TocDocument, String> {
    let opf_raw = read_text(edit_dir, opf_rel)?;
    let opf_dir = dir_of(opf_rel);
    let (nav_path, ncx_path) = toc_paths(&opf_raw, opf_dir);
    let mut issues = Vec::new();
    let mut tree: Vec<TocNode> = Vec::new();

    if let Some(nav) = &nav_path {
        let raw = read_text(edit_dir, nav)?;
        match parse_nav_tree(&raw, dir_of(nav)) {
            Some(t) => tree = t,
            None => issues.push(format!("{} 里没有找到 epub:type=\"toc\" 的目录", nav)),
        }
    }
    if tree.is_empty() {
        if let Some(ncx) = &ncx_path {
            let raw = read_text(edit_dir, ncx)?;
            match parse_ncx_tree(&raw, dir_of(ncx)) {
                Some(t) => {
                    tree = t;
                    if nav_path.is_some() { issues.push("nav.xhtml 目录为空，已用 toc.ncx 兜底".into()); }
                }
                None => issues.push("toc.ncx 里没有找到 navMap".into()),
            }
        }
    }
    if nav_path.is_none() { issues.push("manifest 里没有 properties=\"nav\" 的目录文件".into()); }
    if ncx_path.is_none() { issues.push("manifest 里没有 toc.ncx（EPUB2 阅读器兼容会缺失）".into()); }

    Ok(TocDocument { nav_path, ncx_path, tree, issues })
}

/// 写回目录（nav + ncx 同步重建，可选重排 spine）
pub fn write_toc(
    edit_dir: &Path,
    opf_rel: &str,
    tree: &[TocNode],
    sync_spine_order: bool,
) -> Result<TocDocument, String> {
    let opf_raw = read_text(edit_dir, opf_rel)?;
    let opf_dir = dir_of(opf_rel);
    let (nav_path, ncx_path) = toc_paths(&opf_raw, opf_dir);
    if nav_path.is_none() && ncx_path.is_none() {
        return Err("这本书既没有 nav.xhtml 也没有 toc.ncx，无法写回目录".into());
    }

    if let Some(nav) = &nav_path {
        let raw = read_text(edit_dir, nav)?;
        let out = write_nav(&raw, tree, dir_of(nav))?;
        fs::write(edit_dir.join(nav), out).map_err(|e| format!("写 {} 失败: {}", nav, e))?;
    }
    if let Some(ncx) = &ncx_path {
        let raw = read_text(edit_dir, ncx)?;
        let out = write_ncx(&raw, tree, dir_of(ncx))?;
        fs::write(edit_dir.join(ncx), out).map_err(|e| format!("写 {} 失败: {}", ncx, e))?;
    }
    if sync_spine_order {
        let mut hrefs = Vec::new();
        collect_hrefs(tree, &mut hrefs);
        let out = sync_spine(&opf_raw, opf_dir, &hrefs);
        fs::write(edit_dir.join(opf_rel), out).map_err(|e| format!("写 OPF 失败: {}", e))?;
    }

    let mut doc = read_toc(edit_dir, opf_rel)?;

    // 自检：nav / ncx 结构一致
    if let (Some(nav), Some(ncx)) = (&doc.nav_path, &doc.ncx_path) {
        let nav_tree = parse_nav_tree(&read_text(edit_dir, nav)?, dir_of(nav));
        let ncx_tree = parse_ncx_tree(&read_text(edit_dir, ncx)?, dir_of(ncx));
        match (nav_tree, ncx_tree) {
            (Some(a), Some(b)) => {
                if !trees_equal(&a, &b) {
                    doc.issues.push("nav 与 ncx 结构不一致（条目数/层级/顺序不同）".into());
                }
            }
            _ => doc.issues.push("nav 或 ncx 解析失败".into()),
        }
    }
    Ok(doc)
}

// ── 章节改名 / 移动：全库相对链接同步 ──

fn rewrite_link_value(val: &str, from: &str, to: &str, dir: &str) -> Option<String> {
    let (p, frag) = split_frag(val);
    if p.is_empty()
        || p.starts_with("http:")
        || p.starts_with("https:")
        || p.starts_with("mailto:")
        || p.starts_with("data:")
        || p.starts_with("tel:")
    {
        return None;
    }
    let resolved = if p.starts_with('/') {
        norm_join("", p.trim_start_matches('/'))
    } else {
        norm_join(dir, p)
    };
    if resolved != from { return None; }
    let mut s = rel_from_dir(to, dir);
    if !frag.is_empty() { s.push('#'); s.push_str(frag); }
    Some(s)
}

fn rewrite_tag_hrefs(raw: &str, from: &str, to: &str, dir: &str) -> (String, bool) {
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for (pat, q) in [("href=\"", '"'), ("href='", '\''), ("src=\"", '"'), ("src='", '\'')] {
        let mut idx = 0usize;
        while let Some(p) = raw[idx..].find(pat) {
            let vs = idx + p + pat.len();
            if let Some(rel) = raw[vs..].find(q) {
                let ve = vs + rel;
                if let Some(newv) = rewrite_link_value(&raw[vs..ve], from, to, dir) {
                    edits.push((vs, ve, newv));
                }
                idx = ve + 1;
            } else {
                break;
            }
        }
    }
    if edits.is_empty() { return (raw.to_string(), false); }
    edits.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = String::with_capacity(raw.len());
    let mut last = 0usize;
    for (s, e, v) in edits {
        if s < last { continue; }
        out.push_str(&raw[last..s]);
        out.push_str(&v);
        last = e;
    }
    out.push_str(&raw[last..]);
    (out, true)
}

/// 重命名/移动工作副本内的文件，并同步 OPF/nav/ncx/书内相对链接
pub fn rename_file(
    edit_dir: &Path,
    opf_rel: &str,
    from: &str,
    to: &str,
) -> Result<Vec<String>, String> {
    let from = from.replace('\\', "/").trim_start_matches('/').to_string();
    let to = to.replace('\\', "/").trim_start_matches('/').to_string();
    if from.is_empty() || to.is_empty() { return Err("源路径或目标路径为空".into()); }
    if from.contains("..") || to.contains("..") { return Err("路径不允许包含 ..".into()); }

    let src = edit_dir.join(&from);
    if !src.is_file() { return Err(format!("源文件不存在: {}", from)); }
    let dst = edit_dir.join(&to);
    if dst.exists() { return Err(format!("目标文件已存在: {}", to)); }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&src, &dst).map_err(|e| format!("重命名失败: {}", e))?;

    // 遍历所有文本文件改写引用（含 OPF / nav / ncx / 章节 / CSS）
    let mut changed = Vec::new();
    let mut files = Vec::new();
    walk_any_collect(edit_dir, edit_dir, &mut files);
    for rel in files {
        let lower = rel.to_lowercase();
        let is_text = [".xhtml", ".html", ".htm", ".opf", ".ncx", ".xml", ".css", ".smil"]
            .iter()
            .any(|ext| lower.ends_with(ext));
        if !is_text { continue; }
        let path = edit_dir.join(&rel);
        let raw = match fs::read_to_string(&path) { Ok(v) => v, Err(_) => continue };
        let (out, did) = rewrite_tag_hrefs(&raw, &from, &to, dir_of(&rel));
        if did {
            fs::write(&path, out).map_err(|e| format!("写 {} 失败: {}", rel, e))?;
            changed.push(rel);
        }
    }
    let _ = opf_rel;

    // 刷新 _index.json 里的路径（否则前端文件树仍显示旧名）
    let index_path = edit_dir.join("_index.json");
    if index_path.exists() {
        if let Ok(bytes) = fs::read(&index_path) {
            if let Ok(mut list) = serde_json::from_slice::<Vec<EntryInfo>>(&bytes) {
                for e in list.iter_mut() {
                    if e.path == from { e.path = to.clone(); }
                }
                if let Ok(json) = serde_json::to_string_pretty(&list) {
                    let _ = fs::write(&index_path, json);
                }
            }
        }
    }
    Ok(changed)
}

fn walk_any_collect(base: &Path, dir: &Path, out: &mut Vec<String>) {
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if let Some(n) = path.file_name() {
                if n == "_index.json" || n == "_blocks.json" { continue; }
            }
            if path.is_dir() {
                walk_any_collect(base, &path, out);
            } else if let Ok(rel) = path.strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

// ── 全书扫描报告 ──

fn collect_ref_paths(raw: &str, dir: &str, out: &mut HashSet<String>) {
    for (pat, q) in [("href=\"", '"'), ("href='", '\''), ("src=\"", '"'), ("src='", '\'')] {
        let mut idx = 0usize;
        while let Some(p) = raw[idx..].find(pat) {
            let vs = idx + p + pat.len();
            if let Some(rel) = raw[vs..].find(q) {
                let ve = vs + rel;
                let val = &raw[vs..ve];
                let (path, _) = split_frag(val);
                if !path.is_empty()
                    && !path.starts_with("http:")
                    && !path.starts_with("https:")
                    && !path.starts_with("mailto:")
                    && !path.starts_with("data:")
                {
                    let resolved = if path.starts_with('/') {
                        norm_join("", path.trim_start_matches('/'))
                    } else {
                        norm_join(dir, path)
                    };
                    if !resolved.is_empty() { out.insert(resolved); }
                }
                idx = ve + 1;
            } else {
                break;
            }
        }
    }
}

/// 全书扫描：未使用图片 / 孤儿文件 / 重复 id / 断链 / 目录与 spine 不一致
pub fn scan_report(edit_dir: &Path, opf_rel: &str) -> Result<ScanReport, String> {
    let opf_raw = read_text(edit_dir, opf_rel)?;
    let opf_dir = dir_of(opf_rel);
    let items = opf_items(&opf_raw, opf_dir);
    let (nav_path, ncx_path) = toc_paths(&opf_raw, opf_dir);

    let mut refs: HashSet<String> = HashSet::new();
    refs.insert("mimetype".into());
    refs.insert("META-INF/container.xml".into());
    refs.insert(opf_rel.replace('\\', "/"));
    for (_, href, _, _) in &items { refs.insert(strip_frag_path(href)); }
    if let Some(n) = &nav_path { refs.insert(n.clone()); }
    if let Some(n) = &ncx_path { refs.insert(n.clone()); }

    // spine 引用
    if let Some((sstart, send)) = block_range(&opf_raw, "<spine", "</spine>") {
        let mut i = sstart;
        while let Some((s, oe, _)) = find_start_tag(&opf_raw, "itemref", i, send) {
            if let Some(idref) = attr_value(&opf_raw[s..=oe], "idref") {
                if let Some((_, href, _, _)) = items.iter().find(|(id, _, _, _)| *id == idref) {
                    refs.insert(strip_frag_path(href));
                }
            }
            i = oe + 1;
        }
    }

    // 所有文本文件里的引用
    let mut files = Vec::new();
    walk_any_collect(edit_dir, edit_dir, &mut files);
    let mut link_refs: HashSet<String> = HashSet::new();
    for rel in &files {
        let lower = rel.to_lowercase();
        if !([".xhtml", ".html", ".htm", ".css", ".smil"].iter().any(|e| lower.ends_with(e))) {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(edit_dir.join(rel)) {
            collect_ref_paths(&raw, dir_of(rel), &mut link_refs);
            refs.extend(link_refs.iter().cloned());
        }
    }

    // 未使用图片：manifest 图片既非封面、也无人引用
    let mut unused_images = Vec::new();
    for (id, href, media, props) in &items {
        let is_img = media.starts_with("image/");
        if !is_img { continue; }
        let is_cover = props
            .as_deref()
            .map(|p| p.split_whitespace().any(|t| t == "cover-image"))
            .unwrap_or(false);
        if is_cover { continue; }
        let path = strip_frag_path(href);
        if !link_refs.contains(&path) {
            unused_images.push(format!("{} ({})", path, id));
        }
    }

    // 孤儿文件：磁盘上有、manifest 里没有
    let mut manifest_paths: HashSet<String> = HashSet::new();
    for (_, href, _, _) in &items { manifest_paths.insert(strip_frag_path(href)); }
    let mut orphan_files = Vec::new();
    for rel in &files {
        if rel == &opf_rel.replace('\\', "/")
            || rel == "mimetype"
            || rel.starts_with("META-INF/")
        {
            continue;
        }
        if !manifest_paths.contains(rel) {
            orphan_files.push(rel.clone());
        }
    }

    // 重复 id：manifest id + 每个文件内 HTML id
    let mut duplicate_ids = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (id, _, _, _) in &items {
        if !seen.insert(id.clone()) {
            duplicate_ids.push(format!("manifest: id=\"{}\" 重复", id));
        }
    }
    for rel in &files {
        let lower = rel.to_lowercase();
        if !([".xhtml", ".html", ".htm"].iter().any(|e| lower.ends_with(e))) { continue; }
        let raw = match fs::read_to_string(edit_dir.join(rel)) { Ok(v) => v, Err(_) => continue };
        let mut local: HashSet<String> = HashSet::new();
        let mut idx = 0usize;
        while let Some(p) = raw[idx..].find(" id=\"") {
            let vs = idx + p + 5;
            if let Some(rel2) = raw[vs..].find('"') {
                let ve = vs + rel2;
                let val = raw[vs..ve].to_string();
                if !local.insert(val.clone()) {
                    duplicate_ids.push(format!("{}: id=\"{}\" 重复", rel, val));
                }
                idx = ve + 1;
            } else { break; }
        }
    }

    // 断链：文件里引用但磁盘不存在（只报文本类引用）
    let mut broken_links = Vec::new();
    for r in &link_refs {
        if !edit_dir.join(r).exists() {
            broken_links.push(r.clone());
        }
    }

    // 目录与 spine 顺序不一致
    let mut toc_spine_mismatch = Vec::new();
    if let Some(nav) = &nav_path {
        if let Ok(raw) = read_text(edit_dir, nav) {
            if let Some(tree) = parse_nav_tree(&raw, dir_of(nav)) {
                let mut spine_paths = Vec::new();
                if let Some((sstart, send)) = block_range(&opf_raw, "<spine", "</spine>") {
                    let mut i = sstart;
                    while let Some((s, oe, _)) = find_start_tag(&opf_raw, "itemref", i, send) {
                        if let Some(idref) = attr_value(&opf_raw[s..=oe], "idref") {
                            if let Some((_, href, _, _)) = items.iter().find(|(id, _, _, _)| *id == idref) {
                                spine_paths.push(strip_frag_path(href));
                            }
                        }
                        i = oe + 1;
                    }
                }
                let mut toc_paths_seq = Vec::new();
                collect_hrefs(&tree, &mut toc_paths_seq);
                let toc_seq: Vec<String> = toc_paths_seq.iter().map(|h| strip_frag_path(h)).collect();
                let mut pos = 0usize;
                for sp in &spine_paths {
                    if !toc_seq.contains(sp) { continue; }
                    if let Some(found) = toc_seq[pos..].iter().position(|t| t == sp) {
                        if found > 0 {
                            toc_spine_mismatch.push(format!(
                                "{} 在目录中先于 spine 前一章出现",
                                sp
                            ));
                        }
                        pos += found + 1;
                    } else {
                        toc_spine_mismatch.push(format!("目录顺序与 spine 不一致: {}", sp));
                    }
                }
            }
        }
    }

    Ok(ScanReport {
        unused_images,
        orphan_files,
        duplicate_ids,
        broken_links,
        toc_spine_mismatch,
    })
}

// ──────────────────────────────────────────────────────
// E6：块级结构化编辑（只回写改动块，未改动块逐字节保留）
// ──────────────────────────────────────────────────────

/// 一个可编辑块在源文件里的字节区间。start/end 是元素整体，
/// innerStart/innerEnd 是开始标签之后到结束标签之前。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlockInfo {
    pub index: usize,
    pub tag: String,
    pub start: usize,
    pub inner_start: usize,
    pub inner_end: usize,
    pub end: usize,
    pub self_closing: bool,
}

/// 来自前端的块改动：只带 dirty 块。
/// `inner` 为新 innerHTML（已做白名单与 XML 序列化），`tag` 用于改标题级别，
/// `delete` 用于删除整段。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BlockEdit {
    pub index: usize,
    #[serde(default)]
    pub inner: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub delete: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlockWriteResult {
    pub replaced: usize,
    pub deleted: usize,
    pub total: usize,
    pub bytes_before: usize,
    pub bytes_after: usize,
}

/// 允许被写入的块标签（前端只暴露 p / h1–h6）
const BLOCK_TAGS: [&str; 10] = [
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "div", "blockquote", "li",
];

/// 单层包裹容器：新书生成器会把整章包在 <section> 里，
/// 可视化编辑应把它的直接子元素当作块。
const WRAPPER_TAGS: [&str; 3] = ["section", "div", "article"];

/// 找开始标签的 `>`，跳过引号内的 `>`。
fn tag_end(raw: &str, start: usize, to: usize) -> Option<usize> {
    let bytes = raw.as_bytes();
    let mut quote: Option<u8> = None;
    let mut i = start + 1;
    while i < to {
        let b = bytes[i];
        match quote {
            Some(q) => {
                if b == q {
                    quote = None;
                }
            }
            None => {
                if b == b'"' || b == b'\'' {
                    quote = Some(b);
                } else if b == b'>' {
                    return Some(i);
                }
            }
        }
        i += 1;
    }
    None
}

/// 从 from..to 里按源码顺序收集直接子元素（跳过注释 / PI / 文本）
fn collect_child_elements(raw: &str, from: usize, to: usize) -> Vec<(usize, usize, usize, usize, String, bool)> {
    let mut out = Vec::new();
    let bytes = raw.as_bytes();
    let mut i = from;
    while i + 1 < to {
        let rel = match raw[i..to].find('<') {
            Some(v) => v,
            None => break,
        };
        let s = i + rel;
        if s + 1 >= to {
            break;
        }
        let c = bytes[s + 1];
        if c == b'!' || c == b'?' {
            let e = match tag_end(raw, s, to) {
                Some(v) => v,
                None => break,
            };
            i = e + 1;
            continue;
        }
        if c == b'/' {
            let e = match tag_end(raw, s, to) {
                Some(v) => v,
                None => break,
            };
            i = e + 1;
            continue;
        }
        // 开始标签
        let open_end = match tag_end(raw, s, to) {
            Some(v) => v,
            None => break,
        };
        let head = &raw[s + 1..open_end];
        let name_end = head
            .find(|ch: char| ch.is_ascii_whitespace() || ch == '/')
            .unwrap_or(head.len());
        let name = &head[..name_end];
        let local = local_name(name).to_string();
        let self_closing = head.trim_end().ends_with('/');
        let inner_start = open_end + 1;
        if self_closing {
            out.push((s, inner_start, inner_start, open_end + 1, local, true));
            i = open_end + 1;
            continue;
        }
        match element_range(raw, &local, s) {
            Some((st, ins, ine, end)) => {
                out.push((st, ins, ine, end, local.clone(), false));
                i = end.max(open_end + 1);
            }
            None => {
                // 结构异常：交给后续 XML 校验报错，这里先跳过这段
                break;
            }
        }
    }
    out
}

/// 空锚点 <a id="x"></a> 不是正文块，扫描时跳过（与前端保持一致）
fn is_anchor_only(raw: &str, tag: &str, inner_start: usize, inner_end: usize) -> bool {
    if tag != "a" {
        return false;
    }
    let inner = &raw[inner_start..inner_end];
    !inner.contains('<') && inner.trim().is_empty()
}

/// 计算可编辑块列表（body 的直接子元素；单层 section/div/article 时下钻一层）
pub fn scan_blocks_raw(raw: &str) -> Result<Vec<BlockInfo>, String> {
    let body_start = find_start_tag(raw, "body", 0, raw.len())
        .ok_or("这个文件没有 <body>")?
        .0;
    let (_, body_inner_start, body_inner_end, _) =
        element_range(raw, "body", body_start).ok_or("body 结构异常")?;

    let mut children = collect_child_elements(raw, body_inner_start, body_inner_end);
    if children.len() == 1 {
        let (_cs, cis, cie, _ce, ctag, cself) = &children[0];
        if !*cself
            && WRAPPER_TAGS.contains(&ctag.as_str())
            && (cie > cis)
            && !is_anchor_only(raw, ctag, *cis, *cie)
        {
            let inner = collect_child_elements(raw, *cis, *cie);
            if !inner.is_empty() {
                children = inner;
            }
        }
    }

    let mut blocks = Vec::new();
    for (start, inner_start, inner_end, end, tag, self_closing) in children {
        if is_anchor_only(raw, &tag, inner_start, inner_end) {
            continue;
        }
        blocks.push(BlockInfo {
            index: blocks.len(),
            tag,
            start,
            inner_start,
            inner_end,
            end,
            self_closing,
        });
    }
    if blocks.is_empty() {
        return Err("这个文件没有可分块的正文".into());
    }
    Ok(blocks)
}

/// 把开始/结束标签里的元素名换成新标签（保留所有属性）
fn replace_tag_name(tag_raw: &str, new_name: &str) -> String {
    let bytes = tag_raw.as_bytes();
    let mut i = 1usize; // 跳过 '<'
    if i < bytes.len() && bytes[i] == b'/' {
        i += 1;
    }
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    let name_start = i;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_whitespace() || b == b'/' || b == b'>' {
            break;
        }
        i += 1;
    }
    if name_start >= i {
        return tag_raw.to_string();
    }
    format!("{}{}{}", &tag_raw[..name_start], new_name, &tag_raw[i..])
}

/// 删除块时连带所在行的缩进与一个换行，避免留下空洞；
/// 其余块的字节不受影响。
fn delete_range(raw: &str, start: usize, end: usize) -> (usize, usize) {
    let line_start = raw[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let indent_only = raw[line_start..start]
        .chars()
        .all(|c| c == ' ' || c == '\t' || c == '\r');
    let s = if indent_only { line_start } else { start };
    let mut e = end;
    if raw[e..].starts_with("\r\n") {
        e += 2;
    } else if raw[e..].starts_with('\n') {
        e += 1;
    }
    (s, e)
}

/// XML 合法性校验（well-formedness）。新增/改动的 inner 必须是合法片段。
fn validate_xml(raw: &str) -> Result<(), String> {
    let mut reader = quick_xml::Reader::from_str(raw);
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Eof) => break,
            Ok(_) => {}
            Err(e) => return Err(format!("XML 不合法：{}（位置 {}）", e, reader.buffer_position())),
        }
    }
    Ok(())
}

/// 应用块改动（纯函数，便于单测）：从后往前拼接，未改动块逐字节保留。
pub fn apply_block_edits(raw: &str, edits: &[BlockEdit]) -> Result<(String, usize, usize), String> {
    let blocks = scan_blocks_raw(raw)?;
    let total = blocks.len();
    if edits.is_empty() {
        return Ok((raw.to_string(), 0, 0));
    }

    let mut seen = HashSet::new();
    let mut actions: Vec<(usize, usize, String)> = Vec::new();
    let mut replaced = 0usize;
    let mut deleted = 0usize;

    for edit in edits {
        if !seen.insert(edit.index) {
            return Err(format!("块 {} 重复提交", edit.index + 1));
        }
        let info = blocks
            .get(edit.index)
            .ok_or_else(|| format!("块 {} 不存在（共 {} 段）", edit.index + 1, total))?;
        if edit.delete {
            let (s, e) = delete_range(raw, info.start, info.end);
            actions.push((s, e, String::new()));
            deleted += 1;
            continue;
        }
        if info.self_closing {
            return Err(format!("块 {} 是空元素，不能编辑", edit.index + 1));
        }
        let inner = match &edit.inner {
            Some(v) => v.clone(),
            None => raw[info.inner_start..info.inner_end].to_string(),
        };
        if inner.contains("<body") || inner.contains("</body") || inner.contains("<html") {
            return Err(format!("块 {} 的内容包含非法结构标签", edit.index + 1));
        }
        let mut open = raw[info.start..info.inner_start].to_string();
        let mut close = raw[info.inner_end..info.end].to_string();
        if let Some(next_tag) = &edit.tag {
            let next = next_tag.trim().to_lowercase();
            if !BLOCK_TAGS.contains(&next.as_str()) {
                return Err(format!("不支持的块标签：{}", next_tag));
            }
            if next != info.tag {
                open = replace_tag_name(&open, &next);
                close = replace_tag_name(&close, &next);
            }
        }
        actions.push((info.start, info.end, format!("{}{}{}", open, inner, close)));
        replaced += 1;
    }

    actions.sort_by(|a, b| b.0.cmp(&a.0));
    let mut last_start = raw.len() + 1;
    for (s, e, _) in &actions {
        if *e > last_start {
            return Err("块区间重叠，已取消写入".into());
        }
        last_start = *s;
    }

    let mut out = raw.to_string();
    for (s, e, rep) in actions {
        out.replace_range(s..e, &rep);
    }
    validate_xml(&out)?;
    Ok((out, replaced, deleted))
}

/// 扫描工作副本里的章节文件，返回块坐标
pub fn scan_blocks(edit_dir: &Path, rel_path: &str) -> Result<Vec<BlockInfo>, String> {
    let raw = read_text(edit_dir, rel_path)?;
    scan_blocks_raw(&raw)
}

/// 只替换 dirty 块并写回章节文件
pub fn write_blocks(edit_dir: &Path, rel_path: &str, edits: &[BlockEdit]) -> Result<BlockWriteResult, String> {
    let path = edit_dir.join(rel_path);
    let raw = fs::read_to_string(&path).map_err(|e| format!("读 {} 失败: {}", rel_path, e))?;
    let total = scan_blocks_raw(&raw)?.len();
    let bytes_before = raw.len();
    let (out, replaced, deleted) = apply_block_edits(&raw, edits)?;
    fs::write(&path, out.as_bytes()).map_err(|e| format!("写 {} 失败: {}", rel_path, e))?;
    Ok(BlockWriteResult {
        replaced,
        deleted,
        total,
        bytes_before,
        bytes_after: out.len(),
    })
}

#[cfg(test)]
mod e6_tests {
    use super::*;

    fn sample() -> String {
        let mut s = String::from(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\">\n<head><title>t</title></head>\n<body>\n  <section class=\"chapter\" epub:type=\"chapter\">\n    <a id=\"ch1\"></a>\n",
        );
        for i in 0..30 {
            s.push_str(&format!(
                "    <p class=\"p{}\" data-x=\"{}\">第{}段 &amp; <em>内联</em><br/>English text {}</p>\n",
                i, i, i, i
            ));
        }
        s.push_str("  </section>\n</body>\n</html>");
        s
    }

    #[test]
    fn scan_flattens_single_section_and_skips_anchor() {
        let raw = sample();
        let blocks = scan_blocks_raw(&raw).unwrap();
        assert_eq!(blocks.len(), 30);
        assert_eq!(blocks[0].tag, "p");
        assert_eq!(blocks[0].index, 0);
    }

    #[test]
    fn only_dirty_blocks_change_and_untouched_are_byte_identical() {
        let raw = sample();
        let blocks = scan_blocks_raw(&raw).unwrap();
        let before: Vec<String> = blocks
            .iter()
            .map(|b| raw[b.start..b.end].to_string())
            .collect();

        let edits = vec![
            BlockEdit { index: 4, inner: Some("改过的第四段 &amp; <strong>粗</strong>".into()), tag: None, delete: false },
            BlockEdit { index: 10, inner: None, tag: Some("h2".into()), delete: false },
            BlockEdit { index: 20, inner: None, tag: None, delete: true },
        ];
        let (out, replaced, deleted) = apply_block_edits(&raw, &edits).unwrap();
        assert_eq!(replaced, 2);
        assert_eq!(deleted, 1);

        let after_blocks = scan_blocks_raw(&out).unwrap();
        assert_eq!(after_blocks.len(), 29);
        // 除第 4/10/20 段外，其余 27 段原文逐字节一致
        for i in 0..before.len() {
            if matches!(i, 4 | 10 | 20) {
                continue;
            }
            let expect = &before[i];
            assert!(out.contains(expect), "原块 {} 的字节未保留：{}", i, expect);
        }
        assert!(out.contains("<h2 class=\"p10\" data-x=\"10\">第10段"));
        assert!(!out.contains("第20段"));
    }

    #[test]
    fn xml_invalid_inner_is_rejected() {
        let raw = sample();
        let edits = vec![BlockEdit {
            index: 0,
            inner: Some("未转义的 & 与 <b>未闭合".into()),
            tag: None,
            delete: false,
        }];
        assert!(apply_block_edits(&raw, &edits).is_err());
    }

    /// 真实书端到端：改 1 段 + 改 1 段标题级别 + 删 1 段，
    /// 其余至少 30 段逐字节保留，重打包后内置 epubcheck 必须 0 错误。
    /// 样本缺失时跳过（CI / 别的机器）。
    fn real_book() -> Option<PathBuf> {
        if let Ok(p) = std::env::var("SCROLLFORGE_E6_BOOK") {
            let pb = PathBuf::from(p);
            if pb.is_file() {
                return Some(pb);
            }
        }
        let pb = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(r"..\..\local book repository\（中译）灭门家族的重生者.epub");
        pb.is_file().then_some(pb)
    }

    #[test]
    fn real_book_untouched_bytes_and_epubcheck() {
        let Some(book) = real_book() else {
            eprintln!("跳过：没有真实样本 EPUB");
            return;
        };
        let case = std::env::var("SCROLLFORGE_E6_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(r"D:\开发缓存\scrollforge-e6"))
            .join("real-book");
        let _ = fs::remove_dir_all(&case);
        fs::create_dir_all(&case).unwrap();
        let copy = case.join("book.epub");
        fs::copy(&book, &copy).unwrap();

        let edit_dir = case.join("edit");
        let workspace = unpack_epub(&copy, &edit_dir).unwrap();

        // 找块最多的正文文件
        let mut target = String::new();
        let mut raw = String::new();
        let mut blocks = Vec::new();
        for entry in &workspace.entries {
            if entry.role != "text" || !entry.path.ends_with(".xhtml") {
                continue;
            }
            let Ok(text) = fs::read_to_string(edit_dir.join(&entry.path)) else { continue };
            if let Ok(list) = scan_blocks_raw(&text) {
                if list.len() > blocks.len() {
                    target = entry.path.clone();
                    blocks = list;
                    raw = text;
                }
            }
        }
        assert!(
            blocks.len() >= 30,
            "样本中没有 30 段的章节（最大 {} 段）",
            blocks.len()
        );

        let before: Vec<String> = blocks
            .iter()
            .map(|b| raw[b.start..b.end].to_string())
            .collect();
        let edits = vec![
            BlockEdit {
                index: 4,
                inner: Some("E6 实测：中文段落 &amp; English mixed 文本".into()),
                tag: None,
                delete: false,
            },
            BlockEdit {
                index: 9,
                inner: None,
                tag: Some("h2".into()),
                delete: false,
            },
            BlockEdit {
                index: 14,
                inner: None,
                tag: None,
                delete: true,
            },
        ];
        let result = write_blocks(&edit_dir, &target, &edits).unwrap();
        assert_eq!(result.replaced, 2);
        assert_eq!(result.deleted, 1);

        let after = fs::read_to_string(edit_dir.join(&target)).unwrap();
        let after_blocks = scan_blocks_raw(&after).unwrap();
        assert_eq!(after_blocks.len(), blocks.len() - 1);

        // 前 30 段里除第 5/10/15 段外，原文逐字节保留
        for i in 0..30 {
            if matches!(i, 4 | 9 | 14) {
                continue;
            }
            assert!(
                after.contains(&before[i]),
                "第 {} 段的字节被改动：{}",
                i + 1,
                before[i]
            );
        }
        // 双向同步：重扫后能看到新标题级别、新文本，删掉的段落确实消失
        assert_eq!(after_blocks[9].tag, "h2");
        assert!(after.contains("E6 实测：中文段落 &amp; English mixed 文本"));
        assert!(!after.contains(&before[14]), "第 15 段没有被删除");

        let out = case.join("out.epub");
        pack_epub(&edit_dir, &out).unwrap();
        let results = run_epubcheck(&out).unwrap();
        let errors: Vec<_> = results
            .iter()
            .filter(|r| r.level == "ERROR" || r.level == "FATAL")
            .collect();
        assert!(
            errors.is_empty(),
            "epubcheck 报 {} 个错误：{}",
            errors.len(),
            errors
                .iter()
                .map(|r| format!("[{}] {}", r.code, r.message))
                .collect::<Vec<_>>()
                .join(" | ")
        );

        // 证明报告解析不是空跑：坏文件必须产生 FATAL/ERROR 消息
        let bad = case.join("bad.epub");
        fs::write(&bad, b"not an epub").unwrap();
        let bad_results = run_epubcheck(&bad).expect("epubcheck 应当产出报告");
        assert!(
            !bad_results.is_empty(),
            "坏文件没有任何检查消息，说明 --json 报告没有生效"
        );
    }
}

// ──────────────────────────────────────────────────────
// mime / role 推断（pub 导出 + 内部别名）
// ──────────────────────────────────────────────────────


pub fn infer_mime_str(path: &str) -> String {
    let ext = path.split('.').last().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "xhtml" | "xht" | "html" | "htm" => "application/xhtml+xml",
        "css" => "text/css",
        "js" => "application/javascript",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "otf" => "font/otf",
        "ttf" => "font/ttf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ncx" => "application/x-dtbncx+xml",
        "opf" => "application/oebps-package+xml",
        "xml" => "application/xml",
        "mimetype" => "text/plain",
        _ => "application/octet-stream",
    }.into()
}

pub fn infer_role_str(path: &str, mime: &str) -> String {
    if path == "mimetype" { return "manifest".into(); }
    if path.starts_with("META-INF/") { return "manifest".into(); }
    if path.ends_with(".xhtml") || path.ends_with(".html") {
        if path.contains("nav") || path.ends_with(".ncx") { return "toc".into(); }
        return "text".into();
    }
    if mime.contains("css") { return "style".into(); }
    if mime.starts_with("image/") { return "image".into(); }
    if mime.starts_with("font/") { return "font".into(); }
    "other".into()
}

// ──────────────────────────────────────────────────────
// epubcheck 调用
// ──────────────────────────────────────────────────────

pub fn run_epubcheck(epub_path: &Path) -> Result<Vec<CheckResult>, String> {
    let exe_dir = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .unwrap()
        .to_path_buf();

    let runtime_java = exe_dir.join("runtime").join("bin").join("java.exe");
    let epubcheck_jar = exe_dir.join("epubcheck.jar");

    // 回退链
    let java_cmd = if runtime_java.exists() {
        runtime_java.to_string_lossy().to_string()
    } else {
        // 系统 Java
        "java".into()
    };

    if !epubcheck_jar.exists() {
        // 也可能在 resources 目录（开发态）
        let dev_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("epubcheck")
            .join("epubcheck.jar");
        if dev_path.exists() {
            return run_epubcheck_cmd(&java_cmd, &dev_path, epub_path);
        }
        return Err("epubcheck.jar 未找到".into());
    }

    run_epubcheck_cmd(&java_cmd, &epubcheck_jar, epub_path)
}

fn run_epubcheck_cmd(java: &str, jar: &Path, epub: &Path) -> Result<Vec<CheckResult>, String> {
    // epubcheck 的 `--json` 需要一个输出文件参数，报告写到文件里（stdout 只有摘要）。
    let report = std::env::temp_dir().join(format!(
        "scrollforge-epubcheck-{}-{}.json",
        std::process::id(),
        chrono_now()
    ));
    let mut cmd = Command::new(java);
    cmd.arg("-jar").arg(jar)
        .arg("--json").arg(&report).arg(epub)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| format!("启动 epubcheck 失败: {}", e))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let output = read_all(stdout);
    let err_str = String::from_utf8_lossy(&read_all(stderr)).to_string();

    let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);

    let json_str = match fs::read_to_string(&report) {
        Ok(text) => {
            let _ = fs::remove_file(&report);
            text
        }
        Err(_) => {
            return Err(format!(
                "epubcheck 没有产出报告（退出码 {}）：{}{}",
                code,
                String::from_utf8_lossy(&output).trim(),
                err_str.trim()
            ))
        }
    };

    Ok(parse_epubcheck_json(&json_str))
}

fn read_all<R: std::io::Read>(r: R) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut br = BufReader::new(r);
    let _ = br.read_to_end(&mut buf);
    buf
}

fn parse_epubcheck_json(s: &str) -> Vec<CheckResult> {
    // epubcheck 4 的 JSON 格式
    #[derive(Deserialize)]
    struct Msg {
        severity: String,
        message: String,
        #[serde(default)]
        code: Option<String>,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        line: Option<u32>,
    }
    #[derive(Deserialize)]
    struct Root {
        #[serde(default)]
        messages: Vec<Msg>,
    }

    let mut results = Vec::new();
    if let Ok(root) = serde_json::from_str::<Root>(s) {
        for m in root.messages {
            results.push(CheckResult {
                level: m.severity,
                code: m.code.unwrap_or_else(|| m.message.clone()),
                message: m.message,
                path: m.path,
                line: m.line,
            });
        }
    }
    results
}

// ──────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────

fn chrono_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn file_mtime(p: &Path) -> i64 {
    fs::metadata(p).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ──────────────────────────────────────────────────────
// ForgePanel EPUB 锻造索引（S6）
// ──────────────────────────────────────────────────────

/// 扁平块映射：ForgePanel 的 chapterIndex:paragraphIndex → EPUB 的 rel_path + block_index
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FlatBlock {
    #[serde(rename = "chapterIndex")]
    pub chapter_index: usize,
    #[serde(rename = "paragraphIndex")]
    pub paragraph_index: usize,
    #[serde(rename = "relPath")]
    pub rel_path: String,
    #[serde(rename = "blockIndex")]
    pub block_index: usize,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForgedChapter {
    pub title: String,
    pub paragraphs: Vec<String>,
    #[serde(default)]
    pub paragraph_ranges: Vec<ParagraphRange>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForgedAnalysis {
    pub chapters: Vec<ForgedChapter>,
    pub heading_count: usize,
    pub fallback: bool,
}

/// ForgePanel EPUB 索引：解压 + spine 顺序 + 逐 xhtml 分块 + 扁平映射
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForgeEpubIndex {
    pub text: String,
    pub analysis: ForgedAnalysis,
    pub flat_blocks: Vec<FlatBlock>,
    pub edit_dir: String,
}

/// HTML inner → 纯文本（去标签 + 实体）
fn extract_plain_text(raw_inner: &str) -> String {
    let mut out = String::with_capacity(raw_inner.len());
    // 快速去所有标签
    let mut i = 0usize;
    let bytes = raw_inner.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // 找到闭合 >
            let Some(close) = raw_inner[i..].find('>') else { break };
            i += close + 1;
            out.push(' ');
        } else {
            // 按 UTF-8 字符推进：直接把字节 as char 会把中文变成 latin-1 乱码
            let ch = raw_inner[i..].chars().next().unwrap_or(' ');
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    // 简单实体还原（常用几种）
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// 用 OPF filename 当章节标题（EPUB 正文一般不嵌 <h1>，靠 toc 或文件名区分）
fn chapter_filename(rel_path: &str) -> String {
    rel_path
        .rsplit('/')
        .next()
        .unwrap_or(rel_path)
        .trim_end_matches(".xhtml")
        .trim_end_matches(".html")
        .to_string()
}

/// ForgePanel EPUB 索引：解压 → spine 顺序 → 逐 xhtml scan_blocks_raw → 扁平映射
pub fn forge_epub_index(
    epub_path: &Path,
    edit_dir: &Path,
) -> Result<ForgeEpubIndex, String> {
    // 1. 解压 EPUB（清旧目录 + 重新解）
    let ws = unpack_epub(epub_path, edit_dir)?;

    // 2. 重建 manifest_map（id → rel_path）从 entries
    let manifest_map: HashMap<String, String> = ws
        .entries
        .iter()
        .filter_map(|e| Some((e.id.as_ref()?.clone(), e.path.clone())))
        .collect();

    // 3. 读 OPF + parse_opf_spine
    let opf_bytes = fs::read(&ws.opf_abs).map_err(|e| format!("读 OPF 失败: {}", e))?;
    let spine_ids = parse_opf_spine(&opf_bytes)?;

    // 4. OPF 目录（相对 edit_dir，用于拼 rel_path）
    let opf_dir = if let Some(idx) = ws.opf_path.rfind('/') {
        ws.opf_path[..=idx].to_string()
    } else {
        String::new()
    };

    // 5. 遍历 spine → 扫描每个 xhtml 的 body 子块
    let mut chapters: Vec<ForgedChapter> = Vec::new();
    let mut flat_blocks: Vec<FlatBlock> = Vec::new();
    let mut all_paragraphs: Vec<String> = Vec::new();

    let mut chapter_index = 0usize;
    for idref in &spine_ids {
        let rel_path = if let Some(p) = manifest_map.get(idref) {
            p.clone()
        } else {
            // manifest 没声明，试一下用 dir + idref 拼
            format!("{}{}", opf_dir, idref)
        };

        // 过滤：只处理 text 类型或 .xhtml/.html 后缀
        let media_type = ws
            .entries
            .iter()
            .find(|e| e.path == rel_path)
            .map(|e| e.media_type.as_str())
            .unwrap_or("");
        let is_text = media_type.starts_with("text")
            || rel_path.ends_with(".xhtml")
            || rel_path.ends_with(".html")
            || rel_path.ends_with(".htm");
        if !is_text {
            continue;
        }

        let abs_path = edit_dir.join(&rel_path);
        let raw = match fs::read_to_string(&abs_path) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let blocks = match scan_blocks_raw(&raw) {
            Ok(b) => b,
            Err(_) => continue,
        };

        let mut paragraphs: Vec<String> = Vec::new();
        let mut paragraph_index = 0usize;
        for block in &blocks {
            if block.self_closing {
                continue;
            }
            let inner = &raw[block.inner_start..block.inner_end];
            let plain = extract_plain_text(inner);
            let normalized = plain.replace(|c: char| c.is_ascii_whitespace(), " ").trim().to_string();
            if normalized.is_empty() {
                continue;
            }

            paragraphs.push(normalized.clone());
            all_paragraphs.push(normalized.clone());

            flat_blocks.push(FlatBlock {
                chapter_index,
                paragraph_index,
                rel_path: rel_path.clone(),
                block_index: block.index,
                text: normalized,
            });
            paragraph_index += 1;
        }

        if !paragraphs.is_empty() {
            let paragraph_ranges: Vec<ParagraphRange> = (0..paragraphs.len())
                .map(|i| ParagraphRange {
                    start: i,
                    end: i + 1,
                })
                .collect();
            chapters.push(ForgedChapter {
                title: chapter_filename(&rel_path),
                paragraphs,
                paragraph_ranges,
            });
            chapter_index += 1;
        }
    }

    let text = all_paragraphs.join("\n\n");
    let heading_count = chapters.len();
    let analysis = ForgedAnalysis {
        chapters,
        heading_count,
        fallback: false,
    };

    Ok(ForgeEpubIndex {
        text,
        analysis,
        flat_blocks,
        edit_dir: ws.edit_dir,
    })
}

#[cfg(test)]
mod forge_epub_tests {
    use super::*;

    /// 从本地书库取任一 EPUB 作为样本；换机器没有样本时跳过，不硬失败。
    fn sample_book() -> Option<PathBuf> {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()?
            .parent()?
            .join("local book repository");
        let mut found: Vec<PathBuf> = fs::read_dir(repo)
            .ok()?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("epub"))
            .collect();
        found.sort();
        found.into_iter().next()
    }

    /// 回归测试：外部 EPUB（manifest/itemref 自闭合）必须能解析出章节与正文块。
    /// 之前只匹配 Event::Start，导致锻造按钮一直是灰的。
    #[test]
    fn forge_index_parses_spine_and_manifest() {
        let Some(book) = sample_book() else {
            eprintln!("skip: 书库中没有 EPUB 样本");
            return;
        };
        let edit = std::env::temp_dir().join("scrollforge_forge_test");
        let _ = fs::remove_dir_all(&edit);
        let idx = forge_epub_index(&book, &edit).expect("forge_epub_index 应能解析该 EPUB");
        eprintln!(
            "forge_epub_index OK: {} chapters={} blocks={} text_len={}",
            book.file_name().unwrap_or_default().to_string_lossy(),
            idx.analysis.chapters.len(),
            idx.flat_blocks.len(),
            idx.text.len()
        );
        assert!(
            !idx.analysis.chapters.is_empty(),
            "章节数为 0：spine/manifest 解析疑似失效"
        );
        assert!(!idx.flat_blocks.is_empty(), "正文块数为 0");
        assert!(idx.text.len() > 100, "提取正文过短");
        // 中文书必须提取出正常汉字，不能是 latin-1 乱码（è½®å›ž 这种）
        let name = book.file_name().unwrap_or_default().to_string_lossy().to_string();
        if name.contains("轮回") {
            assert!(
                !idx.text.contains("è½") && !idx.text.contains("å›ž"),
                "正文解码为乱码：{:.80}",
                idx.text
            );
            assert!(idx.text.contains('，'), "中文正文标点缺失，疑似编码错误");
        }
        let _ = fs::remove_dir_all(&edit);
    }
}
