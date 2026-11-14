// 内置离线翻译引擎：NLLB-200 distilled 600M（ONNX int8）。
//
// 模型不进安装包，首次使用由用户显式触发下载；下载后完全离线推理。
// 权重与 tokenizer 资产沿用 Mangrove 已验证的 HuggingFace 路径，
// 推理流程（encoder → 逐步 greedy 解码）也与其一致。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use ort::session::Session;
use ort::value::Tensor;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokenizers::Tokenizer;

const MIRRORS: [&str; 2] = ["https://huggingface.co", "https://hf-mirror.com"];
const MODEL_ID: &str = "nllb_600m";
const MAX_TOKENS: usize = 200;
const MAX_SOURCE_TOKENS: usize = 480;

struct ModelFile {
    name: &'static str,
    paths: &'static [&'static str],
}

struct ModelDef {
    id: &'static str,
    display: &'static str,
    approx_bytes: u64,
    note: &'static str,
    files: &'static [ModelFile],
}

static MODEL_FILES: [ModelFile; 3] = [
    ModelFile {
        name: "encoder.onnx",
        paths: &["Xenova/nllb-200-distilled-600M/resolve/main/onnx/encoder_model_quantized.onnx"],
    },
    ModelFile {
        name: "decoder.onnx",
        paths: &["Xenova/nllb-200-distilled-600M/resolve/main/onnx/decoder_model_quantized.onnx"],
    },
    ModelFile {
        name: "tokenizer.json",
        paths: &["Xenova/nllb-200-distilled-600M/resolve/main/tokenizer.json"],
    },
];

static MODELS: [ModelDef; 1] = [ModelDef {
    id: MODEL_ID,
    display: "NLLB-200 600M（离线）",
    approx_bytes: 900_000_000,
    note: "约 900MB。支持韩/日/英/中互译，CPU 推理；首次下载后完全离线。",
    files: &MODEL_FILES,
}];

/// NLLB 的语言标记名（必须与 tokenizer.json 的 added_tokens 一致）。
fn nllb_lang(code: &str) -> Option<&'static str> {
    match code {
        "ja" => Some("jpn_Jpan"),
        "ko" => Some("kor_Hang"),
        "en" => Some("eng_Latn"),
        "zh" => Some("zho_Hans"),
        "zh-TW" => Some("zho_Hant"),
        _ => None,
    }
}

fn supported(code: &str) -> bool {
    matches!(code, "ja" | "ko" | "en" | "zh" | "zh-TW")
}

fn find_model(id: &str) -> Option<&'static ModelDef> {
    MODELS.iter().find(|m| m.id == id)
}

/// 模型根目录：优先用调用方传入的目录（设置里的「模型存放位置」），
/// 未配置时才落到应用数据目录，避免占 C 盘。
fn models_root(app: &AppHandle, custom: Option<&str>) -> Result<PathBuf, String> {
    if let Some(dir) = custom.map(str::trim).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(dir);
        fs::create_dir_all(&path).map_err(|e| format!("无法创建模型目录 {dir}：{e}"))?;
        return Ok(path);
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join("translate")
        .join("models");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建模型目录：{e}"))?;
    Ok(dir)
}

fn model_dir(app: &AppHandle, id: &str, custom: Option<&str>) -> Result<PathBuf, String> {
    Ok(models_root(app, custom)?.join(id))
}

fn dir_bytes(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
        .sum()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NmtModelStatus {
    id: String,
    display: String,
    installed: bool,
    bytes: u64,
    approx_bytes: u64,
    note: String,
    /// 模型实际落盘目录，设置页直接展示给用户
    dir: String,
}

/// 模型是否已完整落盘（三个文件都存在且非空）。
fn installed(app: &AppHandle, model: &ModelDef, custom: Option<&str>) -> bool {
    let Ok(dir) = model_dir(app, model.id, custom) else {
        return false;
    };
    model.files.iter().all(|file| {
        dir.join(file.name)
            .metadata()
            .map(|meta| meta.is_file() && meta.len() > 0)
            .unwrap_or(false)
    })
}

fn status_of(app: &AppHandle, model: &ModelDef, custom: Option<&str>) -> NmtModelStatus {
    let dir = model_dir(app, model.id, custom);
    let bytes = dir.as_ref().map(|path| dir_bytes(path)).unwrap_or(0);
    NmtModelStatus {
        id: model.id.to_string(),
        display: model.display.to_string(),
        installed: installed(app, model, custom),
        bytes,
        approx_bytes: model.approx_bytes,
        note: model.note.to_string(),
        dir: dir.map(|path| path.display().to_string()).unwrap_or_default(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NmtReply {
    text: String,
    model: String,
    elapsed_ms: u64,
}

#[tauri::command]
pub fn nmt_status(app: AppHandle, dir: Option<String>) -> Vec<NmtModelStatus> {
    MODELS
        .iter()
        .map(|model| status_of(&app, model, dir.as_deref()))
        .collect()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: String,
    file: String,
    downloaded: u64,
    total: u64,
    overall_done: u64,
    overall_total: u64,
}

/// 读取 Windows 系统代理（Clash / V2Ray 等会写进 WinINET 设置）。
/// 双击启动的应用拿不到 shell 里的 HTTPS_PROXY，只能靠这里兜底，否则
/// 国内直连 HuggingFace 会卡在读取响应上，表现为下载进度长期为 0。
fn system_proxy() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let server: String = key.get_value("ProxyServer").ok()?;
    // 可能是 127.0.0.1:7890，也可能是 http=host:port;https=host:port
    let picked = server
        .split(';')
        .map(str::trim)
        .find(|part| part.starts_with("https="))
        .map(|part| part.trim_start_matches("https=").to_string())
        .or_else(|| {
            server
                .split(';')
                .map(str::trim)
                .find(|part| part.starts_with("http="))
                .map(|part| part.trim_start_matches("http=").to_string())
        })
        .unwrap_or(server);
    if picked.is_empty() {
        None
    } else {
        Some(picked)
    }
}

/// 下载用 agent：优先环境变量里的代理，其次系统代理。
fn download_agent() -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(180))
        .redirects(8)
        .try_proxy_from_env(true);
    if let Some(addr) = system_proxy() {
        if let Ok(proxy) = ureq::Proxy::new(&format!("http://{addr}")) {
            builder = builder.proxy(proxy);
        }
    }
    builder.build()
}

fn download_file(
    app: &AppHandle,
    model: &ModelDef,
    file: &ModelFile,
    dest: &Path,
) -> Result<(), String> {
    if let Ok(meta) = dest.metadata() {
        if meta.is_file() && meta.len() > 0 {
            return Ok(());
        }
    }
    let agent = download_agent();
    let mut last_err = String::new();
    for base in MIRRORS {
        for rel in file.paths {
            let url = format!("{base}/{rel}");
            let response = match agent.get(&url).call() {
                Ok(resp) => resp,
                Err(err) => {
                    last_err = format!("{url}：{err}");
                    continue;
                }
            };
            let total = response
                .header("Content-Length")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
            let tmp = dest.with_extension("part");
            let mut out = fs::File::create(&tmp).map_err(|e| format!("无法写入临时文件：{e}"))?;
            let mut reader = response.into_reader();
            let mut buf = vec![0u8; 64 * 1024];
            let mut downloaded = 0u64;
            let mut last_emit = Instant::now();
            loop {
                let n = reader
                    .read(&mut buf)
                    .map_err(|e| format!("下载中断：{e}"))?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n])
                    .map_err(|e| format!("写入模型失败：{e}"))?;
                downloaded += n as u64;
                if last_emit.elapsed() >= Duration::from_millis(250) {
                    last_emit = Instant::now();
                    let _ = app.emit(
                        "nmt-progress",
                        DownloadProgress {
                            id: model.id.to_string(),
                            file: file.name.to_string(),
                            downloaded,
                            total,
                            // dir_bytes 已包含正在写入的 .part 文件，不再叠加 downloaded
                            overall_done: dir_bytes(dest.parent().unwrap_or(dest)),
                            overall_total: model.approx_bytes,
                        },
                    );
                }
            }
            if downloaded == 0 {
                last_err = format!("{url}：下载内容为空");
                continue;
            }
            fs::rename(&tmp, dest).map_err(|e| format!("保存模型失败：{e}"))?;
            return Ok(());
        }
    }
    Err(format!(
        "模型下载失败，已尝试 HuggingFace 与 hf-mirror。最后错误：{last_err}"
    ))
}

/// 下载并校验模型。下载在后台线程执行，进度通过 `nmt-progress` 事件上报。
#[tauri::command]
pub async fn nmt_download(
    app: AppHandle,
    id: String,
    dir: Option<String>,
) -> Result<NmtModelStatus, String> {
    let model = find_model(&id).ok_or_else(|| format!("未知模型：{id}"))?;
    let model_dir_path = model_dir(&app, model.id, dir.as_deref())?;
    fs::create_dir_all(&model_dir_path).map_err(|e| format!("无法创建模型目录：{e}"))?;
    let app_for_task = app.clone();
    let model_id = model.id.to_string();
    let custom = dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let model = find_model(&model_id).ok_or_else(|| format!("未知模型：{model_id}"))?;
        for file in model.files {
            download_file(
                &app_for_task,
                model,
                file,
                &model_dir_path.join(file.name),
            )?;
        }
        Ok(status_of(&app_for_task, model, custom.as_deref()))
    })
    .await
    .map_err(|e| format!("下载任务执行失败：{e}"))?
}

struct LoadedEngine {
    model_id: String,
    /// 引擎加载时使用的模型目录；目录变化要重新加载
    model_dir: PathBuf,
    tokenizer: Tokenizer,
    encoder: Session,
    decoder: Session,
}

static ORT_ENV: OnceLock<ort::environment::Environment> = OnceLock::new();

/// ONNX Runtime 环境全局只建一次；Session 都挂在它下面。
fn ort_env() -> Result<&'static ort::environment::Environment, String> {
    if let Some(env) = ORT_ENV.get() {
        return Ok(env);
    }
    let env = ort::init()
        .with_name("scrollforge")
        .build()
        .map_err(|e| format!("ONNX Runtime 初始化失败：{e}"))?;
    let _ = ORT_ENV.set(env);
    ORT_ENV.get().ok_or_else(|| "ONNX Runtime 初始化失败".to_string())
}

fn build_session(path: &Path, threads: usize, label: &str) -> Result<Session, String> {
    let builder =
        Session::builder(ort_env()?).map_err(|e| format!("创建 {label} 会话失败：{e}"))?;
    let mut builder = builder
        .with_intra_threads(threads)
        .map_err(|e| format!("设置 {label} 线程数失败：{e}"))?;
    builder
        .commit_from_file(path)
        .map_err(|e| format!("加载 {label} 失败：{e}"))
}

impl LoadedEngine {
    fn load(dir: &Path) -> Result<Self, String> {
        let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json"))
            .map_err(|e| format!("读取 tokenizer 失败：{e}"))?;
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(4)
            .max(1);
        let encoder = build_session(&dir.join("encoder.onnx"), threads, "encoder")?;
        let decoder = build_session(&dir.join("decoder.onnx"), threads, "decoder")?;
        Ok(Self {
            model_id: MODEL_ID.to_string(),
            model_dir: dir.to_path_buf(),
            tokenizer,
            encoder,
            decoder,
        })
    }

    fn encode_ids(&self, text: &str) -> Vec<i64> {
        let Ok(encoding) = self.tokenizer.encode(text, false) else {
            return Vec::new();
        };
        encoding.get_ids().iter().map(|id| *id as i64).collect()
    }

    fn translate(&mut self, text: &str, source: &str, target: &str) -> Result<String, String> {
        let src_token = nllb_lang(source).ok_or_else(|| format!("NLLB 不支持源语言 {source}"))?;
        let tgt_token = nllb_lang(target).ok_or_else(|| format!("NLLB 不支持目标语言 {target}"))?;
        let src_id = self
            .tokenizer
            .token_to_id(src_token)
            .ok_or_else(|| "tokenizer 缺少源语言标记".to_string())? as i64;
        let tgt_id = self
            .tokenizer
            .token_to_id(tgt_token)
            .ok_or_else(|| "tokenizer 缺少目标语言标记".to_string())? as u32;

        let pieces = self.encode_ids(text);
        if pieces.is_empty() {
            return Ok(String::new());
        }
        let mut ids = Vec::with_capacity(pieces.len() + 2);
        ids.push(src_id);
        ids.extend(pieces.iter().take(MAX_SOURCE_TOKENS));
        ids.push(2); // </s>

        let len = ids.len();
        let encoder_inputs = ort::inputs![
            "input_ids" => Tensor::<i64>::from_array((vec![1i64, len as i64], ids.clone())).map_err(|e| e.to_string())?,
            "attention_mask" => Tensor::<i64>::from_array((vec![1i64, len as i64], vec![1i64; len])).map_err(|e| e.to_string())?,
        ];
        let encoder_outputs = self.encoder.run(encoder_inputs).map_err(|e| format!("encoder 推理失败：{e}"))?;
        let hidden_value = encoder_outputs
            .get("last_hidden_state")
            .unwrap_or(&encoder_outputs[0]);
        let (hidden_shape, hidden) = hidden_value
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("读取 encoder 输出失败：{e}"))?;
        let hidden_shape: Vec<i64> = hidden_shape.to_vec();
        let hidden: Vec<f32> = hidden.to_vec();
        drop(encoder_outputs);

        let mut decoder_ids: Vec<i64> = vec![2, tgt_id as i64];
        let mut generated: Vec<u32> = Vec::new();
        let mut first_best: Option<usize> = None;
        let mut last_dims: Vec<i64> = Vec::new();
        for _ in 0..MAX_TOKENS {
            let seq = decoder_ids.len() as i64;
            let encoder_len = len as i64;
            let outputs = self
                .decoder
                .run(ort::inputs![
                    "input_ids" => Tensor::<i64>::from_array((vec![1i64, seq], decoder_ids.clone())).map_err(|e| e.to_string())?,
                    "encoder_hidden_states" => Tensor::<f32>::from_array((hidden_shape.clone(), hidden.clone())).map_err(|e| e.to_string())?,
                    "encoder_attention_mask" => Tensor::<i64>::from_array((vec![1i64, encoder_len], vec![1i64; len])).map_err(|e| e.to_string())?,
                ])
                .map_err(|e| format!("decoder 推理失败：{e}"))?;
            let logits_value = outputs.get("logits").unwrap_or(&outputs[0]);
            let (logits_shape, logits) = logits_value
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("读取 decoder 输出失败：{e}"))?;
            let dims: Vec<i64> = logits_shape.to_vec();
            last_dims = dims.clone();
            let Some(&vocab_size) = dims.last() else {
                return Err("decoder 输出维度异常".into());
            };
            let vocab_size = vocab_size as usize;
            let last_row = logits.len().saturating_sub(vocab_size);
            let mut best = 0usize;
            let mut best_score = f32::NEG_INFINITY;
            for (index, score) in logits[last_row..].iter().enumerate() {
                // <unk>(3) 不该出现在译文里，遇到就压低分数换次优
                if index == 3 {
                    continue;
                }
                if *score > best_score {
                    best_score = *score;
                    best = index;
                }
            }
            if first_best.is_none() {
                first_best = Some(best);
            }
            if best as u32 == 2 {
                break;
            }
            generated.push(best as u32);
            decoder_ids.push(best as i64);
            // int8 模型偶发复读同一个 n-gram，检测到就截断
            if has_repetition(&decoder_ids) {
                let keep = generated.len().saturating_sub(3);
                generated.truncate(keep);
                break;
            }
        }
        let text = self
            .tokenizer
            .decode(&generated, false)
            .map_err(|e| format!("解码译文失败：{e}"))?;
        let text = text.trim().replace('▁', " ").trim().to_string();
        if text.is_empty() {
            return Err(format!(
                "模型未产出译文（诊断：src={src_id} tgt={tgt_id} 编码长度={len} 隐状态={hidden_shape:?} logits={last_dims:?} 首步={first_best:?} 生成词数={}）",
                generated.len()
            ));
        }
        Ok(text)
    }
}

fn has_repetition(ids: &[i64]) -> bool {
    if ids.len() < 7 {
        return false;
    }
    let n = ids.len();
    (1..=3).any(|unit| {
        n >= unit * 3
            && ids[n - unit..] == ids[n - unit * 2..n - unit]
            && ids[n - unit..] == ids[n - unit * 3..n - unit * 2]
    })
}

fn split_for_translation(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if matches!(ch, '。' | '！' | '？' | '!' | '?' | '.' | '\n') && current.trim().len() > 20 {
            out.push(current.trim().to_string());
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    if out.is_empty() {
        out.push(text.to_string());
    }
    out
}

static ENGINE: OnceLock<Mutex<Option<LoadedEngine>>> = OnceLock::new();

fn engine_lock() -> &'static Mutex<Option<LoadedEngine>> {
    ENGINE.get_or_init(|| Mutex::new(None))
}

fn translate_with_engine(
    app: &AppHandle,
    text: &str,
    source: &str,
    target: &str,
    custom_dir: Option<&str>,
) -> Result<NmtReply, String> {
    let started = Instant::now();
    let model = find_model(MODEL_ID).ok_or_else(|| "内置模型未注册".to_string())?;
    if !installed(app, model, custom_dir) {
        return Err(
            "内置离线翻译模型尚未下载。请到 设置 → 功能 → 翻译 → 下载离线模型 后再试。".into(),
        );
    }
    let dir = model_dir(app, model.id, custom_dir)?;
    let mut guard = engine_lock()
        .lock()
        .map_err(|_| "翻译引擎状态异常".to_string())?;
    let need_load = guard
        .as_ref()
        .map(|engine| engine.model_id != MODEL_ID || engine.model_dir != dir)
        .unwrap_or(true);
    if need_load {
        *guard = Some(LoadedEngine::load(&dir)?);
    }
    let engine = guard.as_mut().ok_or_else(|| "翻译引擎初始化失败".to_string())?;

    let mut parts = Vec::new();
    for piece in split_for_translation(text) {
        let ids = engine.encode_ids(&piece);
        if ids.len() > MAX_SOURCE_TOKENS {
            // 超长段落再按标点切一刀，避免整段被截断
            for sub in split_for_translation(&piece.chars().take(2000).collect::<String>()) {
                parts.push(engine.translate(&sub, source, target)?);
            }
        } else {
            parts.push(engine.translate(&piece, source, target)?);
        }
    }
    let text = parts
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    Ok(NmtReply {
        text,
        model: model.display.to_string(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn nmt_translate(
    app: AppHandle,
    text: String,
    source: String,
    target: String,
    dir: Option<String>,
) -> Result<NmtReply, String> {
    if !supported(&source) || !supported(&target) {
        return Err(format!("内置引擎暂不支持 {source} → {target}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        translate_with_engine(&app, &text, &source, &target, dir.as_deref())
    })
    .await
    .map_err(|e| format!("翻译任务执行失败：{e}"))?
}
