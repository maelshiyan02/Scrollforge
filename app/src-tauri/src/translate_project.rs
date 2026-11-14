//! S10：锻造译文工程。
//!
//! 锻造档只写 `<书目录>/译文/<语言代码>/`，母本 `source.*` 字节不变：
//! - `mapping.json` 记录章节 → 母本包内 href、译文文件、未译段落；
//! - `章节/*.xhtml` 是基于母本同名章节替换译文块后的独立 XHTML；
//! - 导出时复制母本包、用译文 XHTML 覆盖同名章节再打包，图片/字体/样式自然保留。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::epub_edit as ee;

const PROJECT_DIR: &str = "译文";
const CHAPTERS_DIR: &str = "章节";
const MAPPING_FILE: &str = "mapping.json";

/// 前端传来的单个段落：index 是阅读器段落序号，blockIndex 是 EPUB 块序号。
#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranslationBlockInput {
    #[serde(default)]
    pub index: usize,
    #[serde(default)]
    pub block_index: usize,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub kind: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranslationChapterInput {
    pub chapter_index: usize,
    #[serde(default)]
    pub title: String,
    /// EPUB 母本包内相对路径；TXT 等生成的译文为 None
    #[serde(default)]
    pub source_href: Option<String>,
    #[serde(default)]
    pub blocks: Vec<TranslationBlockInput>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranslationChapterMap {
    pub chapter_index: usize,
    pub title: String,
    #[serde(default)]
    pub source_href: Option<String>,
    pub file: String,
    pub block_count: usize,
    pub translated_count: usize,
    pub untranslated: Vec<usize>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranslationTotals {
    pub blocks: usize,
    pub translated: usize,
    pub untranslated: usize,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranslationMapping {
    pub schema_version: u32,
    pub book_id: String,
    pub book_title: String,
    pub language: String,
    pub source_name: String,
    #[serde(default)]
    pub source_fingerprint: Option<String>,
    pub updated_at: i64,
    pub chapters: Vec<TranslationChapterMap>,
    pub totals: TranslationTotals,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UntranslatedChapter {
    pub chapter_index: usize,
    pub title: String,
    pub paragraphs: Vec<usize>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranslationSaveResult {
    pub project_dir: String,
    pub mapping_path: String,
    pub language: String,
    pub chapters: usize,
    pub blocks: usize,
    pub translated: usize,
    pub untranslated: usize,
    pub untranslated_chapters: Vec<UntranslatedChapter>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranslationExportResult {
    pub output_path: String,
    pub language: String,
    pub chapters_used: usize,
    pub bytes: u64,
}

pub struct SaveArgs<'a> {
    pub book_dir: &'a Path,
    pub source: &'a Path,
    pub source_name: String,
    pub source_fingerprint: Option<String>,
    pub book_id: &'a str,
    pub book_title: &'a str,
    pub language: &'a str,
    pub chapters: Vec<TranslationChapterInput>,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 语言代码同时充当目录名，只允许字母数字和连字符。
fn valid_language(language: &str) -> bool {
    let len = language.len();
    (2..=16).contains(&len)
        && language
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn sanitize_name(value: &str) -> String {
    let name: String = value
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect();
    let trimmed = name.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "chapter".to_string()
    } else {
        trimmed.chars().take(60).collect()
    }
}

fn escape_xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// 母本章节 href 必须是包内相对路径：拒绝绝对路径、盘符与 ..
fn normalize_href(href: &str) -> Result<String, String> {
    let normalized = href.replace('\\', "/").trim_start_matches('/').to_string();
    if normalized.is_empty() || normalized.contains("..") || normalized.contains(':') {
        return Err(format!("章节路径不合法：{href}"));
    }
    Ok(normalized)
}

fn chapter_stem(href: &str) -> String {
    let base = href.rsplit('/').next().unwrap_or(href);
    let stem = base
        .trim_end_matches(".xhtml")
        .trim_end_matches(".html")
        .trim_end_matches(".htm");
    sanitize_name(stem)
}

fn project_dir(book_dir: &Path, language: &str) -> PathBuf {
    book_dir.join(PROJECT_DIR).join(language)
}

fn cleanup(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

/// 按 blocks 生成一份独立 XHTML（TXT 母本或母本缺少源章节时兜底）。
fn build_generated_xhtml(title: &str, blocks: &[TranslationBlockInput]) -> String {
    let mut body = String::new();
    for block in blocks {
        let text = block.target.trim();
        let text = if text.is_empty() { block.source.trim() } else { text };
        if text.is_empty() {
            continue;
        }
        let escaped = escape_xml_text(text);
        if block.kind == "heading" {
            body.push_str(&format!("  <h2>{escaped}</h2>\n"));
        } else {
            body.push_str(&format!("  <p>{escaped}</p>\n"));
        }
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
<html xmlns=\"http://www.w3.org/1999/xhtml\">\n\
<head><meta charset=\"utf-8\"/><title>{}</title></head>\n\
<body>\n  <h1>{}</h1>\n{}</body>\n\
</html>\n",
        escape_xml_text(title),
        escape_xml_text(title),
        body
    )
}

/// 保存译文工程。只写 `译文/`，不碰母本、不建 revision。
pub fn save_project(args: SaveArgs<'_>) -> Result<TranslationSaveResult, String> {
    if !valid_language(args.language) {
        return Err("语言代码不合法（只允许字母、数字、连字符）".into());
    }
    if args.chapters.is_empty() {
        return Err("没有可保存的章节".into());
    }

    let project = project_dir(args.book_dir, args.language);
    let chapters_out = project.join(CHAPTERS_DIR);
    fs::create_dir_all(&chapters_out)
        .map_err(|e| format!("无法创建译文工程目录：{e}"))?;

    let is_epub = args
        .source
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| v.eq_ignore_ascii_case("epub"))
        .unwrap_or(false);
    let unpack_root = args
        .book_dir
        .join(PROJECT_DIR)
        .join(format!(".build-{}", args.language));
    let unpack_dir = unpack_root.join("pkg");

    if is_epub {
        cleanup(&unpack_root);
        ee::unpack_epub(args.source, &unpack_dir)?;
    }

    let mut mapped: Vec<TranslationChapterMap> = Vec::new();
    let mut totals = TranslationTotals::default();
    let mut untranslated_chapters: Vec<UntranslatedChapter> = Vec::new();

    let result = (|| -> Result<(), String> {
        for (order, chapter) in args.chapters.iter().enumerate() {
            let mut edits: Vec<ee::BlockEdit> = Vec::new();
            let mut untranslated: Vec<usize> = Vec::new();
            let mut translated_count = 0usize;

            for block in &chapter.blocks {
                if block.target.trim().is_empty() {
                    if !block.source.trim().is_empty() {
                        untranslated.push(block.index);
                    }
                    continue;
                }
                translated_count += 1;
                edits.push(ee::BlockEdit {
                    index: block.block_index,
                    inner: Some(escape_xml_text(block.target.trim())),
                    tag: None,
                    delete: false,
                });
            }

            let title = if chapter.title.trim().is_empty() {
                format!("第 {} 章", order + 1)
            } else {
                chapter.title.clone()
            };

            let mut source_href: Option<String> = None;
            let output = if is_epub {
                let href = chapter
                    .source_href
                    .as_ref()
                    .ok_or_else(|| format!("第 {} 章缺少母本 href，无法生成译文", order + 1))?;
                let normalized = normalize_href(href)?;
                let raw = fs::read_to_string(unpack_dir.join(&normalized))
                    .map_err(|e| format!("读取母本章节 {href} 失败：{e}"))?;
                let (out, _, _, _) = ee::apply_block_edits_ex(&raw, &edits, &[])?;
                source_href = Some(normalized);
                out
            } else {
                build_generated_xhtml(&title, &chapter.blocks)
            };

            let stem = chapter
                .source_href
                .as_deref()
                .map(chapter_stem)
                .unwrap_or_else(|| sanitize_name(&title));
            let file_name = format!("{:03}-{stem}.xhtml", order + 1);
            let rel_file = format!("{CHAPTERS_DIR}/{file_name}");
            fs::write(chapters_out.join(&file_name), output.as_bytes())
                .map_err(|e| format!("写入 {} 失败：{e}", rel_file))?;

            let block_count = chapter.blocks.len();
            totals.blocks += block_count;
            totals.translated += translated_count;
            totals.untranslated += untranslated.len();
            if !untranslated.is_empty() {
                untranslated_chapters.push(UntranslatedChapter {
                    chapter_index: chapter.chapter_index,
                    title: title.clone(),
                    paragraphs: untranslated.clone(),
                });
            }

            mapped.push(TranslationChapterMap {
                chapter_index: chapter.chapter_index,
                title,
                source_href,
                file: rel_file,
                block_count,
                translated_count,
                untranslated,
            });
        }
        Ok(())
    })();

    if is_epub {
        cleanup(&unpack_root);
    }
    result?;

    let mapping = TranslationMapping {
        schema_version: 1,
        book_id: args.book_id.to_string(),
        book_title: args.book_title.to_string(),
        language: args.language.to_string(),
        source_name: args.source_name,
        source_fingerprint: args.source_fingerprint,
        updated_at: now_millis(),
        chapters: mapped,
        totals: totals.clone(),
    };
    let mapping_path = project.join(MAPPING_FILE);
    let json = serde_json::to_string_pretty(&mapping)
        .map_err(|e| format!("序列化译文映射失败：{e}"))?;
    let tmp = mapping_path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("写入译文映射失败：{e}"))?;
    fs::rename(&tmp, &mapping_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("替换译文映射失败：{e}")
    })?;

    Ok(TranslationSaveResult {
        project_dir: project.to_string_lossy().to_string(),
        mapping_path: mapping_path.to_string_lossy().to_string(),
        language: args.language.to_string(),
        chapters: mapping.chapters.len(),
        blocks: totals.blocks,
        translated: totals.translated,
        untranslated: totals.untranslated,
        untranslated_chapters,
    })
}

pub struct ExportArgs<'a> {
    pub book_dir: &'a Path,
    pub source: &'a Path,
    pub book_title: &'a str,
    pub language: &'a str,
    pub output_dir: &'a Path,
}

/// 导出译文 EPUB：复制母本资源，覆盖已译章节，不改动译文工程。
pub fn export_project(args: ExportArgs<'_>) -> Result<TranslationExportResult, String> {
    if !valid_language(args.language) {
        return Err("语言代码不合法".into());
    }
    let project = project_dir(args.book_dir, args.language);
    let mapping_path = project.join(MAPPING_FILE);
    let text = fs::read_to_string(&mapping_path)
        .map_err(|_| "还没有保存过译文工程，请先在锻造台点保存".to_string())?;
    let mapping: TranslationMapping =
        serde_json::from_str(&text).map_err(|e| format!("译文映射损坏：{e}"))?;

    let is_epub = args
        .source
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| v.eq_ignore_ascii_case("epub"))
        .unwrap_or(false);
    if !is_epub {
        return Err("只有 EPUB 母本支持导出译文 EPUB".into());
    }

    fs::create_dir_all(args.output_dir).map_err(|e| format!("无法创建导出目录：{e}"))?;
    let file_name = format!(
        "{} - {}.epub",
        sanitize_name(args.book_title),
        args.language
    );
    let output_path = args.output_dir.join(file_name);

    let unpack_root = args
        .book_dir
        .join(PROJECT_DIR)
        .join(format!(".export-{}", args.language));
    let unpack_dir = unpack_root.join("pkg");
    cleanup(&unpack_root);
    ee::unpack_epub(args.source, &unpack_dir)?;

    let result = (|| -> Result<usize, String> {
        let mut used = 0usize;
        for chapter in &mapping.chapters {
            let Some(href) = chapter.source_href.as_ref() else {
                continue;
            };
            let src = project.join(&chapter.file);
            if !src.is_file() {
                continue;
            }
            let normalized = normalize_href(href)?;
            let dst = unpack_dir.join(&normalized);
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建章节目录失败：{e}"))?;
            }
            fs::copy(&src, &dst).map_err(|e| format!("覆盖章节 {href} 失败：{e}"))?;
            used += 1;
        }
        if used == 0 {
            return Err("译文工程里没有可导出的章节".into());
        }
        ee::pack_epub(&unpack_dir, &output_path)?;
        Ok(used)
    })();

    cleanup(&unpack_root);
    let chapters_used = result?;
    let bytes = fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(TranslationExportResult {
        output_path: output_path.to_string_lossy().to_string(),
        language: args.language.to_string(),
        chapters_used,
        bytes,
    })
}
