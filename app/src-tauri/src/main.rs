// 桌面入口：双击启动即打开主窗口（Windows 下不弹控制台）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod epub_edit;

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

use epub_edit as ee;
use ee::{EditWorkspace, CheckResult};

/// 书架上的一条书目。字段只在导入时写一次，之后只读。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BookMeta {
    id: String,
    title: String,
    format: String,
    byte_len: u64,
    imported_at: i64,
    source_name: String,
    /// 封面文件名（cover.jpg 等），导入 EPUB 后由前端抽取写入
    #[serde(default)]
    cover: Option<String>,
    /// library：副本保存在固定书库；history：只登记原文件路径
    #[serde(default = "default_storage")]
    storage: String,
    /// history 模式下原文件的绝对路径；library 模式为空
    #[serde(default)]
    path: Option<String>,
    /// 从子文件夹导入时的分组名
    #[serde(default)]
    group: Option<String>,
    /// 最近一次打开时间（0 表示从未打开）
    #[serde(default)]
    last_opened_at: Option<i64>,
}

fn default_storage() -> String {
    "library".into()
}

/// 应用设置。阅读历史与本地书库并存：
/// - history：只记录路径与进度，不复制文件；
/// - library：把书复制进本地书库文件夹，原文件移动/删除也能读。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    #[serde(default = "default_storage_mode")]
    storage_mode: String,
    #[serde(default = "default_library_dir")]
    library_dir: String,
    /// 阅读历史记录（markdown/进度）所在文件夹
    #[serde(default = "default_reading_history_dir")]
    reading_history_dir: String,
    /// 转换/导出的默认落盘文件夹
    #[serde(default = "default_final_export_dir")]
    final_export_dir: String,
    #[serde(default = "default_formats")]
    import_formats: Vec<String>,
    #[serde(default)]
    min_bytes: u64,
    /// 导入时只登记历史、不复制（readest 的“原位读取”）
    #[serde(default)]
    keep_original: bool,
    /// 文件夹导入时按子文件夹建立分组
    #[serde(default = "default_true")]
    folder_group: bool,
}

fn default_storage_mode() -> String {
    "library".into()
}

fn default_library_dir() -> String {
    r"D:\AI Coding Project Management\Scrollforge\local book repository".into()
}

fn default_reading_history_dir() -> String {
    r"D:\AI Coding Project Management\Scrollforge\reading history".into()
}

fn default_final_export_dir() -> String {
    r"D:\AI Coding Project Management\Scrollforge\final export".into()
}

fn default_formats() -> Vec<String> {
    [
        "epub", "mobi", "azw", "azw3", "fb2", "cbz", "zip", "pdf", "txt", "md", "html",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn default_true() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            storage_mode: default_storage_mode(),
            library_dir: default_library_dir(),
            reading_history_dir: default_reading_history_dir(),
            final_export_dir: default_final_export_dir(),
            import_formats: default_formats(),
            min_bytes: 0,
            keep_original: false,
            folder_group: true,
        }
    }
}

/// 历史记录只保存原文件引用，正文永远从原路径读取。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry {
    id: String,
    path: String,
    title: String,
    format: String,
    byte_len: u64,
    added_at: i64,
    last_opened_at: i64,
    #[serde(default)]
    cover: Option<String>,
}

impl HistoryEntry {
    fn to_book(&self) -> BookMeta {
        BookMeta {
            id: self.id.clone(),
            title: self.title.clone(),
            format: self.format.clone(),
            byte_len: self.byte_len,
            imported_at: self.added_at,
            source_name: Path::new(&self.path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&self.title)
                .to_string(),
            cover: self.cover.clone(),
            storage: "history".into(),
            path: Some(self.path.clone()),
            group: None,
            last_opened_at: Some(self.last_opened_at),
        }
    }
}

/// 支持的正文格式；htm 统一归一化为 html。
fn normalize_format(ext: &str) -> Option<String> {
    let ext = ext.to_lowercase();
    let ext = if ext == "htm" { "html".to_string() } else { ext };
    match ext.as_str() {
        "epub" | "txt" | "md" | "html" | "fb2" | "mobi" | "azw" | "azw3" | "cbz" | "zip"
        | "pdf" => Some(ext),
        _ => None,
    }
}

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("settings.json"))
}

fn load_settings(app: &tauri::AppHandle) -> AppSettings {
    let Ok(path) = settings_path(app) else {
        return AppSettings::default();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return AppSettings::default();
    };
    let mut settings = serde_json::from_str::<AppSettings>(&text).unwrap_or_default();
    // 旧版默认导入清单只有 5 种：升级到新版默认矩阵；用户自定义过的清单保持原样。
    let legacy = ["epub", "txt", "md", "html", "fb2"];
    let is_legacy = settings.import_formats.len() == legacy.len()
        && legacy.iter().all(|ext| settings.import_formats.iter().any(|item| item == ext));
    if is_legacy {
        settings.import_formats = default_formats();
    }
    settings
}

fn history_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("history.json"))
}

fn read_history(app: &tauri::AppHandle) -> Vec<HistoryEntry> {
    let Ok(path) = history_path(app) else {
        return Vec::new();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_history(app: &tauri::AppHandle, entries: &[HistoryEntry]) -> Result<(), String> {
    let path = history_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建数据目录：{e}"))?;
    }
    let json = serde_json::to_string_pretty(entries).map_err(|e| format!("序列化历史失败：{e}"))?;
    fs::write(path, json).map_err(|e| format!("写入历史失败：{e}"))
}

fn history_covers_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_data(app)?.join("history_covers");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建封面目录：{e}"))?;
    Ok(dir)
}

/// 用路径生成稳定的历史 id，保证同一文件反复打开时进度不丢。
fn history_id(path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("h{hash:x}")
}

/// 返回启动参数（跳过可执行文件自身路径）。
/// 用途：从命令行或"用本程序打开"传入书文件路径时，前端可直接打开。
#[tauri::command]
fn start_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

/// 按路径读取整本书的原始字节，返回 ArrayBuffer（避免 JSON 数字数组带来的膨胀）。
#[tauri::command]
fn read_book(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败：{e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 固定书库根目录（来自设置）。目录不可用时自动寻找候选路径。
fn books_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = load_settings(app).library_dir.trim().to_string();

    // ① 设置里的路径存在 → 直接用
    if !dir.is_empty() && PathBuf::from(&dir).is_dir() {
        let preferred = PathBuf::from(dir);
        if fs::create_dir_all(&preferred).is_ok() {
            return Ok(preferred);
        }
    }

    // ② 设置路径不存在 → 检查候选路径（用户可能改名了 library → local book repository）
    let candidates = [
        default_library_dir(),
        r"D:\AI Coding Project Management\Scrollforge\local book repository".into(),
        r"D:\AI Coding Project Management\Scrollforge\library".into(),
    ];
    for c in candidates.iter() {
        let p = PathBuf::from(c);
        if p.is_dir() {
            // 写回设置文件，永久生效
            let _ = save_library_dir(app, c.clone());
            return Ok(p);
        }
    }

    // ③ 都不存在 → 用默认路径并创建
    let default = PathBuf::from(default_library_dir());
    fs::create_dir_all(&default).ok();
    let _ = save_library_dir(app, default.to_string_lossy().to_string());
    Ok(default)
}

fn save_library_dir(app: &tauri::AppHandle, dir: String) -> Result<(), String> {
    let mut settings = load_settings(app);
    settings.library_dir = dir;
    save_settings_inner_simple(app, &settings)
}

fn save_settings_inner_simple(app: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| format!("{e}"))?;
    fs::write(&path, json).map_err(|e| format!("{e}"))
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("无法创建目录：{e}"))?;
    for entry in fs::read_dir(src).map_err(|e| format!("无法读取目录：{e}"))?.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| format!("复制文件失败：{e}"))?;
        }
    }
    Ok(())
}

/// 旧版本的 appdata/books 自动搬到固定书库，避免升级后书架空白。
fn migrate_legacy_books(app: &tauri::AppHandle) -> Result<(), String> {
    let legacy = app_data(app)?.join("books");
    let root = books_root(app)?;
    if legacy == root || !legacy.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&legacy)
        .map_err(|e| format!("读取旧书库失败：{e}"))?
        .flatten()
    {
        let from = entry.path();
        if !from.is_dir() || !from.join("meta.json").exists() {
            continue;
        }
        let to = root.join(entry.file_name());
        if to.exists() {
            continue;
        }
        if fs::rename(&from, &to).is_err() {
            copy_dir_all(&from, &to)?;
        }
    }
    Ok(())
}

/// 书 id 只允许数字、字母、连字符和下划线，杜绝路径穿越。
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn book_dir(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("书目编号不合法".into());
    }
    Ok(books_root(app)?.join(id))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 书库中一本书的正文文件名（按格式区分）。
fn source_name_of(format: &str) -> String {
    let ext = normalize_format(format).unwrap_or_else(|| "txt".into());
    format!("source.{ext}")
}

fn file_title(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("未命名")
        .trim()
        .to_string()
}

fn find_library_book(app: &tauri::AppHandle, id: &str) -> Option<BookMeta> {
    // ① 扁平模型：从全局扫描结果里找（覆盖绝大多数情况）
    if let Some(book) = list_library_books(app).into_iter().find(|b| b.id == id) {
        return Some(book);
    }
    // ② 旧模型兼容：子文件夹 + meta.json
    let dir = book_dir(app, id).ok()?;
    let text = fs::read_to_string(dir.join("meta.json")).ok()?;
    let mut book: BookMeta = serde_json::from_str(&text).ok()?;
    book.storage = "library".into();
    book.path = None;
    Some(book)
}

fn find_history_entry(app: &tauri::AppHandle, id: &str) -> Option<HistoryEntry> {
    read_history(app).into_iter().find(|entry| entry.id == id)
}

fn find_book(app: &tauri::AppHandle, id: &str) -> Option<BookMeta> {
    if let Some(book) = find_library_book(app, id) {
        return Some(book);
    }
    find_history_entry(app, id).map(|entry| entry.to_book())
}

fn book_source_path(app: &tauri::AppHandle, book: &BookMeta) -> Result<PathBuf, String> {
    // ① 扁平模型 / 历史模式：book.path 已存完整路径
    if let Some(p) = book.path.clone() {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Ok(path);
        }
    }

    // ② 子文件夹旧模型（兼容）
    if book.storage == "history" {
        return Err("这条阅读历史没有原文件路径".into());
    }
    let dir = book_dir(app, &book.id)?;
    let direct = dir.join(source_name_of(&book.format));
    if direct.exists() {
        return Ok(direct);
    }
    let legacy = dir.join("source.epub");
    if legacy.exists() { return Ok(legacy); }
    let legacy = dir.join("source.txt");
    if legacy.exists() { return Ok(legacy); }
    Err("书库中找不到这本书的正文文件".into())
}

/// 记录一次阅读历史（history 模式）。同一路径反复打开只更新时间。
fn record_history(app: &tauri::AppHandle, path: &str) -> Result<HistoryEntry, String> {
    let src = PathBuf::from(path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .and_then(normalize_format)
        .ok_or_else(|| "暂不支持这种文件格式".to_string())?;
    let meta = fs::metadata(&src).map_err(|e| format!("找不到文件：{e}"))?;
    if !meta.is_file() {
        return Err("选择的不是文件".into());
    }
    let byte_len = meta.len();
    let title = {
        let value = file_title(&src);
        if value.is_empty() {
            "未命名".to_string()
        } else {
            value
        }
    };
    let id = history_id(path);
    let stamp = now_millis();
    let mut entries = read_history(app);
    let existing = entries.iter().position(|entry| entry.id == id);
    let entry = if let Some(index) = existing {
        let old = entries[index].clone();
        HistoryEntry {
            id: old.id,
            path: path.to_string(),
            title,
            format: ext,
            byte_len,
            added_at: old.added_at,
            last_opened_at: stamp,
            cover: old.cover,
        }
    } else {
        HistoryEntry {
            id,
            path: path.to_string(),
            title,
            format: ext,
            byte_len,
            added_at: stamp,
            last_opened_at: stamp,
            cover: None,
        }
    };
    match existing {
        Some(index) => entries[index] = entry.clone(),
        None => entries.push(entry.clone()),
    }
    write_history(app, &entries)?;
    Ok(entry)
}

/// 把本地电子书复制进固定书库。同一文件（同名同大小同格式）不重复复制。
fn import_library(
    app: &tauri::AppHandle,
    path: &str,
    group: Option<String>,
) -> Result<BookMeta, String> {
    let src = PathBuf::from(path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .and_then(normalize_format)
        .ok_or_else(|| "暂不支持这种文件格式".to_string())?;
    let meta_file = fs::metadata(&src).map_err(|e| format!("找不到文件：{e}"))?;
    if !meta_file.is_file() {
        return Err("选择的不是文件".into());
    }
    if meta_file.len() > 200 * 1024 * 1024 {
        return Err("文件超过 200 MB，暂不支持导入".into());
    }

    let source_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("未命名")
        .to_string();
    let byte_len = meta_file.len();

    if let Some(found) = list_library_books(app).into_iter().find(|b| {
        b.source_name == source_name && b.byte_len == byte_len && b.format == ext
    }) {
        return Ok(found);
    }

    let bytes = fs::read(&src).map_err(|e| format!("读取失败：{e}"))?;
    let title = {
        let value = file_title(&src);
        if value.is_empty() {
            "未命名".to_string()
        } else {
            value
        }
    };

    let root = books_root(app)?;
    let stamp = now_millis();
    let mut id = stamp.to_string();
    let mut n = 1;
    while root.join(&id).exists() {
        id = format!("{stamp}-{n}");
        n += 1;
    }
    let dir = root.join(&id);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建书目目录：{e}"))?;
    fs::write(dir.join(source_name_of(&ext)), &bytes)
        .map_err(|e| format!("写入副本失败：{e}"))?;

    let book = BookMeta {
        id,
        title,
        format: ext,
        byte_len,
        imported_at: stamp,
        source_name,
        cover: None,
        storage: "library".into(),
        path: None,
        group: group.filter(|value| !value.trim().is_empty()),
        last_opened_at: None,
    };
    let json = serde_json::to_string_pretty(&book).map_err(|e| format!("序列化书目失败：{e}"))?;
    fs::write(dir.join("meta.json"), json).map_err(|e| format!("写入书目失败：{e}"))?;
    Ok(book)
}

fn list_library_books(app: &tauri::AppHandle) -> Vec<BookMeta> {
    let Ok(root) = books_root(app) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // ① 旧模型：子文件夹 + meta.json
        if path.is_dir() {
            let Ok(text) = fs::read_to_string(path.join("meta.json")) else {
                continue;
            };
            let Ok(mut book) = serde_json::from_str::<BookMeta>(&text) else {
                continue;
            };
            book.storage = "library".into();
            book.path = None;
            if book_source_path(app, &book)
                .map(|p| p.exists())
                .unwrap_or(false)
            {
                out.push(book);
            }
            continue;
        }

        // ② 新模型：根目录下的 .epub/.txt/.md 等扁平文件 → 自动登记
        if path.is_file() {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .and_then(normalize_format);
            let Some(fmt) = ext else { continue };
            // 跳过 covers/ 等子目录下的文件（上面已处理）
            let Ok(meta) = fs::metadata(&path) else { continue };
            if !meta.is_file() || meta.len() == 0 { continue }

            // 生成稳定 id：用文件名 hash
            let id = format!("flat_{}", simple_hash(&name));
            let title = std::path::Path::new(&name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&name)
                .to_string();

            let mut book = BookMeta {
                id,
                // 书名直接用文件名（用户改的中文名字就是意图），不要从 OPF 内部标题覆盖
                title: title.clone(),
                format: fmt.clone(),
                byte_len: meta.len(),
                imported_at: now_millis(),
                source_name: name.clone(),
                cover: None,
                storage: "library".into(),
                path: Some(path.to_string_lossy().to_string()),
                group: None,
                last_opened_at: None,
            };

            // 封面：已有有效缓存就复用，缺失/损坏则从 EPUB 重新提取
            if fmt == "epub" {
                book.cover = ensure_flat_cover(&root, &title, book.cover.as_deref(), Some(&path));
            }

            out.push(book);
        }
    }
    out
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> AppSettings {
    load_settings(&app)
}

/// 保存设置：校验模式与目录，创建书库文件夹。
#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    let mut next = settings;
    if next.storage_mode != "history" && next.storage_mode != "library" {
        return Err("存储模式只能是历史或书库".into());
    }
    if next.library_dir.trim().is_empty() {
        next.library_dir = default_library_dir();
    }
    if next.reading_history_dir.trim().is_empty() {
        next.reading_history_dir = default_reading_history_dir();
    }
    if next.final_export_dir.trim().is_empty() {
        next.final_export_dir = default_final_export_dir();
    }
    let mut formats = Vec::new();
    for item in next.import_formats {
        if let Some(ext) = normalize_format(&item) {
            if !formats.contains(&ext) {
                formats.push(ext);
            }
        }
    }
    if formats.is_empty() {
        formats = default_formats();
    }
    next.import_formats = formats;
    next.min_bytes = next.min_bytes.min(200 * 1024 * 1024);
    for (label, dir) in [
        ("本地书库", &next.library_dir),
        ("阅读历史", &next.reading_history_dir),
        ("最终成品", &next.final_export_dir),
    ] {
        fs::create_dir_all(PathBuf::from(dir))
            .map_err(|e| format!("无法创建{label}文件夹：{e}"))?;
    }
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建设置目录：{e}"))?;
    }
    let json = serde_json::to_string_pretty(&next).map_err(|e| format!("序列化设置失败：{e}"))?;
    fs::write(path, json).map_err(|e| format!("写入设置失败：{e}"))?;
    Ok(next)
}

/// 把本地文件导入书架：书库模式复制副本，历史模式只登记原路径。
#[tauri::command]
fn import_book(
    app: tauri::AppHandle,
    path: String,
    group: Option<String>,
    force_history: Option<bool>,
) -> Result<BookMeta, String> {
    let settings = load_settings(&app);
    if force_history.unwrap_or(false) || settings.keep_original || settings.storage_mode == "history"
    {
        return Ok(record_history(&app, &path)?.to_book());
    }
    let book = import_library(&app, &path, group)?;
    Ok(book)
}

/// 打开磁盘上的书：书库模式复制入库，历史模式只登记路径；两种模式都会更新最近打开时间。
#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<BookMeta, String> {
    let settings = load_settings(&app);
    if settings.storage_mode == "history" || settings.keep_original {
        let entry = record_history(&app, &path)?;
        return Ok(entry.to_book());
    }
    let group = None;
    let mut book = import_library(&app, &path, group)?;
    let stamp = now_millis();
    book.last_opened_at = Some(stamp);
    if let Ok(dir) = book_dir(&app, &book.id) {
        let json = serde_json::to_string_pretty(&book).map_err(|e| format!("序列化书目失败：{e}"))?;
        let _ = fs::write(dir.join("meta.json"), json);
    }
    Ok(book)
}

/// 更新“最近打开时间”，书架据此排序与判断是否读过。
#[tauri::command]
fn touch_book(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let stamp = now_millis();
    if let Some(entry) = find_history_entry(&app, &id) {
        let mut entries = read_history(&app);
        for item in entries.iter_mut() {
            if item.id == entry.id {
                item.last_opened_at = stamp;
            }
        }
        return write_history(&app, &entries);
    }
    let dir = book_dir(&app, &id)?;
    let meta_path = dir.join("meta.json");
    let text = fs::read_to_string(&meta_path).map_err(|e| format!("读取书目失败：{e}"))?;
    let mut book: BookMeta = serde_json::from_str(&text).map_err(|e| format!("解析书目失败：{e}"))?;
    book.last_opened_at = Some(stamp);
    let json = serde_json::to_string_pretty(&book).map_err(|e| format!("序列化书目失败：{e}"))?;
    fs::write(&meta_path, json).map_err(|e| format!("写入书目失败：{e}"))
}

/// 列出书架：固定书库里的书 + 历史模式登记的书。
#[tauri::command]
fn list_books(app: tauri::AppHandle) -> Result<Vec<BookMeta>, String> {
    migrate_legacy_books(&app)?;
    let mut out = list_library_books(&app);
    for entry in read_history(&app) {
        out.push(entry.to_book());
    }
    Ok(out)
}

/// 读取某本书的原始字节（书库副本或历史原文件）。
#[tauri::command]
fn read_book_bytes(app: tauri::AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    let book = find_book(&app, &id).ok_or_else(|| "书架上找不到这条书目".to_string())?;
    let path = book_source_path(&app, &book)?;
    let bytes = fs::read(&path).map_err(|e| format!("读取书目失败：{e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 递归扫描文件夹，供导入弹窗一次列出所有可导入文件。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanItem {
    path: String,
    title: String,
    format: String,
    byte_len: u64,
    group: String,
}

fn walk_scan(dir: &Path, depth: usize, formats: &[String], min_bytes: u64, out: &mut Vec<ScanItem>) {
    if depth > 6 || out.len() >= 4000 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "$RECYCLE.BIN" {
            continue;
        }
        if path.is_dir() {
            walk_scan(&path, depth + 1, formats, min_bytes, out);
            continue;
        }
        let Some(ext) = path
            .extension()
            .and_then(|e| e.to_str())
            .and_then(normalize_format)
        else {
            continue;
        };
        if !formats.contains(&ext) {
            continue;
        }
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.len() < min_bytes || meta.len() > 200 * 1024 * 1024 {
            continue;
        }
        let group = path
            .parent()
            .and_then(|parent| parent.strip_prefix(dir).ok())
            .and_then(|rel| rel.components().next())
            .map(|part| part.as_os_str().to_string_lossy().to_string())
            .unwrap_or_default();
        out.push(ScanItem {
            path: path.to_string_lossy().to_string(),
            title: file_title(&path),
            format: ext,
            byte_len: meta.len(),
            group,
        });
    }
}

#[tauri::command]
fn scan_books(
    dir: String,
    formats: Vec<String>,
    min_bytes: u64,
) -> Result<Vec<ScanItem>, String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err("选择的不是文件夹".into());
    }
    let formats: Vec<String> = formats
        .iter()
        .filter_map(|item| normalize_format(item))
        .collect();
    let mut out = Vec::new();
    walk_scan(&root, 0, &formats, min_bytes, &mut out);
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// 三个默认文件夹，供设置面板「恢复默认」使用。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DefaultDirs {
    library: String,
    reading_history: String,
    final_export: String,
}

#[tauri::command]
fn default_dirs() -> DefaultDirs {
    DefaultDirs {
        library: default_library_dir(),
        reading_history: default_reading_history_dir(),
        final_export: default_final_export_dir(),
    }
}

/// 在资源管理器里打开任意已配置文件夹（不存在则先创建）。
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if dir.as_os_str().is_empty() {
        return Err("文件夹路径为空".into());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建文件夹：{e}"))?;
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("无法打开资源管理器：{e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &dir;
    }
    Ok(())
}

/// 在资源管理器里打开书库文件夹。
#[tauri::command]
fn open_library_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = books_root(&app)?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("无法打开资源管理器：{e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &dir;
    }
    Ok(())
}

/// 一本书对应的封面目录（扁平模型在根 covers/，旧模型在子目录）
fn cover_dir(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if find_history_entry(app, id).is_some() {
        if !valid_id(id) {
            return Err("书目编号不合法".into());
        }
        let dir = history_covers_dir(app)?.join(id);
        fs::create_dir_all(&dir).map_err(|e| format!("无法创建封面目录：{e}"))?;
        return Ok(dir);
    }

    // 优先：扁平模型 covers/ 根目录
    let root = books_root(app)?;
    let flat = root.join("covers");
    if flat.is_dir() {
        return Ok(flat);
    }

    // 旧模型兼容
    let dir = book_dir(app, id)?;
    if !dir.exists() {
        return Err("书架上找不到这本书".into());
    }
    Ok(dir)
}

fn write_cover_meta(app: &tauri::AppHandle, id: &str, name: &str) -> Result<(), String> {
    if find_history_entry(app, id).is_some() {
        let mut entries = read_history(app);
        for entry in entries.iter_mut() {
            if entry.id == id {
                entry.cover = Some(name.to_string());
            }
        }
        return write_history(app, &entries);
    }
    let dir = book_dir(app, id)?;
    let meta_path = dir.join("meta.json");
    let text = fs::read_to_string(&meta_path).map_err(|e| format!("读取书目失败：{e}"))?;
    let mut book: BookMeta =
        serde_json::from_str(&text).map_err(|e| format!("解析书目失败：{e}"))?;
    book.cover = Some(name.to_string());
    let json = serde_json::to_string_pretty(&book).map_err(|e| format!("序列化书目失败：{e}"))?;
    fs::write(&meta_path, json).map_err(|e| format!("写入书目失败：{e}"))
}

/// 保存前端从 EPUB 中抽出的封面。
/// 扁平书库用「书名.ext」命名（与自动提取一致），旧模型/历史模式仍写 cover.ext 并登记。
#[tauri::command]
fn save_cover(app: tauri::AppHandle, id: String, base64: String, ext: String) -> Result<(), String> {
    use base64::Engine as _;
    let clean: String = ext
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(4)
        .collect();
    if !matches!(clean.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif") {
        return Err("不支持的封面格式".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| format!("封面数据损坏：{e}"))?;
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
        return Err("封面尺寸异常，未保存".into());
    }
    // 必须是真的图片，避免把 xhtml 之类的页面写进封面目录
    let real_ext = sniff_image(&bytes).ok_or("封面数据不是有效图片")?;
    let dir = cover_dir(&app, &id)?;
    let book = find_book(&app, &id);
    let is_history = find_history_entry(&app, &id).is_some();
    let flat = !is_history
        && book
            .as_ref()
            .and_then(|b| b.path.as_deref())
            .map(|p| Path::new(p).is_file())
            .unwrap_or(false);
    let name = if flat {
        format!(
            "{}.{}",
            sanitize_filename(book.as_ref().map(|b| b.title.as_str()).unwrap_or("")),
            real_ext
        )
    } else {
        format!("cover.{real_ext}")
    };
    fs::write(dir.join(&name), &bytes).map_err(|e| format!("写入封面失败：{e}"))?;
    if flat {
        return Ok(());
    }
    write_cover_meta(&app, &id, &name)
}

/// 读取书目封面原始字节（没有封面时返回空响应）。
/// 只认真正的图片：磁盘上残留的 xhtml / 损坏文件会被忽略并重新提取。
#[tauri::command]
fn read_cover(app: tauri::AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    let book = find_book(&app, &id).ok_or("书架上找不到这条书目")?;
    let dir = cover_dir(&app, &id)?;

    // ① 书目登记的封面必须通过魔数校验
    if let Some(name) = book.cover.as_deref() {
        if let Some((_ext, bytes)) = valid_cover_file(&dir.join(name)) {
            return Ok(tauri::ipc::Response::new(bytes));
        }
    }

    // ② 没有有效缓存 → 从源 EPUB 实时提取并回写
    if let Some((ext, bytes)) = try_extract_cover_from_book(&app, &book) {
        let fname = format!("{}.{}", sanitize_filename(&book.title), ext);
        if fs::create_dir_all(&dir).is_ok() {
            let _ = fs::write(dir.join(&fname), &bytes);
        }
        let _ = write_cover_meta(&app, &id, &fname);
        return Ok(tauri::ipc::Response::new(bytes));
    }

    Ok(tauri::ipc::Response::new(Vec::<u8>::new()))
}

/// 尝试从书的源 epub 文件里实时提取封面（不缓存）
fn try_extract_cover_from_book(app: &tauri::AppHandle, book: &BookMeta) -> Option<(String, Vec<u8>)> {
    if book.format != "epub" { return None; }
    let Ok(epub_path) = book_source_path(app, book) else { return None };
    let bytes = fs::read(&epub_path).ok()?;
    extract_epub_cover(&bytes)
}

// ─── 封面记录表与书架自检 ───

/// 磁盘上的封面必须是真图片；xhtml、空文件、损坏数据一律视为无效。
fn valid_cover_file(path: &Path) -> Option<(String, Vec<u8>)> {
    let bytes = fs::read(path).ok()?;
    let ext = sniff_image(&bytes)?;
    Some((ext.to_string(), bytes))
}

/// 在 covers/ 里找按书名命名的有效封面（上次提取后书目没来得及登记也能认领）。
fn find_cached_cover(root: &Path, safe: &str) -> Option<String> {
    for ext in ["jpg", "jpeg", "png", "webp", "gif"] {
        let name = format!("{safe}.{ext}");
        if valid_cover_file(&root.join("covers").join(&name)).is_some() {
            return Some(name);
        }
    }
    None
}

/// 确保扁平书库这本书有可用封面：有效缓存复用 → 规范名认领 → 从 EPUB 重新提取。
fn ensure_flat_cover(
    root: &Path,
    title: &str,
    existing: Option<&str>,
    source: Option<&Path>,
) -> Option<String> {
    let safe = sanitize_filename(title);

    if let Some(name) = existing {
        if valid_cover_file(&root.join("covers").join(name)).is_some() {
            return Some(name.to_string());
        }
    }
    if let Some(name) = find_cached_cover(root, &safe) {
        return Some(name);
    }

    let source = source?;
    if source.extension().and_then(|e| e.to_str()) != Some("epub") {
        return None;
    }
    let bytes = fs::read(source).ok()?;
    let (ext, img) = extract_epub_cover(&bytes)?;
    ensure_covers_dir(root).ok()?;
    let name = format!("{safe}.{ext}");
    fs::write(root.join("covers").join(&name), &img).ok()?;
    Some(name)
}

/// 书架自检报告
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct ShelfHealthReport {
    /// 本次检查的书目数量
    scanned: usize,
    /// 重新生成/修复封面的数量
    covers_repaired: usize,
    /// 删除的无效或冗余封面文件数
    covers_removed: usize,
    /// 封面修复涉及的书名
    repaired_titles: Vec<String>,
    /// 删除的封面文件名
    removed_files: Vec<String>,
    /// 正文文件缺失的书名
    missing_sources: Vec<String>,
    /// 确实提取不到封面的书名（正文正常但 EPUB 里没有封面图）
    uncovered_titles: Vec<String>,
}

/// 书架自检：启动与「刷新书架」共用。
/// 1) 每本书校验封面，损坏/缺失就重建；2) 清理 covers/ 里的非图片与无主文件；
/// 3) 检查正文文件是否还在，缺失的只在报告里列出（绝不删书）。
#[tauri::command]
fn shelf_health(app: tauri::AppHandle) -> Result<ShelfHealthReport, String> {
    let mut report = ShelfHealthReport::default();
    let Ok(root) = books_root(&app) else {
        return Ok(report);
    };
    let covers = root.join("covers");
    let mut keep: std::collections::HashSet<String> = std::collections::HashSet::new();

    // ① 扁平书库：正文存在性 + 封面修复
    for book in list_library_books(&app) {
        report.scanned += 1;
        let source = book.path.as_ref().map(PathBuf::from);
        if !source.as_ref().map(|p| p.is_file()).unwrap_or(false)
            && book_source_path(&app, &book).is_err()
        {
            report.missing_sources.push(book.title.clone());
            continue;
        }
        // 旧子文件夹模型的封面放在书目录里，这里只管扁平模型
        let Some(source) = source.filter(|p| p.is_file()) else {
            continue;
        };
        if book.format != "epub" {
            continue;
        }
        let title = book.title.clone();
        match ensure_flat_cover(&root, &title, book.cover.as_deref(), Some(&source)) {
            Some(name) => {
                if book.cover.as_deref() != Some(name.as_str()) {
                    report.covers_repaired += 1;
                    report.repaired_titles.push(title.clone());
                }
                keep.insert(name);
                // 同名的其它图片扩展名也算这本书的合法封面，避免误删
                let safe = sanitize_filename(&title);
                for ext in ["jpg", "jpeg", "png", "webp", "gif"] {
                    keep.insert(format!("{safe}.{ext}"));
                }
            }
            None => report.uncovered_titles.push(title),
        }
    }

    // ② 历史模式：封面单独存在 history_covers/<id>/
    let mut history = read_history(&app);
    let mut history_dirty = false;
    if let Ok(hdir) = history_covers_dir(&app) {
        for entry in history.iter_mut() {
            report.scanned += 1;
            if !Path::new(&entry.path).is_file() {
                report.missing_sources.push(entry.title.clone());
                continue;
            }
            if entry.format != "epub" {
                continue;
            }
            let dir = hdir.join(&entry.id);
            let current_ok = entry
                .cover
                .as_ref()
                .and_then(|name| valid_cover_file(&dir.join(name)))
                .is_some();
            if current_ok {
                continue;
            }
            if let Some((ext, img)) = try_extract_cover_from_book(&app, &entry.to_book()) {
                let _ = fs::create_dir_all(&dir);
                let safe = sanitize_filename(&entry.title);
                let name = format!("{safe}.{ext}");
                if fs::write(dir.join(&name), &img).is_ok() {
                    entry.cover = Some(name);
                    history_dirty = true;
                    report.covers_repaired += 1;
                    report.repaired_titles.push(entry.title.clone());
                }
            }
        }
    }
    if history_dirty {
        let _ = write_history(&app, &history);
    }

    // ③ 清理 covers/：非图片文件、以及不属于任何一本书的冗余文件
    if let Ok(entries) = fs::read_dir(&covers) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let is_image = valid_cover_file(&path).is_some();
            if !is_image || !keep.contains(&name) {
                if fs::remove_file(&path).is_ok() {
                    report.covers_removed += 1;
                    report.removed_files.push(name);
                }
            }
        }
    }

    Ok(report)
}

/// 把前端生成的 EPUB 二进制写入用户选定路径。
/// 前端用 base64 传输：Tauri 对 Vec<u8> 会走 JSON 数字数组，几 MB 的书会膨胀数倍。
#[tauri::command]
fn save_epub(path: String, base64: String) -> Result<u64, String> {
    use base64::Engine as _;
    let target = PathBuf::from(&path);
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "epub" | "txt" | "md" | "html") {
        return Err("文件名必须以 .epub / .txt / .md / .html 结尾".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| format!("生成的数据损坏：{e}"))?;
    if bytes.is_empty() {
        return Err("生成的内容为空，未写入文件".into());
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建保存目录：{e}"))?;
        }
    }
    fs::write(&target, &bytes).map_err(|e| format!("写入失败：{e}"))?;
    Ok(bytes.len() as u64)
}

/// 从书架移除一本书：书库模式删副本，历史模式只删登记记录，绝不动用户原文件。
#[tauri::command]
fn delete_book(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if find_history_entry(&app, &id).is_some() {
        let mut entries = read_history(&app);
        entries.retain(|entry| entry.id != id);
        write_history(&app, &entries)?;
        let covers = history_covers_dir(&app)?.join(&id);
        let _ = fs::remove_dir_all(covers);
        return Ok(());
    }
    let dir = book_dir(&app, &id)?;
    if !dir.exists() {
        return Ok(());
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("删除失败：{e}"))
}

/// 一条锻造版本记录。`source_bytes` 是保存前源文件的字节数。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RevisionMeta {
    id: String,
    created_at: i64,
    label: String,
    source_bytes: u64,
    note: String,
}

/// 版本目录：<书目>/revisions/，不存在时创建。
fn revisions_dir(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    let dir = book_dir(app, id)?.join("revisions");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建版本目录：{e}"))?;
    Ok(dir)
}

/// 生成不冲突的版本号（毫秒时间戳，冲突时追加序号）。
fn unique_revision_id(dir: &Path) -> String {
    let stamp = now_millis();
    let mut id = stamp.to_string();
    let mut n = 1;
    while dir.join(format!("{id}.json")).exists() || dir.join(format!("{id}.source")).exists() {
        id = format!("{stamp}-{n}");
        n += 1;
    }
    id
}

/// 把当前 source.txt 与 forge.json 快照到版本目录，返回快照字节数。
fn snapshot_current(
    dir: &Path,
    rev: &str,
    source: &Path,
    forge: &Path,
) -> Result<u64, String> {
    let bytes = fs::read(source).map_err(|e| format!("无法读取当前源文件：{e}"))?;
    fs::write(dir.join(format!("{rev}.source")), &bytes)
        .map_err(|e| format!("无法写入版本快照：{e}"))?;
    let forge_bytes = fs::read(forge).unwrap_or_default();
    fs::write(dir.join(format!("{rev}.forge.json")), &forge_bytes)
        .map_err(|e| format!("无法写入覆盖层快照：{e}"))?;
    Ok(bytes.len() as u64)
}

fn write_revision_meta(dir: &Path, meta: &RevisionMeta) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta)
        .map_err(|e| format!("序列化版本记录失败：{e}"))?;
    fs::write(dir.join(format!("{}.json", meta.id)), json)
        .map_err(|e| format!("写入版本记录失败：{e}"))
}

/// 只保留最近 keep 条版本，其余连快照一起删除。
fn prune_revisions(dir: &Path, keep: usize) -> Result<(), String> {
    let mut metas: Vec<RevisionMeta> = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("读取版本目录失败：{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") || name.ends_with(".forge.json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(meta) = serde_json::from_str::<RevisionMeta>(&text) {
            metas.push(meta);
        }
    }
    if metas.len() <= keep {
        return Ok(());
    }
    metas.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    for meta in metas.into_iter().skip(keep) {
        let _ = fs::remove_file(dir.join(format!("{}.json", meta.id)));
        let _ = fs::remove_file(dir.join(format!("{}.source", meta.id)));
        let _ = fs::remove_file(dir.join(format!("{}.forge.json", meta.id)));
    }
    Ok(())
}

/// 列出某本书的锻造版本，最新的在前。
#[tauri::command]
fn list_revisions(app: tauri::AppHandle, id: String) -> Result<Vec<RevisionMeta>, String> {
    let dir = revisions_dir(&app, &id)?;
    let mut out: Vec<RevisionMeta> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取版本目录失败：{e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") || name.ends_with(".forge.json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(entry.path()) else {
            continue;
        };
        if let Ok(meta) = serde_json::from_str::<RevisionMeta>(&text) {
            out.push(meta);
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

/// 读取当前覆盖层 JSON；没有就返回空串。
#[tauri::command]
fn read_forge_state(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let path = book_dir(&app, &id)?.join("forge.json");
    match fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("读取锻造记录失败：{e}")),
    }
}

/// 保存一次锻造：先把当前源文件与覆盖层存成版本，再写入新内容。
#[tauri::command]
fn commit_forge(
    app: tauri::AppHandle,
    id: String,
    text: String,
    forge: String,
    label: String,
    note: String,
) -> Result<RevisionMeta, String> {
    let dir = book_dir(&app, &id)?;
    let source = dir.join("source.txt");
    if !source.exists() {
        return Err("找不到这本书的源文件，无法写回".into());
    }
    if text.trim().is_empty() {
        return Err("改写后的正文为空，已取消保存".into());
    }
    let rev_dir = revisions_dir(&app, &id)?;
    let rev = unique_revision_id(&rev_dir);
    let source_bytes = snapshot_current(&rev_dir, &rev, &source, &dir.join("forge.json"))?;

    fs::write(&source, text.as_bytes()).map_err(|e| format!("写回源文件失败：{e}"))?;
    fs::write(dir.join("forge.json"), forge.as_bytes())
        .map_err(|e| format!("写入锻造记录失败：{e}"))?;

    let meta = RevisionMeta {
        id: rev,
        created_at: now_millis(),
        label: label.chars().take(60).collect(),
        source_bytes,
        note: note.chars().take(200).collect(),
    };
    write_revision_meta(&rev_dir, &meta)?;
    prune_revisions(&rev_dir, 30)?;
    Ok(meta)
}

/// 读取某个版本保存前的源文件原始字节（可能是 GB18030，前端自行嗅探）。
#[tauri::command]
fn read_revision(
    app: tauri::AppHandle,
    id: String,
    rev: String,
) -> Result<tauri::ipc::Response, String> {
    if !valid_id(&rev) {
        return Err("版本号不合法".into());
    }
    let path = revisions_dir(&app, &id)?.join(format!("{rev}.source"));
    let bytes = fs::read(&path).map_err(|e| format!("读取版本失败：{e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 回滚到某个版本：先给当前状态自动存档，再恢复目标版本的源文件与覆盖层。
#[tauri::command]
fn restore_revision(app: tauri::AppHandle, id: String, rev: String) -> Result<RevisionMeta, String> {
    if !valid_id(&rev) {
        return Err("版本号不合法".into());
    }
    let dir = book_dir(&app, &id)?;
    let source = dir.join("source.txt");
    let rev_dir = revisions_dir(&app, &id)?;
    let snapshot = rev_dir.join(format!("{rev}.source"));
    if !snapshot.exists() {
        return Err("这个版本没有源文件快照，无法回滚".into());
    }

    let auto_rev = unique_revision_id(&rev_dir);
    let bytes = snapshot_current(&rev_dir, &auto_rev, &source, &dir.join("forge.json"))?;
    let meta = RevisionMeta {
        id: auto_rev,
        created_at: now_millis(),
        label: "回滚前自动存档".into(),
        source_bytes: bytes,
        note: format!("回滚到版本 {rev} 之前的状态"),
    };
    write_revision_meta(&rev_dir, &meta)?;

    let target = fs::read(&snapshot).map_err(|e| format!("读取版本快照失败：{e}"))?;
    fs::write(&source, &target).map_err(|e| format!("恢复源文件失败：{e}"))?;
    let forge = fs::read(rev_dir.join(format!("{rev}.forge.json"))).unwrap_or_default();
    fs::write(dir.join("forge.json"), forge).map_err(|e| format!("恢复锻造记录失败：{e}"))?;

    prune_revisions(&rev_dir, 30)?;
    Ok(meta)
}

// ───────────────────────────── 翻译（R7） ─────────────────────────────

/// 翻译请求：兼容 OpenAI 风格的 /chat/completions 接口。
/// 在线与本地引擎走同一套协议，区别只在地址、密钥与模型。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslateRequest {
    endpoint: String,
    #[serde(default)]
    api_key: String,
    model: String,
    system: String,
    user: String,
    #[serde(default)]
    temperature: Option<f32>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslateReply {
    text: String,
    /// 实际请求的完整地址，便于界面排查
    url: String,
    elapsed_ms: u64,
}

fn normalize_endpoint(raw: &str) -> String {
    raw.trim().trim_end_matches('/').to_string()
}

/// 调用一次翻译接口。失败时返回中文可读原因，前端据此决定是否降级到本地。
#[tauri::command]
fn translate_text(req: TranslateRequest) -> Result<TranslateReply, String> {
    let started = Instant::now();
    let endpoint = normalize_endpoint(&req.endpoint);
    if endpoint.is_empty() {
        return Err("还没有填写翻译接口地址".into());
    }
    if req.model.trim().is_empty() {
        return Err("还没有填写模型名".into());
    }
    if req.user.trim().is_empty() {
        return Err("没有需要翻译的原文".into());
    }
    let url = if endpoint.ends_with("/chat/completions") {
        endpoint.clone()
    } else {
        format!("{endpoint}/chat/completions")
    };
    let timeout = Duration::from_millis(
        req.timeout_ms.unwrap_or(90_000).clamp(5_000, 600_000),
    );

    let body = serde_json::json!({
        "model": req.model.trim(),
        "temperature": req.temperature.unwrap_or(0.3),
        "messages": [
            { "role": "system", "content": req.system },
            { "role": "user", "content": req.user }
        ]
    });

    let mut request = ureq::post(&url).timeout(timeout);
    if !req.api_key.trim().is_empty() {
        request = request.set("Authorization", &format!("Bearer {}", req.api_key.trim()));
    }
    let response = request.send_json(body).map_err(|err| match err {
        ureq::Error::Status(code, resp) => {
            let detail: String = resp.into_string().unwrap_or_default().chars().take(300).collect();
            match code {
                401 | 403 => format!("接口鉴权失败（{code}）：请检查 API Key 与权限"),
                429 => format!("接口限流或额度不足（429）：{detail}"),
                _ => format!("翻译接口返回 {code}：{detail}"),
            }
        }
        ureq::Error::Transport(t) => format!("连接翻译接口失败：{t}"),
    })?;

    let value: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("翻译接口返回的不是合法 JSON：{e}"))?;
    let text = value
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "翻译接口没有返回译文".to_string())?;

    Ok(TranslateReply {
        text,
        url,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 术语表与翻译记忆都放在应用数据目录的 translate/ 下，跨书共用。
fn translate_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_data(app)?.join("translate");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建翻译数据目录：{e}"))?;
    Ok(dir)
}

fn read_optional_text(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("读取 {} 失败：{e}", path.display())),
    }
}

#[tauri::command]
fn read_glossary(app: tauri::AppHandle) -> Result<String, String> {
    read_optional_text(&translate_dir(&app)?.join("glossary.json"))
}

#[tauri::command]
fn write_glossary(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = translate_dir(&app)?.join("glossary.json");
    fs::write(&path, json).map_err(|e| format!("保存术语表失败：{e}"))
}

#[tauri::command]
fn read_translation_memory(app: tauri::AppHandle) -> Result<String, String> {
    read_optional_text(&translate_dir(&app)?.join("memory.json"))
}

#[tauri::command]
fn write_translation_memory(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = translate_dir(&app)?.join("memory.json");
    fs::write(&path, json).map_err(|e| format!("保存翻译记忆失败：{e}"))
}

/// 术语表导入导出用的通用文本读写；只给本地用户操作，不暴露网络。
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取文件失败：{e}"))
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    fs::write(&path, content).map_err(|e| format!("写入文件失败：{e}"))
}

/// EPUBCheck 一次校验的结果（与前端 types.ts 的 EpubCheckResult 对应）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpubCheckResult {
    /// 没有错误也没有致命错误（警告不算失败）
    ok: bool,
    exit_code: i32,
    fatals: u32,
    errors: u32,
    warnings: u32,
    infos: u32,
    /// 本次实际使用的运行环境：内置 JRE / 系统 Java
    runtime: String,
    elapsed_ms: u64,
    /// 逐条消息（FATAL/ERROR/WARNING/INFO 开头）
    lines: Vec<String>,
    raw: String,
}

/// 按相对路径列出候选位置：资源目录 → 源码目录（开发期）→ 可执行文件同级。
fn resource_paths(app: &tauri::AppHandle, rel: &str) -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        list.push(dir.join(rel));
    }
    list.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(rel),
    );
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            list.push(parent.join(rel));
            list.push(parent.join("resources").join(rel));
        }
    }
    list
}

fn first_existing(app: &tauri::AppHandle, rel: &str) -> Option<PathBuf> {
    resource_paths(app, rel).into_iter().find(|p| p.exists())
}

/// 执行 EPUBCheck：stdout / stderr 各开一个线程读完，主线程轮询超时。
fn run_epubcheck(
    java: &Path,
    jar: &Path,
    book: &Path,
    timeout: Duration,
) -> Result<(i32, String, u64), String> {
    use std::io::Read;

    let mut cmd = Command::new(java);
    cmd.arg("-Dfile.encoding=UTF-8")
        .arg("-Dstdout.encoding=UTF-8")
        .arg("-Dstderr.encoding=UTF-8")
        .arg("-jar")
        .arg(jar)
        .arg(book)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let started = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 EPUBCheck：{e}"))?;

    let collect = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = pipe.read_to_string(&mut buf);
            buf
        })
    };
    let out_thread = child
        .stdout
        .take()
        .map(|pipe| collect(Box::new(pipe)));
    let err_thread = child
        .stderr
        .take()
        .map(|pipe| collect(Box::new(pipe)));

    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("等待 EPUBCheck 结束失败：{e}"))?
        {
            break Some(status);
        }
        if started.elapsed() > timeout {
            timed_out = true;
            let _ = child.kill();
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(120));
    };

    let mut out = String::new();
    let mut err = String::new();
    if let Some(handle) = out_thread {
        out = handle.join().unwrap_or_default();
    }
    if let Some(handle) = err_thread {
        err = handle.join().unwrap_or_default();
    }

    let code = status.and_then(|s| s.code()).unwrap_or(if timed_out { -1 } else { 1 });
    let mut raw = String::new();
    if timed_out {
        raw.push_str(&format!(
            "校验超时（超过 {} 秒），已终止进程。\n",
            timeout.as_secs()
        ));
    }
    raw.push_str(&out);
    if !err.is_empty() {
        if !raw.is_empty() && !raw.ends_with('\n') {
            raw.push('\n');
        }
        raw.push_str(&err);
    }
    Ok((code, raw, started.elapsed().as_millis() as u64))
}

/// 用内置 EPUBCheck 校验书架上的一本 EPUB（书库副本与历史引用都支持）。
#[tauri::command]
fn check_epub(app: tauri::AppHandle, id: String) -> Result<EpubCheckResult, String> {
    let book = find_book(&app, &id).ok_or_else(|| "书架上找不到这本书".to_string())?;
    if normalize_format(&book.format).as_deref() != Some("epub") {
        return Err("EPUBCheck 只能检查 EPUB".into());
    }
    let target = book_source_path(&app, &book)?;

    let jar = first_existing(&app, "epubcheck/epubcheck.jar")
        .ok_or_else(|| "应用内缺少 epubcheck.jar，请检查 resources 目录".to_string())?;
    let (java, runtime) = match first_existing(&app, "runtime/bin/java.exe") {
        Some(path) => (path, "内置 JRE".to_string()),
        None => (PathBuf::from("java"), "系统 Java".to_string()),
    };

    let (exit_code, raw, elapsed_ms) = run_epubcheck(&java, &jar, &target, Duration::from_secs(90))?;

    let lines: Vec<String> = raw
        .lines()
        .map(|line| line.trim_end().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    let count = |prefix: &str| {
        lines
            .iter()
            .filter(|line| line.trim_start().starts_with(prefix))
            .count() as u32
    };
    let fatals = count("FATAL(");
    let errors = count("ERROR(");
    let warnings = count("WARNING(");
    let infos = count("INFO(");

    Ok(EpubCheckResult {
        ok: exit_code == 0 && fatals == 0 && errors == 0,
        exit_code,
        fatals,
        errors,
        warnings,
        infos,
        runtime,
        elapsed_ms,
        lines,
        raw,
    })
}

// ──────────────────────────────────────────────────────
// EPUB 编辑器命令（E1 阶段）
// ──────────────────────────────────────────────────────

/// 为一个 origin_path 生成唯一的编辑工作副本目录（放回路径）
/// 书库内的：library/<id>/edit/
/// 外部 EPUB：<app_data_dir>/edit-projects/<timestamp>/edit/
#[tauri::command]
fn make_edit_dir(origin_path: String) -> Result<String, String> {
    let src = PathBuf::from(&origin_path);
    let parent = src.parent().ok_or("源路径无父目录")?.to_path_buf();

    // 判断是否在书库内（路径里有 library/ 目录且上一级有 meta.json）
    let mut check = parent.clone();
    let mut is_library = false;
    for _ in 0..5 {
        if check.join("meta.json").exists() {
            is_library = true;
            break;
        }
        if let Some(p) = check.parent() { check = p.to_path_buf(); } else { break; }
    }

    if is_library {
        // 书库内：用同级的 edit/ 目录
        let edit_dir = parent.join("edit");
        if !edit_dir.exists() {
            fs::create_dir_all(&edit_dir).map_err(|e| e.to_string())?;
        }
        Ok(edit_dir.to_string_lossy().to_string())
    } else {
        // 外部 EPUB：放 app_data_dir 下
        let proj_dir = dirs::data_local_dir()
            .unwrap_or_else(|| std::env::temp_dir())
            .join("scrollforge")
            .join("edit-projects")
            .join(chrono_now_str());
        fs::create_dir_all(&proj_dir).map_err(|e| e.to_string())?;
        let edit_dir = proj_dir.join("edit");
        fs::create_dir_all(&edit_dir).map_err(|e| e.to_string())?;
        Ok(edit_dir.to_string_lossy().to_string())
    }
}

/// 打开 EPUB（书库内或磁盘任意路径）→ 解包 → 返回工作副本信息与文件树
#[tauri::command]
fn edit_open_epub(epub_path: String, edit_dir: String) -> Result<EditWorkspace, String> {
    let src = PathBuf::from(&epub_path);
    if !src.exists() {
        return Err(format!("源文件不存在: {}", epub_path));
    }
    // 安全校验（先不解包，先扫一遍 ZIP）
    let bytes = fs::read(&src).map_err(|e| e.to_string())?;
    ee::validate_epub(&bytes)?;

    let edit_path = PathBuf::from(&edit_dir);
    let ws = ee::unpack_epub(&src, &edit_path)?;
    Ok(ws)
}

/// 列出工作副本里的文件树（返回 _index.json 或直接扫描 edit_dir）
#[tauri::command]
fn edit_list_files(edit_dir: String) -> Result<Vec<ee::EntryInfo>, String> {
    let edit_path = PathBuf::from(&edit_dir);
    let index_path = edit_path.join("_index.json");
    if index_path.exists() {
        let bytes = fs::read(&index_path).map_err(|e| e.to_string())?;
        let list: Vec<ee::EntryInfo> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        return Ok(list);
    }
    // 回退：扫目录 + 算 CRC
    let mut list = Vec::new();
    let walker = walk_entries(&edit_path, &edit_path, &mut list).ok();
    let _ = walker;
    Ok(list)
}

fn walk_entries(base: &Path, dir: &Path, out: &mut Vec<ee::EntryInfo>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if let Some(n) = path.file_name() {
            if n == "_index.json" || n == "_blocks.json" { continue; }
        }
        let rel = path.strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");

        if path.is_dir() {
            walk_entries(base, &path, out)?;
        } else {
            let data = fs::read(&path).map_err(|e| e.to_string())?;
            let mime = ee::infer_mime_str(&rel);
            let role = ee::infer_role_str(&rel, &mime);
            let crc = crc32(&data);
            out.push(ee::EntryInfo {
                path: rel,
                media_type: mime,
                id: None,
                role,
                size: data.len() as u64,
                crc,
                compressed: data.len() as u64,
                stored: true,
            });
        }
    }
    Ok(())
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xffffffff;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ (if crc & 1 != 0 { 0xedb88320 } else { 0 });
        }
    }
    crc ^ 0xffffffff
}

/// 读取工作副本里的文件（文本或 base64）
#[tauri::command]
fn edit_read_file(edit_dir: String, rel_path: String) -> Result<ee::FileContent, String> {
    let edit_path = PathBuf::from(&edit_dir);
    let full = edit_path.join(&rel_path);

    // 安全：不许路径穿越
    let full_normalized = full.canonicalize().map_err(|e| e.to_string())?;
    let edit_normalized = edit_path.canonicalize().map_err(|e| e.to_string())?;
    if !full_normalized.starts_with(&edit_normalized) {
        return Err("路径越界：不允许访问工作副本之外的文件".into());
    }

    let data = fs::read(&full).map_err(|e| e.to_string())?;
    let mime = ee::infer_mime_str(&rel_path);
    let is_binary = !mime.starts_with("text/") && !mime.contains("xml") && !mime.contains("javascript") && !mime.contains("json");

    if is_binary {
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data);
        Ok(ee::FileContent {
            rel_path: rel_path.replace('\\', "/"),
            mime,
            text: None,
            base64: Some(b64),
            size: data.len() as u64,
        })
    } else {
        let text = String::from_utf8_lossy(&data).to_string();
        Ok(ee::FileContent {
            rel_path: rel_path.replace('\\', "/"),
            mime,
            text: Some(text),
            base64: None,
            size: data.len() as u64,
        })
    }
}

/// 写入工作副本里的文件（文本）
#[tauri::command]
fn edit_write_file(edit_dir: String, rel_path: String, content: String) -> Result<(), String> {
    let edit_path = PathBuf::from(&edit_dir);
    let full = edit_path.join(&rel_path);

    // 安全：不许路径穿越
    let full_normalized = full.canonicalize().map_err(|e| e.to_string())?;
    let edit_normalized = edit_path.canonicalize().map_err(|e| e.to_string())?;
    if !full_normalized.starts_with(&edit_normalized) {
        return Err("路径越界".into());
    }

    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&full, content).map_err(|e| e.to_string())?;
    Ok(())
}

/// 保存 = 先快照旧包 → 从工作副本重打包 → 原子替换 / 另存为
#[tauri::command]
fn edit_save(edit_dir: String, output_path: String, create_revision: bool) -> Result<(), String> {
    let edit_path = PathBuf::from(&edit_dir);
    let out = PathBuf::from(&output_path);

    // 快照旧包（如果是覆盖保存且目标存在）
    if create_revision && out.exists() {
        let rev_dir = edit_path.parent().unwrap().join("revisions");
        fs::create_dir_all(&rev_dir).ok();
        let ts = chrono_now_str();
        let rev_name = format!("{}_{}.source", ts, out.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default());
        let rev_path = rev_dir.join(&rev_name);
        fs::copy(&out, &rev_path).map_err(|e| format!("快照失败: {}", e))?;
    }

    // 重打包
    ee::pack_epub(&edit_path, &out)?;
    Ok(())
}

fn chrono_now_str() -> String {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{}", t)
}

/// 内置 epubcheck（三层）
#[tauri::command]
fn edit_check(epub_path: String) -> Result<Vec<CheckResult>, String> {
    let p = PathBuf::from(&epub_path);
    ee::run_epubcheck(&p)
}

/// 读任意图片做预览（E2 选择新封面时用）
#[tauri::command]
fn preview_image(path: String) -> Result<ee::FileContent, String> {
    let p = PathBuf::from(&path);
    let bytes = fs::read(&p).map_err(|e| format!("读图片失败: {}", e))?;
    let mime = ee::infer_mime_str(&p.to_string_lossy());
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    Ok(ee::FileContent {
        rel_path: path,
        mime,
        text: None,
        base64: Some(b64),
        size: bytes.len() as u64,
    })
}

/// E2：写回 OPF 元数据（书名 / 作者 / 语言 / 封面），只改工作副本，打包仍走 edit_save
#[tauri::command]
fn edit_update_metadata(
    edit_dir: String,
    opf_path: String,
    title: String,
    creator: String,
    language: String,
    cover_path: Option<String>,
) -> Result<ee::OpfMetadata, String> {
    let edit_path = PathBuf::from(&edit_dir);
    let cover = cover_path.map(PathBuf::from);
    ee::apply_metadata(
        &edit_path,
        &opf_path,
        &title,
        &creator,
        &language,
        cover.as_deref(),
    )
}

/// E3：读取目录树（nav 优先，ncx 兜底）
#[tauri::command]
fn edit_read_toc(edit_dir: String, opf_path: String) -> Result<ee::TocDocument, String> {
    let edit_path = PathBuf::from(&edit_dir);
    ee::read_toc(&edit_path, &opf_path)
}

/// E3：写回目录树（nav + ncx 同步重建，可选按目录顺序重排 spine）
#[tauri::command]
fn edit_write_toc(
    edit_dir: String,
    opf_path: String,
    tree: Vec<ee::TocNode>,
    sync_spine: bool,
) -> Result<ee::TocDocument, String> {
    let edit_path = PathBuf::from(&edit_dir);
    ee::write_toc(&edit_path, &opf_path, &tree, sync_spine)
}

/// E3：重命名/移动工作副本内文件，同步 OPF/nav/ncx/书内相对链接
#[tauri::command]
fn edit_rename_file(
    edit_dir: String,
    opf_path: String,
    from_path: String,
    to_path: String,
) -> Result<Vec<String>, String> {
    let edit_path = PathBuf::from(&edit_dir);
    ee::rename_file(&edit_path, &opf_path, &from_path, &to_path)
}

/// E3：全书扫描（未使用图片 / 孤儿文件 / 重复 id / 断链 / 目录与 spine 不一致）
#[tauri::command]
fn edit_scan_report(edit_dir: String, opf_path: String) -> Result<ee::ScanReport, String> {
    let edit_path = PathBuf::from(&edit_dir);
    ee::scan_report(&edit_path, &opf_path)
}

// ──────────────────────────────────────────────────────
// E6：块级回写与版本回滚
// ──────────────────────────────────────────────────────

/// 一条 EPUB 编辑快照（edit_save 覆盖保存前写入 revisions/）
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EpubRevision {
    name: String,
    created_at: i64,
    size: u64,
}

fn edit_revisions_dir(edit_path: &Path) -> PathBuf {
    edit_path
        .parent()
        .unwrap_or(edit_path)
        .join("revisions")
}

/// 列出工作副本旁边的历史快照（最新的在前）
#[tauri::command]
fn edit_list_revisions(edit_dir: String) -> Result<Vec<EpubRevision>, String> {
    let edit_path = PathBuf::from(&edit_dir);
    let dir = edit_revisions_dir(&edit_path);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取版本目录失败：{e}"))?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".source") || name.ends_with(".forge.json") {
            continue;
        }
        let created_at = name
            .split('_')
            .next()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(EpubRevision { name, created_at, size });
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

/// 回滚到某个快照：先把当前 EPUB 自动存档，再恢复到目标快照并重新解包。
#[tauri::command]
fn edit_restore_revision(
    edit_dir: String,
    origin_path: String,
    revision: String,
) -> Result<EditWorkspace, String> {
    if revision.contains('/')
        || revision.contains('\\')
        || revision.contains("..")
        || !revision.ends_with(".source")
    {
        return Err("版本名不合法".into());
    }
    let edit_path = PathBuf::from(&edit_dir);
    let origin = PathBuf::from(&origin_path);
    if !origin.exists() {
        return Err("原 EPUB 不存在，无法回滚".into());
    }
    let dir = edit_revisions_dir(&edit_path);
    let snapshot = dir.join(&revision);
    if !snapshot.exists() {
        return Err("找不到这个历史快照".into());
    }
    // 回滚前自动存档当前文件
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let stem = origin
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "book".into());
    let auto = dir.join(format!("{}_auto_{}.source", stamp, stem));
    fs::create_dir_all(&dir).ok();
    fs::copy(&origin, &auto).map_err(|e| format!("回滚前自动存档失败：{e}"))?;

    fs::copy(&snapshot, &origin).map_err(|e| format!("恢复快照失败：{e}"))?;
    ee::unpack_epub(&origin, &edit_path)
}

/// 扫描章节文件里的可编辑块（与前端 DOMParser 采用同一套规则）
#[tauri::command]
fn edit_scan_blocks(edit_dir: String, rel_path: String) -> Result<Vec<ee::BlockInfo>, String> {
    let edit_path = PathBuf::from(&edit_dir);
    ee::scan_blocks(&edit_path, &rel_path)
}

/// 只回写 dirty 块（未改动块逐字节保留），并做 XML 合法性校验
#[tauri::command]
fn edit_write_blocks(
    edit_dir: String,
    rel_path: String,
    edits: Vec<ee::BlockEdit>,
) -> Result<ee::BlockWriteResult, String> {
    let edit_path = PathBuf::from(&edit_dir);
    ee::write_blocks(&edit_path, &rel_path, &edits)
}

/// S6：ForgePanel EPUB 锻造索引。解压 EPUB → spine 顺序 → 逐 xhtml 分块 → 扁平映射。
/// 返回 text（整本纯文本，供 ForgePanel 段落列表）、analysis（前端 TxtAnalysis 兼容）、
/// flat_blocks（ForgePanel editKey → EPUB rel_path + block_index）、edit_dir（解压目录，后续 edit_write_blocks 用）。
#[tauri::command]
fn forge_epub_index(
    epub_path: String,
    edit_dir: String,
) -> Result<ee::ForgeEpubIndex, String> {
    let src = PathBuf::from(&epub_path);
    if !src.exists() {
        return Err(format!("EPUB 源文件不存在: {}", epub_path));
    }
    let edit = PathBuf::from(&edit_dir);
    ee::forge_epub_index(&src, &edit)
}

/// 判断任意路径是否存在（非 EPUB 生成工作副本时避免覆盖已有编辑成果）
#[tauri::command]
fn file_exists(path: String) -> bool {
    PathBuf::from(path).exists()
}


/// L1 结构自检（mimetype / container / OPF 可解析 / spine 全在 manifest）
#[tauri::command]
fn edit_validate(edit_dir: String) -> Result<Vec<String>, String> {
    let edit_path = PathBuf::from(&edit_dir);
    let mut issues = Vec::new();

    // 1. mimetype
    let mt = edit_path.join("mimetype");
    if !mt.exists() {
        issues.push("缺少 mimetype 条目".into());
    } else {
        let c = fs::read_to_string(&mt).unwrap_or_default();
        if c.trim() != "application/epub+zip" {
            issues.push(format!("mimetype 内容错误: '{}'", c.trim()));
        }
    }

    // 2. container.xml
    let container = edit_path.join("META-INF").join("container.xml");
    if !container.exists() {
        issues.push("缺少 META-INF/container.xml".into());
    }

    // 3. 路径穿越 / 文件大小
    for entry in walk_any(&edit_path) {
        let rel = entry.strip_prefix(&edit_path).map_err(|e| e.to_string())?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str.contains("..") || rel_str.starts_with("..") {
            issues.push(format!("危险路径: {}", rel_str));
        }
    }

    Ok(issues)
}

fn walk_any(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = fs::read_dir(&d) {
            for entry in rd.flatten() {
                let p = entry.path();
                if p.is_dir() { stack.push(p.clone()); }
                else { out.push(p); }
            }
        }
    }
    out
}

// ─── 扁平书库辅助函数（新模型） ───

/// 简单 hash（FNV-1a 64 位，给文件名生成稳定 id 用）
fn simple_hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// 从 zip 包（epub）里尝试读 OPF 标题（轻量，失败返回空）
fn extract_opf_title(epub_bytes: &[u8]) -> Result<String, String> {
    use zip::ZipArchive;
    use std::io::Cursor;
    let mut archive = ZipArchive::new(Cursor::new(epub_bytes))
        .map_err(|e| format!("zip: {e}"))?;

    // 找 container.xml → OPF 路径
    let mut opf_path = String::new();
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).ok();
        let Some(mut f) = f else { continue };
        if f.name() == "META-INF/container.xml" {
            let mut buf = String::new();
            let _ = f.read_to_string(&mut buf);
            if let Some(idx) = buf.find("full-path=\"") {
                let start = idx + 11;
                if let Some(end) = buf[start..].find('"') {
                    opf_path = buf[start..start + end].to_string();
                }
            }
            break;
        }
    }
    if opf_path.is_empty() { return Ok(String::new()); }

    // 读 OPF → 找 dc:title
    let mut opf_content = String::new();
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).ok();
        let Some(mut f) = f else { continue };
        if f.name() == opf_path || f.name().ends_with(&opf_path) {
            let _ = f.read_to_string(&mut opf_content);
            break;
        }
    }
    if opf_content.is_empty() { return Ok(String::new()); }

    // 正则找 <dc:title> 或 <title>
    let title = opf_content
        .split(['>', '<'])
        .skip_while(|s| !s.contains("title"))
        .nth(1)
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(title)
}

/// 单个 manifest 条目的必要属性
struct OpfItemRef {
    id: String,
    href: String,
    media: String,
    props: String,
}

/// 取标签里的属性值（同时兼容双引号与单引号）
fn tag_attr(tag: &str, name: &str) -> Option<String> {
    let mut from = 0;
    while let Some(pos) = tag[from..].find(name) {
        let start = from + pos;
        let before_ok = start == 0 || {
            let b = tag.as_bytes()[start - 1];
            !b.is_ascii_alphanumeric() && b != b'-'
        };
        if before_ok {
            let rest = tag[start + name.len()..].trim_start();
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
        from = start + name.len();
    }
    None
}

/// 扫描 OPF 里所有 <item .../>（自闭合与普通标签都能识别，属性顺序无关）
fn opf_manifest_refs(opf: &str) -> Vec<OpfItemRef> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while let Some(rel) = opf[i..].find("<item") {
        let start = i + rel;
        let tail = &opf[start + 5..];
        if !tail.starts_with(|c: char| c.is_whitespace() || c == '/' || c == '>') {
            i = start + 5;
            continue;
        }
        let Some(gt) = opf[start..].find('>') else { break };
        let end = start + gt;
        let tag = &opf[start..=end];
        let href = tag_attr(tag, "href").unwrap_or_default();
        if !href.is_empty() {
            out.push(OpfItemRef {
                id: tag_attr(tag, "id").unwrap_or_default(),
                href,
                media: tag_attr(tag, "media-type").unwrap_or_default(),
                props: tag_attr(tag, "properties").unwrap_or_default(),
            });
        }
        i = end + 1;
    }
    out
}

/// EPUB2 的 <meta name="cover" content="ID"/>
fn opf_meta_cover_id(opf: &str) -> Option<String> {
    let mut i = 0usize;
    while let Some(rel) = opf[i..].find("<meta") {
        let start = i + rel;
        let tail = &opf[start + 5..];
        if !tail.starts_with(|c: char| c.is_whitespace() || c == '/' || c == '>') {
            i = start + 5;
            continue;
        }
        let Some(gt) = opf[start..].find('>') else { break };
        let end = start + gt;
        let tag = &opf[start..=end];
        if tag_attr(tag, "name").as_deref() == Some("cover") {
            if let Some(id) = tag_attr(tag, "content") {
                if !id.trim().is_empty() {
                    return Some(id.trim().to_string());
                }
            }
        }
        i = end + 1;
    }
    None
}

fn is_image_ext(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp")
}

/// 用魔数判断真实图片类型，避免把 xhtml 当封面缓存
fn sniff_image(data: &[u8]) -> Option<&'static str> {
    if data.len() < 12 || data.len() > 8 * 1024 * 1024 {
        return None;
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        Some("png")
    } else if data.starts_with(b"GIF8") {
        Some("gif")
    } else if &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("webp")
    } else if data.starts_with(b"BM") {
        Some("bmp")
    } else {
        None
    }
}

fn zip_entry_bytes(
    archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
    name: &str,
) -> Option<Vec<u8>> {
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).ok()?;
        if f.name().replace('\\', "/") == name {
            let mut data = Vec::new();
            std::io::Read::read_to_end(&mut f, &mut data).ok()?;
            return Some(data);
        }
    }
    None
}

/// 把相对路径拼到 zip 内目录，并处理 ./ 与 ../
fn join_zip_path(base_dir: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = if rel.starts_with('/') {
        Vec::new()
    } else {
        base_dir.split('/').filter(|s| !s.is_empty()).collect()
    };
    for seg in rel.trim_start_matches('/').split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// 从 XHTML 封面页里找内嵌图片路径
fn image_src_in_xhtml(raw: &str) -> Option<String> {
    let mut i = 0usize;
    while let Some(rel) = raw[i..].find('<') {
        let start = i + rel;
        let tag_end = start + raw[start..].find('>')?;
        let tag = &raw[start..=tag_end];
        let lower = tag.to_ascii_lowercase();
        if lower.starts_with("<img") || lower.starts_with("<image") {
            if let Some(src) = tag_attr(tag, "src").or_else(|| tag_attr(tag, "href")) {
                if !src.starts_with("data:") && !src.contains("://") {
                    return Some(src);
                }
            }
        }
        i = tag_end + 1;
    }
    None
}

/// 从 epub 里提取封面：先按 manifest 找 cover-image，再回退到 cover 页里的 <img>，最后按文件名兜底。
/// 返回值一定经过魔数校验，调用方可以安全地当作图片缓存。
fn extract_epub_cover(epub_bytes: &[u8]) -> Option<(String, Vec<u8>)> {
    use std::io::Cursor;
    use zip::ZipArchive;

    let mut archive = ZipArchive::new(Cursor::new(epub_bytes)).ok()?;

    // container.xml → OPF 路径
    let container = zip_entry_bytes(&mut archive, "META-INF/container.xml")?;
    let container = String::from_utf8_lossy(&container);
    let opf_path = {
        let marker = "full-path=\"";
        let idx = container.find(marker)? + marker.len();
        let end = container[idx..].find('"')?;
        container[idx..idx + end].to_string()
    };
    if opf_path.is_empty() {
        return None;
    }
    let opf_dir = match opf_path.rfind('/') {
        Some(idx) => opf_path[..=idx].to_string(),
        None => String::new(),
    };

    let opf_raw = zip_entry_bytes(&mut archive, &opf_path.replace('\\', "/"))?;
    let opf = String::from_utf8_lossy(&opf_raw);
    let items = opf_manifest_refs(&opf);

    // 候选 1：properties 里带 cover-image
    // 候选 2：EPUB2 meta name="cover" 指向的 id
    // 候选 3：id 含 cover 且 media 是图片
    let mut candidates: Vec<&OpfItemRef> = Vec::new();
    if let Some(item) = items.iter().find(|it| {
        it.props
            .split_whitespace()
            .any(|p| p.eq_ignore_ascii_case("cover-image"))
    }) {
        candidates.push(item);
    }
    if let Some(cid) = opf_meta_cover_id(&opf) {
        if let Some(item) = items.iter().find(|it| it.id == cid) {
            candidates.push(item);
        }
    }
    if let Some(item) = items.iter().find(|it| {
        it.id.to_ascii_lowercase().contains("cover")
            && it.media.to_ascii_lowercase().starts_with("image/")
    }) {
        candidates.push(item);
    }

    for item in candidates {
        let page_full = join_zip_path(&opf_dir, &item.href);
        let ext = page_full.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if is_image_ext(&ext) {
            if let Some(data) = zip_entry_bytes(&mut archive, &page_full) {
                if let Some(real) = sniff_image(&data) {
                    return Some((real.to_string(), data));
                }
            }
            continue;
        }
        // cover.xhtml 之类的封面页 → 从页面里再挖出真正的图片
        if let Some(page) = zip_entry_bytes(&mut archive, &page_full) {
            let page = String::from_utf8_lossy(&page);
            if let Some(src) = image_src_in_xhtml(&page) {
                let img_full = join_zip_path(&opf_dir, &join_zip_path(&page_full, &src));
                if let Some(data) = zip_entry_bytes(&mut archive, &img_full) {
                    if let Some(real) = sniff_image(&data) {
                        return Some((real.to_string(), data));
                    }
                }
            }
        }
    }

    // 最后兜底：zip 里名字带 cover 的图片
    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().replace('\\', "/")))
        .collect();
    for name in names {
        let lower = name.to_ascii_lowercase();
        if lower.contains("cover") && is_image_ext(lower.rsplit('.').next().unwrap_or("")) {
            if let Some(data) = zip_entry_bytes(&mut archive, &name) {
                if let Some(real) = sniff_image(&data) {
                    return Some((real.to_string(), data));
                }
            }
        }
    }
    None
}

fn ensure_covers_dir(root: &Path) -> std::io::Result<PathBuf> {
    let dir = root.join("covers");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect::<String>()
        .chars()
        .take(80)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 取书库里第一本 EPUB 做样本（没有就跳过，保证换机器也能跑）。
    fn sample_epub() -> Option<PathBuf> {
        let candidates = [
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../local book repository/（中译）灭门家族的重生者.epub"),
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../local book repository/（韩）天下第一的爸爸-正篇.epub"),
        ];
        for c in candidates {
            if c.exists() { return Some(c); }
        }
        None
    }

    #[test]
    fn extract_epub_cover_returns_image() {
        let epub_path = match sample_epub() {
            Some(p) => p,
            None => { eprintln!("skip: 找不到测试 EPUB"); return; }
        };
        let bytes = fs::read(&epub_path).expect("read epub");
        let result = extract_epub_cover(&bytes);
        match result {
            Some((ext, img)) => {
                eprintln!("✅ extract_epub_cover OK: ext={}, size={} bytes", ext, img.len());
                assert!(!img.is_empty(), "封面图片不应为空");
                assert!(img.len() > 100, "封面图片太小（疑似垃圾数据）");
            }
            None => {
                eprintln!("❌ extract_epub_cover 返回 None");
                panic!("封面提取失败");
            }
        }
    }

    /// 回归测试：外部 EPUB（OPF 自闭合标签 + cover 页间接引用图片）必须抽到真图片，不能返回 xhtml。
    #[test]
    fn extract_epub_cover_handles_external_opf_books() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../local book repository");
        let samples: Vec<PathBuf> = fs::read_dir(&repo)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("轮回第7次的反派千金"))
                    .unwrap_or(false)
            })
            .collect();
        if samples.is_empty() {
            eprintln!("skip: 书库中没有样本");
            return;
        }
        for path in samples {
            let bytes = fs::read(&path).expect("read epub");
            let (ext, img) = extract_epub_cover(&bytes)
                .unwrap_or_else(|| panic!("封面提取失败：{:?}", path));
            assert!(img.len() > 1000, "封面过小（疑似垃圾数据）：{:?}", path);
            assert!(sniff_image(&img).is_some(), "封面不是有效图片：{:?}", path);
            eprintln!(
                "✅ {} -> {} ({} bytes)",
                path.file_name().unwrap_or_default().to_string_lossy(),
                ext,
                img.len()
            );
        }
    }

    #[test]
    fn bundled_epubcheck_passes_library_book() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR"));
        let java = base.join("resources/runtime/bin/java.exe");
        let jar = base.join("resources/epubcheck/epubcheck.jar");
        if !java.exists() || !jar.exists() {
            eprintln!("跳过：resources 下没有内置运行时");
            return;
        }
        let Some(book) = sample_epub() else {
            eprintln!("跳过：书库中没有样本 EPUB");
            return;
        };

        let (code, raw, elapsed_ms) =
            run_epubcheck(&java, &jar, &book, Duration::from_secs(90)).expect("EPUBCheck 未能启动");
        eprintln!("{raw}");
        assert!(
            code == 0 && !raw.contains("ERROR(") && !raw.contains("FATAL("),
            "EPUBCheck 未通过（退出码 {code}，用时 {elapsed_ms} ms）"
        );
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            start_args,
            read_book,
            import_book,
            list_books,
            shelf_health,
            read_book_bytes,
            save_cover,
            read_cover,
            get_settings,
            save_settings,
            open_path,
            touch_book,
            scan_books,
            default_dirs,
            open_folder,
            open_library_dir,
            save_epub,
            delete_book,
            list_revisions,
            read_forge_state,
            commit_forge,
            read_revision,
            restore_revision,
            translate_text,
            read_glossary,
            write_glossary,
            read_translation_memory,
            write_translation_memory,
            read_text_file,
            write_text_file,
            check_epub,
            make_edit_dir,
            edit_open_epub,
            edit_list_files,
            edit_read_file,
            edit_write_file,
            edit_save,
            edit_check,
            edit_update_metadata,
            edit_read_toc,
            edit_write_toc,
            edit_rename_file,
            edit_scan_report,
            edit_scan_blocks,
            edit_write_blocks,
            edit_list_revisions,
            edit_restore_revision,
            file_exists,
            preview_image,
            edit_validate,
            forge_epub_index
        ])
        .run(tauri::generate_context!())
        .expect("Scrollforge 启动失败");
}
