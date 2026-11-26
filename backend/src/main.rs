// backend/src/main.rs — apifox sidecar：原生 HTTP 请求代理 + 本地 .http 文件 / 结果仓库。
//
// 沙箱 UI 受 CSP/CORS 限制，无法发任意 URL 请求、也无法直接读本地文件。
// 本 sidecar 以本机 OS 用户权限运行：reqwest 发请求、std::fs 读写 .http 与结果文件。
// 结果落盘绕开 host.storage 的 1 MiB 上限，响应体可以完整保存并在页面上重新打开。
//
// 方法一览：
//   http/request          原有：reqwest 发送任意 HTTP 请求
//   apifox/ping  健康检查
//   http/defaultDirs       返回默认结果目录与用户主目录
//   http/listFiles         扫描目录下的 .http / .rest 文件
//   http/readFile          读取一个文本文件（.http、外部 body 文件等）
//   http/writeFile         写回 .http 源码（编辑器保存 / 自动保存）
//   http/statFile          毫秒级 mtime（段落级写回的冲突检测）
//   http/deleteFile        删除文件（目录需 recursive=true）
//   http/renameFile        改名 / 移动（Windows 上覆盖需先删目标）
//   http/ensureDir         建目录（幂等）
//   http/readEnvFiles      读取 http-client.env.json 与 http-client.private.env.json
//   http/pickFile          原生文件对话框（打开 / 另存为），返回绝对路径
//   http/saveResult        把一次请求 + 响应写入 results/*.json
//   http/listResults       列出历史结果（只读元信息，不载入响应体）
//   http/getResult         读取某次完整结果
//   http/deleteResult      删除某次结果
//   http/revealDir         在系统文件管理器中打开结果目录
//   ws/connect             建立 WebSocket 长连接（帧走 apifox/http/ws 事件）
//   ws/send                往连接里发一条消息
//   ws/close               断开连接
//   ws/list                列出还活着的连接（UI 重载后清点用）
//   apifox/*               Apifox 接口树 / 环境同步（见 apifox.rs）

use std::collections::HashMap;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

mod apifox;

use dbx_plugin_sdk::{PluginEmitter, PluginError, PluginHandler, PluginMetadata, PluginServer, RequestContext};
use serde_json::{json, Value};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::client::IntoClientRequest;
use tungstenite::{Message, WebSocket};
use tungstenite::Error as WsError;

#[derive(Default)]
struct PolarisApi;

impl PluginHandler for PolarisApi {
    fn handle(
        &self,
        _context: RequestContext,
        method: &str,
        params: Value,
        emitter: &PluginEmitter,
    ) -> Result<Value, PluginError> {
        match method {
            "http/request" => handle_request(params, emitter),
            "apifox/ping" => Ok(json!({
                "ok": true,
                "plugin": "com.fax.apifox",
                "version": env!("CARGO_PKG_VERSION"),
            })),
            "http/defaultDirs" => handle_default_dirs(),
            "http/listFiles" => handle_list_files(params),
            "http/readFile" => handle_read_file(params),
            "http/writeFile" => handle_write_file(params),
            "http/statFile" => handle_stat_file(params),
            "http/deleteFile" => handle_delete_file(params),
            "http/renameFile" => handle_rename_file(params),
            "http/ensureDir" => handle_ensure_dir(params),
            "http/readEnvFiles" => handle_read_env_files(params),
            "http/pickFile" => handle_pick_file(params),
            "http/saveResult" => handle_save_result(params),
            "http/listResults" => handle_list_results(params),
            "http/getResult" => handle_get_result(params),
            "http/deleteResult" => handle_delete_result(params),
            "http/revealDir" => handle_reveal_dir(params),
            "ws/connect" => handle_ws_connect(params, emitter),
            "ws/send" => handle_ws_send(params),
            "ws/close" => handle_ws_close(params),
            "ws/list" => handle_ws_list(),
            m if m.starts_with("apifox/") => apifox::handle(m, &params, emitter)
                .unwrap_or_else(|| Err(PluginError::method_not_found(m))),
            _ => Err(PluginError::method_not_found(method)),
        }
    }
}

/* ===================== 本地目录与文件 ===================== */

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_nanos() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0)
}

/// 默认结果目录：DBX 插件数据区。可用 DBX_PLUGIN_DATA_DIR 或 UI 显式覆盖。
fn default_results_dir() -> PathBuf {
    if let Ok(p) = std::env::var("DBX_PLUGIN_DATA_DIR") {
        if !p.is_empty() {
            return PathBuf::from(p).join("com.fax.apifox").join("results");
        }
    }
    if let Ok(p) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(p).join("DBX").join("plugins").join("com.fax.apifox").join("results");
    }
    if let Ok(p) = std::env::var("HOME") {
        return PathBuf::from(p)
            .join(".local").join("share").join("dbx").join("plugins")
            .join("com.fax.apifox").join("results");
    }
    PathBuf::from("results")
}

fn resolve_results_dir(params: &Value) -> PathBuf {
    if let Some(d) = params.get("resultsDir").and_then(Value::as_str) {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    default_results_dir()
}

fn user_home() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// 默认工作目录：主目录下的 apifox（拖入/导入时的副本落点，首次访问时创建）。
/// 用独立子目录而不是直接拿主目录，避免把一个 .http 副本丢进 C:\Users\xxx 根下。
fn default_work_dir() -> PathBuf {
    let p = user_home().join("apifox");
    let _ = fs::create_dir_all(&p);
    p
}

fn handle_default_dirs() -> Result<Value, PluginError> {
    Ok(json!({
        "resultsDir": default_results_dir().to_string_lossy().to_string(),
        "homeDir": user_home().to_string_lossy().to_string(),
        "workDir": default_work_dir().to_string_lossy().to_string(),
    }))
}

fn param_str<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str)
}

fn io_err(context: &str, e: impl std::fmt::Display) -> PluginError {
    PluginError::new(-32000, format!("{context}: {e}"))
}

/// 扫描目录下的 .http / .rest 文件。默认递归 3 层，最多 200 个，跳过隐藏与构建目录。
fn handle_list_files(params: Value) -> Result<Value, PluginError> {
    let raw = param_str(&params, "dir").unwrap_or("");
    let recursive = params.get("recursive").and_then(Value::as_bool).unwrap_or(true);
    let base = if raw.is_empty() { user_home() } else { PathBuf::from(raw) };
    if !base.is_dir() {
        return Err(PluginError::new(-32602, format!("目录不存在: {}", base.display())));
    }
    let mut files: Vec<Value> = Vec::new();
    collect_http_files(&base, recursive, 0, &mut files);
    files.sort_by(|a, b| {
        a.get("path").and_then(Value::as_str).unwrap_or("")
            .cmp(b.get("path").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(json!({ "dir": base.to_string_lossy().to_string(), "files": files }))
}

fn collect_http_files(dir: &Path, recursive: bool, depth: u32, out: &mut Vec<Value>) {
    if out.len() >= 200 || depth > 3 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for ent in entries.flatten() {
        if out.len() >= 200 {
            break;
        }
        let path = ent.path();
        let name = ent.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if !recursive
                || name.starts_with('.')
                || matches!(name.as_str(), "node_modules" | "target" | "dist" | "build" | "vendor" | "AppData")
            {
                continue;
            }
            collect_http_files(&path, recursive, depth + 1, out);
        } else {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if ext != "http" && ext != "rest" {
                continue;
            }
            let meta = ent.metadata().ok();
            let modified = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(json!({
                "path": path.to_string_lossy().to_string(),
                "name": name,
                "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                "modified": modified,
            }));
        }
    }
}

/// 读取文件。默认按 UTF-8 文本返回；binary=true 时返回 base64（供 multipart 里的二进制附件用）。
fn handle_read_file(params: Value) -> Result<Value, PluginError> {
    let p = param_str(&params, "path").ok_or_else(|| PluginError::new(-32602, "缺少 path"))?;
    let path = PathBuf::from(p);
    if !path.is_file() {
        return Err(PluginError::new(-32000, format!("文件不存在：{}", path.to_string_lossy())));
    }
    let dir = path.parent().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
    let name = path.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();

    let binary = params.get("binary").and_then(Value::as_bool).unwrap_or(false);
    if binary {
        let bytes = fs::read(&path).map_err(|e| io_err("读取文件失败", e))?;
        let size = bytes.len();
        return Ok(json!({
            "path": path.to_string_lossy().to_string(),
            "dir": dir,
            "name": name,
            "binary": true,
            "base64": BASE64_STANDARD.encode(&bytes),
            "size": size,
            "content": "",
        }));
    }

    let content = fs::read_to_string(&path).map_err(|e| io_err("读取文件失败", e))?;
    Ok(json!({
        "path": path.to_string_lossy().to_string(),
        "dir": dir,
        "name": name,
        "binary": false,
        "content": content,
    }))
}

fn read_json_or_null(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str::<Value>(&s).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

/// 写回一个文本文件（.http 编辑器保存 / 自动保存）。只处理 UTF-8 文本，不写二进制。
/// 参数：path（绝对路径）、content（UTF-8 文本）、backup（可选 true，覆盖前留一份 .bak）、
///       noClobber（可选 true，目标已存在时不写、返回 exists:true，供 UI 换名重试）
fn handle_write_file(params: Value) -> Result<Value, PluginError> {
    let p = param_str(&params, "path").ok_or_else(|| PluginError::new(-32602, "缺少 path"))?;
    let content = param_str(&params, "content").ok_or_else(|| PluginError::new(-32602, "缺少 content"))?;
    let path = PathBuf::from(p);

    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            fs::create_dir_all(dir).map_err(|e| io_err("创建目录失败", e))?;
        }
    }

    if params.get("noClobber").and_then(Value::as_bool).unwrap_or(false) && path.is_file() {
        return Ok(json!({
            "path": path.to_string_lossy().to_string(),
            "exists": true,
            "written": false,
            "size": 0,
        }));
    }

    let mut backup = String::new();
    if params.get("backup").and_then(Value::as_bool).unwrap_or(false) && path.is_file() {
        let mut bp = path.clone();
        bp.set_file_name(format!(
            "{}.bak",
            path.file_name()
                .map(|x| x.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_string())
        ));
        if fs::copy(&path, &bp).is_ok() {
            backup = bp.to_string_lossy().to_string();
        }
    }

    fs::write(&path, content.as_bytes()).map_err(|e| io_err("写入文件失败", e))?;

    Ok(json!({
        "path": path.to_string_lossy().to_string(),
        "exists": false,
        "written": true,
        "size": content.len() as u64,
        "modified": now_millis(),
        "backup": backup,
    }))
}

/// 轻量 stat：不读内容，只回是否存在与**毫秒级**修改时间。
/// 段落级写回靠它做冲突检测（listFiles 的 modified 只有秒级，不够判「刚被人改过」）。
fn handle_stat_file(params: Value) -> Result<Value, PluginError> {
    let p = param_str(&params, "path").ok_or_else(|| PluginError::new(-32602, "缺少 path"))?;
    let path = PathBuf::from(p);
    match fs::metadata(&path) {
        Ok(m) => {
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Ok(json!({
                "path": path.to_string_lossy().to_string(),
                "exists": true,
                "isDir": m.is_dir(),
                "size": m.len(),
                "modified": modified,
            }))
        }
        Err(_) => Ok(json!({
            "path": path.to_string_lossy().to_string(),
            "exists": false,
            "isDir": false,
            "size": 0,
            "modified": 0,
        })),
    }
}

/// 删除文件（或目录，必须显式 recursive=true）。删不存在的路径不算错误，回 removed:false。
fn handle_delete_file(params: Value) -> Result<Value, PluginError> {
    let p = param_str(&params, "path").ok_or_else(|| PluginError::new(-32602, "缺少 path"))?;
    let path = PathBuf::from(p);
    if !path.exists() {
        return Ok(json!({ "path": path.to_string_lossy().to_string(), "removed": false, "reason": "MISSING" }));
    }
    if path.is_dir() {
        let recursive = params.get("recursive").and_then(Value::as_bool).unwrap_or(false);
        if !recursive {
            return Err(PluginError::new(-32602, "目标是目录，确需删除请传 recursive=true"));
        }
        fs::remove_dir_all(&path).map_err(|e| io_err("删除目录失败", e))?;
    } else {
        fs::remove_file(&path).map_err(|e| io_err("删除文件失败", e))?;
    }
    Ok(json!({ "path": path.to_string_lossy().to_string(), "removed": true }))
}

/// 改名 / 移动。同盘 rename 各平台都能覆盖已存在目标（Windows 走 MoveFileExW +
/// MOVEFILE_REPLACE_EXISTING），所以**不需要**先删目标。真风险恰恰在「先删再改名」：
/// remove 成功、rename 失败（文件被占用 / 权限 / 跨盘）时，用户的原文件已经没了。
/// 做法是先把旧目标改名成一个 `.bak`（目标不存在，任何平台都能改名成功），
/// 换名成功再删 bak，失败就把它挪回来 —— 任何时刻磁盘上都有一份完整文件。
/// overwrite=false 且目标已存在 → 回 { exists:true, renamed:false }，由 UI 决定换名。
fn handle_rename_file(params: Value) -> Result<Value, PluginError> {
    let from = param_str(&params, "from").ok_or_else(|| PluginError::new(-32602, "缺少 from"))?;
    let to = param_str(&params, "to").ok_or_else(|| PluginError::new(-32602, "缺少 to"))?;
    let overwrite = params.get("overwrite").and_then(Value::as_bool).unwrap_or(false);
    let (fp, tp) = (PathBuf::from(from), PathBuf::from(to));
    if !fp.exists() {
        return Err(PluginError::new(-32000, format!("源文件不存在：{}", fp.display())));
    }
    if fp == tp {
        return Ok(json!({ "exists": true, "renamed": false, "path": to }));
    }
    let mut stashed: Option<PathBuf> = None;
    if tp.exists() {
        if !overwrite {
            return Ok(json!({ "exists": true, "renamed": false, "path": to }));
        }
        if tp.is_dir() {
            return Err(PluginError::new(-32602, "目标已存在且是目录，拒绝覆盖"));
        }
        /* 用 OsString 拼后缀，不走 display()：路径里有非 UTF-8 字节时 display 会丢字符 */
        let mut os = tp.clone().into_os_string();
        os.push(format!(".bak{}", now_millis()));
        let bak = PathBuf::from(os);
        fs::rename(&tp, &bak).map_err(|e| io_err("覆盖前暂存目标失败", e))?;
        stashed = Some(bak);
    }
    if let Some(dir) = tp.parent() {
        if !dir.as_os_str().is_empty() {
            if let Err(e) = fs::create_dir_all(dir) {
                if let Some(b) = stashed.take() { let _ = fs::rename(&b, &tp); }
                return Err(io_err("创建目录失败", e));
            }
        }
    }
    match fs::rename(&fp, &tp) {
        Ok(_) => {
            if let Some(b) = stashed.take() { let _ = fs::remove_file(&b); }
            Ok(json!({ "exists": false, "renamed": true, "path": to }))
        }
        Err(e) => {
            if let Some(b) = stashed.take() { let _ = fs::rename(&b, &tp); }
            Err(io_err("改名失败", e))
        }
    }
}

/// 建目录（幂等）。资源目录、_history/、_cancel/ 都靠它。
fn handle_ensure_dir(params: Value) -> Result<Value, PluginError> {
    let d = param_str(&params, "dir").ok_or_else(|| PluginError::new(-32602, "缺少 dir"))?;
    let path = PathBuf::from(d);
    fs::create_dir_all(&path).map_err(|e| io_err("创建目录失败", e))?;
    Ok(json!({ "dir": path.to_string_lossy().to_string(), "ok": true }))
}

/* ===================== 原生文件对话框 ===================== */
/// 原生「打开 / 另存为」对话框，返回绝对路径。
/// 参数：mode("open"|"save")、title、name（另存为默认文件名）、ext（可选，逗号分隔扩展名）。
/// 返回：{ cancelled: true } 或 { cancelled:false, path, dir, name }。
///
/// 为什么自己弹框：DBX 宿主提供的 fileTransfer.pick 只回句柄不回路径，
/// 插件拿不到真实路径就无法把编辑内容写回原文件；本 sidecar 以本机用户身份运行，
/// 自己弹系统对话框即可拿到绝对路径，后续 readFile/writeFile 都直接可用。
/// 实现只用系统自带能力（Windows PowerShell/WinForms、macOS osascript、Linux zenity/kdialog），
/// 不引入额外 crate，避免多平台 CI 编译依赖。
fn handle_pick_file(params: Value) -> Result<Value, PluginError> {
    let mode = match param_str(&params, "mode").unwrap_or("open") {
        "save" => "save",
        _ => "open",
    };
    let title = param_str(&params, "title").unwrap_or(if mode == "save" {
        "保存 .http 文件"
    } else {
        "选择 .http 文件"
    });
    let name = param_str(&params, "name").unwrap_or("");
    let exts = param_str(&params, "ext").unwrap_or("http,rest");

    let picked = native_dialog(mode, title, name, exts).map_err(|e| PluginError::new(-32000, e))?;
    match picked {
        None => Ok(json!({ "cancelled": true })),
        Some(p) => {
            let path = PathBuf::from(&p);
            Ok(json!({
                "cancelled": false,
                "path": p,
                "dir": path.parent().map(|x| x.to_string_lossy().to_string()).unwrap_or_default(),
                "name": path.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default(),
            }))
        }
    }
}

#[cfg(target_os = "windows")]
fn native_dialog(mode: &str, title: &str, name: &str, exts: &str) -> Result<Option<String>, String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let list: Vec<String> = exts
        .split(',')
        .map(|s| s.trim().trim_start_matches("*.").to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let patterns = list.iter().map(|e| format!("*.{e}")).collect::<Vec<_>>().join(";");
    let filter = if patterns.is_empty() {
        "所有文件 (*.*)|*.*".to_string()
    } else {
        format!("请求文件 ({patterns})|{patterns}|所有文件 (*.*)|*.*")
    };
    /* PowerShell 单引号字符串转义：' → '' */
    let q = |s: &str| s.replace('\'', "''");

    let pid = std::process::id();
    let tmp = std::env::temp_dir().join(format!("dbx-pa-pick-{pid}.ps1"));
    let out_path = std::env::temp_dir().join(format!("dbx-pa-pick-{pid}.out"));

    let mut ps = String::new();
    ps.push_str("$ErrorActionPreference = 'Stop'\n");
    ps.push_str("Add-Type -AssemblyName System.Windows.Forms\n");
    /* 用 0 尺寸、不上任务栏的 owner 窗口，让对话框出现在最前面；
     * 不碰 System.Drawing / Opacity，少一个能失败的依赖 */
    ps.push_str("$o = New-Object System.Windows.Forms.Form\n");
    ps.push_str("$o.Text = 'DBX'\n");
    ps.push_str("$o.TopMost = $true\n");
    ps.push_str("$o.ShowInTaskbar = $false\n");
    ps.push_str("$o.FormBorderStyle = 'FixedToolWindow'\n");
    ps.push_str("$o.StartPosition = 'CenterScreen'\n");
    ps.push_str("$o.Width = 0\n");
    ps.push_str("$o.Height = 0\n");
    ps.push_str("$o.Show()\n");
    ps.push_str("$o.Activate()\n");
    if mode == "save" {
        ps.push_str("$d = New-Object System.Windows.Forms.SaveFileDialog\n");
        ps.push_str(&format!("$d.FileName = '{}'\n", q(name)));
        ps.push_str("$d.OverwritePrompt = $true\n");
        ps.push_str("$d.AddExtension = $true\n");
        ps.push_str("$d.DefaultExt = 'http'\n");
        ps.push_str("$d.RestoreDirectory = $true\n");
    } else {
        ps.push_str("$d = New-Object System.Windows.Forms.OpenFileDialog\n");
        ps.push_str("$d.CheckFileExists = $true\n");
        ps.push_str("$d.Multiselect = $false\n");
        ps.push_str("$d.RestoreDirectory = $true\n");
    }
    ps.push_str(&format!("$d.Title = '{}'\n", q(title)));
    ps.push_str(&format!("$d.Filter = '{}'\n", q(&filter)));
    ps.push_str("$r = $d.ShowDialog($o)\n");
    ps.push_str("$o.Close()\n");
    /* 结果写临时文件（UTF-8 无 BOM），比走 stdout 更稳：不受控制台代码页影响 */
    ps.push_str(&format!(
        "if ($r -eq [System.Windows.Forms.DialogResult]::OK) {{ [System.IO.File]::WriteAllText('{}', $d.FileName, (New-Object System.Text.UTF8Encoding($false))) }}\n",
        q(&out_path.to_string_lossy())
    ));

    let _ = fs::remove_file(&out_path);
    /* 带 UTF-8 BOM：Windows PowerShell 5.1 才按 UTF-8 解析脚本里的中文 */
    let mut bytes = vec![0xEFu8, 0xBB, 0xBF];
    bytes.extend_from_slice(ps.as_bytes());
    fs::write(&tmp, bytes).map_err(|e| format!("写入临时脚本失败: {e}"))?;

    let run = |exe: &str, sta: bool| -> std::io::Result<std::process::Output> {
        let mut c = Command::new(exe);
        c.arg("-NoProfile").arg("-NonInteractive").arg("-ExecutionPolicy").arg("Bypass");
        if sta {
            c.arg("-STA");
        }
        c.arg("-File").arg(&tmp);
        c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不闪黑框
        c.output()
    };
    let out = match run("powershell", true) {
        Ok(o) => Ok(o),
        Err(_) => run("pwsh", false),
    };
    let _ = fs::remove_file(&tmp);

    let picked = fs::read_to_string(&out_path).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let _ = fs::remove_file(&out_path);

    match out {
        Ok(o) => {
            if picked.is_some() {
                return Ok(picked);
            }
            if !o.status.success() {
                let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                return Err(format!(
                    "原生文件对话框不可用{}",
                    if err.is_empty() { String::new() } else { format!("：{err}") }
                ));
            }
            Ok(None) // 用户取消
        }
        Err(e) => Err(format!("无法启动 PowerShell 文件对话框: {e}")),
    }
}

#[cfg(target_os = "macos")]
fn native_dialog(mode: &str, title: &str, name: &str, _exts: &str) -> Result<Option<String>, String> {
    use std::process::{Command, Stdio};

    let q = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let script = if mode == "save" {
        format!(
            "POSIX path of (choose file name with prompt \"{}\" default name \"{}\")",
            q(title),
            q(if name.is_empty() { "new.http" } else { name })
        )
    } else {
        format!("POSIX path of (choose file with prompt \"{}\")", q(title))
    };
    let out = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("无法启动 osascript: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        Ok(None) // 用户取消：osascript 以非 0 退出且无输出
    } else {
        Ok(Some(text))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn native_dialog(mode: &str, title: &str, name: &str, _exts: &str) -> Result<Option<String>, String> {
    use std::process::{Command, Stdio};

    /* zenity 取消时退出码 1；找不到命令 / 无 DISPLAY 时走 kdialog */
    let mut args: Vec<String> = vec!["--file-selection".into(), format!("--title={title}")];
    if mode == "save" {
        args.push("--save".into());
        args.push("--confirm-overwrite".into());
        if !name.is_empty() {
            args.push(format!("--filename={name}"));
        }
    }
    if let Ok(o) = Command::new("zenity").args(&args).stdin(Stdio::null()).output() {
        let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !t.is_empty() {
            return Ok(Some(t));
        }
        if o.status.code() == Some(1) {
            return Ok(None);
        }
    }
    let kflag = if mode == "save" { "--getsavefilename" } else { "--getopenfilename" };
    let kstart = if mode == "save" && !name.is_empty() { name.to_string() } else { ".".to_string() };
    let kargs: Vec<String> = vec![kflag.to_string(), kstart, format!("--title={title}")];
    if let Ok(o) = Command::new("kdialog").args(&kargs).stdin(Stdio::null()).output() {
        let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !t.is_empty() {
            return Ok(Some(t));
        }
        if o.status.code() == Some(1) {
            return Ok(None);
        }
    }
    Err("当前环境没有可用的原生文件对话框（zenity/kdialog），请用界面上的「选择文件」按钮".into())
}

/// 读取 IDEA HTTP Client 的环境变量文件；private 文件由 UI 侧合并时覆盖同名字段。
fn handle_read_env_files(params: Value) -> Result<Value, PluginError> {
    let raw = param_str(&params, "dir").unwrap_or("");
    let base = if raw.is_empty() { user_home() } else { PathBuf::from(raw) };
    Ok(json!({
        "dir": base.to_string_lossy().to_string(),
        "public": read_json_or_null(&base.join("http-client.env.json")),
        "private": read_json_or_null(&base.join("http-client.private.env.json")),
    }))
}

/* ===================== 请求结果仓库 ===================== */

fn safe_file_name(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
            out.push(c);
        } else {
            out.push('_');
        }
        if out.len() >= 48 {
            break;
        }
    }
    if out.is_empty() { "request".to_string() } else { out }
}

/* 每个接口在 results/ 里留几条完整结果。
 * 与 `_history` 的 MAX_LINES = 10 对齐：历史只留 10 条摘要，被轮转掉的那些
 * 摘要所指向的结果文件就再没有人会读了 —— 不回收只会线性膨胀，且全是孤儿。 */
const RESULTS_KEEP: usize = 10;

/// 回收同一个接口的旧结果文件，返回删掉的个数。
///
/// 判「同一个接口」用两条：文件名后缀（`-<name>.json`）+ 文件里记的 `sourceFile`。
/// 只按名字会误伤 —— 两个 .http 里都叫「元数据接口」是常事，它们的旧结果
/// 不该互相挤掉。名字用来缩小扫描面（不必读整目录的 JSON），sourceFile 用来定组。
fn prune_results(dir: &Path, name_key: &str, source_file: &str, keep: usize) -> usize {
    if keep == 0 {
        return 0;
    }
    let suffix = format!("-{name_key}.json");
    let mut hits: Vec<(String, PathBuf)> = Vec::new();
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return 0,
    };
    for ent in rd.flatten() {
        let path = ent.path();
        let fname = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_owned(),
            None => continue,
        };
        /* 只认 `<ms>-<nanos>-<name>.json`：`.tmp` 与别的文件不参与，
         * 否则正在写的半成品会被当成一条老记录删掉。 */
        if !fname.ends_with(&suffix) {
            continue;
        }
        let text = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let v: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let sf = v
            .get("request")
            .and_then(|r| r.get("sourceFile"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if sf != source_file {
            continue;
        }
        hits.push((fname, path));
    }
    if hits.len() <= keep {
        return 0;
    }
    /* 文件名开头就是毫秒时间戳，定宽 13 位，字典序即时间序 —— 不用解析名字。 */
    hits.sort_by(|a, b| a.0.cmp(&b.0));
    let drop_n = hits.len() - keep;
    let mut n = 0;
    for (_, p) in hits.into_iter().take(drop_n) {
        /* 删不掉（被占用 / 权限）就跳过：回收失败不能连累这次结果本身，
         * 下次保存还会再试一次。 */
        if fs::remove_file(&p).is_ok() {
            n += 1;
        }
    }
    n
}

fn handle_save_result(params: Value) -> Result<Value, PluginError> {
    let dir = resolve_results_dir(&params);
    fs::create_dir_all(&dir).map_err(|e| io_err("创建结果目录失败", e))?;

    let mut obj = match params.get("entry").cloned() {
        Some(Value::Object(o)) => o,
        _ => return Err(PluginError::new(-32602, "缺少 entry 对象")),
    };

    let ts = now_millis();
    let nanos = now_nanos() % 1_000_000;
    let id = format!("{ts}-{nanos:06}");
    let name = obj
        .get("request")
        .and_then(|r| r.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("request")
        .to_owned();
    let source_file = obj
        .get("request")
        .and_then(|r| r.get("sourceFile"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    /* 默认 10，宿主/测试可以显式传 maxKeep（0 = 不回收）压小一点好验。 */
    let keep = params
        .get("maxKeep")
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(RESULTS_KEEP);
    let name_key = safe_file_name(&name);
    let filename = format!("{}-{}-{}.json", ts, nanos, name_key);

    obj.insert("id".to_string(), json!(id));
    obj.insert("savedAt".to_string(), json!(ts));
    let data = serde_json::to_string_pretty(&Value::Object(obj))
        .map_err(|e| io_err("序列化结果失败", e))?;

    // 先写临时文件再 rename，避免 UI 在半写状态下读到不完整 JSON。
    let path = dir.join(&filename);
    let tmp = dir.join(format!("{filename}.tmp"));
    fs::write(&tmp, data.as_bytes()).map_err(|e| io_err("写入结果失败", e))?;
    fs::rename(&tmp, &path).map_err(|e| io_err("提交结果文件失败", e))?;

    /* 落盘成功之后才回收：这次的结果必须留下，删的是更早的那些。 */
    let pruned = prune_results(&dir, &name_key, &source_file, keep);

    Ok(json!({
        "id": id,
        "path": path.to_string_lossy().to_string(),
        "dir": dir.to_string_lossy().to_string(),
        "savedAt": ts,
        "pruned": pruned,
        "keep": keep,
    }))
}

fn handle_list_results(params: Value) -> Result<Value, PluginError> {
    let dir = resolve_results_dir(&params);
    let mut items: Vec<Value> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let path = ent.path();
            let is_json = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("json"))
                .unwrap_or(false);
            if !is_json {
                continue;
            }
            let text = match fs::read_to_string(&path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let v: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let req = v.get("request");
            let resp = v.get("response");
            items.push(json!({
                "path": path.to_string_lossy().to_string(),
                "id": v.get("id").and_then(Value::as_str).unwrap_or(""),
                "savedAt": v.get("savedAt").and_then(Value::as_u64).unwrap_or(0),
                "name": req.and_then(|r| r.get("name")).and_then(Value::as_str).unwrap_or(""),
                "method": req.and_then(|r| r.get("method")).and_then(Value::as_str).unwrap_or(""),
                "url": req.and_then(|r| r.get("url")).and_then(Value::as_str).unwrap_or(""),
                "sourceFile": req.and_then(|r| r.get("sourceFile")).and_then(Value::as_str).unwrap_or(""),
                "status": resp.and_then(|r| r.get("status")).and_then(Value::as_u64).unwrap_or(0),
                "timeMs": resp.and_then(|r| r.get("timeMs")).and_then(Value::as_u64).unwrap_or(0),
                "size": resp.and_then(|r| r.get("size")).and_then(Value::as_u64).unwrap_or(0),
                "ok": resp.and_then(|r| r.get("ok")).and_then(Value::as_bool).unwrap_or(false),
            }));
        }
    }
    // 文件名以时间戳开头，路径倒序即时间倒序。
    items.sort_by(|a, b| {
        b.get("path").and_then(Value::as_str).unwrap_or("")
            .cmp(a.get("path").and_then(Value::as_str).unwrap_or(""))
    });
    if items.len() > 300 {
        items.truncate(300);
    }
    Ok(json!({ "dir": dir.to_string_lossy().to_string(), "items": items }))
}

fn handle_get_result(params: Value) -> Result<Value, PluginError> {
    let p = param_str(&params, "path").ok_or_else(|| PluginError::new(-32602, "缺少 path"))?;
    let path = PathBuf::from(p);
    /* 文件不见了多半不是故障：结果目录每个接口只留最近 10 份，老记录被回收掉了，
     * 而历史 jsonl 里那条摘要可能还在。说清楚，别让人以为是读盘出错。 */
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(PluginError::new(
                -32004,
                "结果文件不存在（每个接口只留最近 10 份，更早的已回收）".to_string(),
            ))
        }
        Err(e) => return Err(io_err("读取结果失败", e)),
    };
    let entry: Value = serde_json::from_str(&text).map_err(|e| io_err("解析结果失败", e))?;
    Ok(json!({ "path": path.to_string_lossy().to_string(), "entry": entry }))
}

fn handle_delete_result(params: Value) -> Result<Value, PluginError> {
    let p = param_str(&params, "path").ok_or_else(|| PluginError::new(-32602, "缺少 path"))?;
    match fs::remove_file(Path::new(p)) {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(e) => Err(io_err("删除结果失败", e)),
    }
}

fn handle_reveal_dir(params: Value) -> Result<Value, PluginError> {
    let dir = resolve_results_dir(&params);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| io_err("创建结果目录失败", e))?;
    }
    let target = dir.to_string_lossy().to_string();
    let result = if cfg!(target_os = "windows") {
        std::process::Command::new("explorer").arg(&target).spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&target).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(&target).spawn()
    };
    match result {
        Ok(_) => Ok(json!({ "ok": true, "dir": target })),
        Err(e) => Err(io_err("打开文件管理器失败", e)),
    }
}

/* ===================== HTTP 请求（原有逻辑） ===================== */

/* 响应体按 64 KiB 一块读，每块之前看一眼取消标志。
 * 之前是 `resp.bytes()` 一口气读完 —— 50 MB 的下载在 UI 上点了停止，
 * sidecar 仍会把整包灌进内存，连接也不会断。 */
const READ_CHUNK: usize = 64 * 1024;
/// 单个 SSE 事件在内存里最多攒这么多：对端一直不发空行时先切一刀，避免无上限堆积。
const MAX_PENDING: usize = 256 * 1024;
/// 订阅式流的事件名。宿主按 `host.events` 权限转发到 iframe 的 message 事件。
const STREAM_EVENT: &str = "apifox/http/stream";

/// 在缓冲区里找一个完整 SSE 事件的结尾（含分隔空行），返回「切到哪」。
/// 支持 LF LF 与 CRLF CRLF 两种写法。找不到返回 None。
fn sse_event_end(buf: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i + 1 < buf.len() {
        if buf[i] == b'\n' && buf[i + 1] == b'\n' {
            return Some(i + 2);
        }
        if i + 3 < buf.len()
            && buf[i] == b'\r'
            && buf[i + 1] == b'\n'
            && buf[i + 2] == b'\r'
            && buf[i + 3] == b'\n'
        {
            return Some(i + 4);
        }
        i += 1;
    }
    None
}

/* 取消标志的约定：UI 在用户点「停止」时写 `<workspace>/_cancel/<requestId>.flag`，
 * 后端每读一块前 stat 一次，文件出现就收手。请求结束时（成功 / 失败 / 取消）由
 * CancelFlagGuard 删掉。
 *
 * 为什么走文件而不是 `http/cancel` 这种 RPC：sidecar 默认是 2–16 个 worker 线程，
 * 请求正占着一个线程阻塞在 read 上，另一个线程确实能处理 cancel RPC —— 但那需要在
 * 进程里维护一张「requestId → 原子标志」的全局表，还得处理跨 worker 的竞态；
 * 一个文件已经足够表达「停」，且 UI 侧不需要额外的登记/注销协议。
 *
 * 局限（写在这里免得以后当成 bug）：read 本身阻塞时检查不到；只有对端在持续推数据
 * （每块之间）才能在毫秒级停手。连接完全静默时，取消仍要等读超时 —— 那种情况下
 * UI 早已用 sendSeq 做了逻辑中断，用户看到的界面是立刻停的。 */
fn is_cancel_flag(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("flag"))
        .unwrap_or(false)
}

fn cancel_requested(p: Option<&Path>) -> bool {
    match p {
        Some(x) => is_cancel_flag(x) && x.exists(),
        None => false,
    }
}

/// 请求一结束就删标志：UI 的 `http/deleteFile` 是异步 RPC，可能晚到，
/// 残留的同名标志会让下一次请求刚发车就被取消。只删 `.flag`，别的一概不碰。
struct CancelFlagGuard(Option<PathBuf>);

impl Drop for CancelFlagGuard {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            if is_cancel_flag(&p) {
                let _ = fs::remove_file(&p);
            }
        }
    }
}

/// 处理 http/request：用 reqwest 发送任意 URL 请求。
///
/// `emitter` 用来把 SSE 的每一块推给 UI（宿主 `host.events` 权限 → iframe 的
/// `message` 事件）。这是「订阅式」传输：单条事件只有几 KB，总量不再受
/// 8 MiB 单消息上限约束，也不会攒到最后才给。
fn handle_request(params: Value, emitter: &PluginEmitter) -> Result<Value, PluginError> {
    let method = params.get("method").and_then(Value::as_str).unwrap_or("GET").to_uppercase();
    let url = params
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| PluginError::new(-32602, "缺少 url"))?;
    let body = params.get("body").and_then(Value::as_str).unwrap_or("");
    let body_b64 = params.get("bodyBase64").and_then(Value::as_str).unwrap_or("");
    let body_type = params.get("bodyType").and_then(Value::as_str).unwrap_or("text");
    let timeout_ms = params.get("timeoutMs").and_then(Value::as_u64).unwrap_or(120_000);
    /* 订阅式流：UI 给一个 streamRequestId 并置 stream=true，后端把 SSE 事件
     * 逐块发到 `apifox/http/stream` 事件上。没有 id 或没开就照旧一次性返回。 */
    let stream_id = params
        .get("streamRequestId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let want_stream = params.get("stream").and_then(Value::as_bool).unwrap_or(false) && !stream_id.is_empty();

    /* 取消标志（可选）。UI 会传绝对路径；只认 `.flag` 结尾，传错路径不会误删别的文件。 */
    let cancel_path = params
        .get("cancelPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| is_cancel_flag(p));
    /* 发车前先清一次：上一轮停止写的标志可能还躺着（UI 的删除请求晚到了） */
    if let Some(p) = &cancel_path {
        let _ = fs::remove_file(p);
    }
    let _cancel_guard = CancelFlagGuard(cancel_path.clone());
    let cancel_ref = cancel_path.as_deref();

    /* 原始字节 body：multipart / 二进制文件上传都走这里，避免文本化把附件写坏 */
    let raw_body: Option<Vec<u8>> = if body_b64.is_empty() {
        None
    } else {
        Some(
            BASE64_STANDARD
                .decode(body_b64.as_bytes())
                .map_err(|e| PluginError::new(-32602, format!("bodyBase64 解码失败：{e}")))?,
        )
    };

    // headers: { "Name": "value", ... }
    let mut headers: HashMap<String, String> = HashMap::new();
    if let Some(h) = params.get("headers").and_then(Value::as_object) {
        for (k, v) in h {
            if let Some(s) = v.as_str() {
                headers.insert(k.clone(), s.to_string());
            }
        }
    }

    /* SSE（text/event-stream）是长连接：照普通请求读会一直挂到整体超时。
     * 这里认出「Accept 含 text/event-stream」，用单独的 client + 较短的 sseMs，
     * 到点主动收尾，把已经推过来的 data 行原样返回，并标记 sseTruncated。 */
    let wants_sse = headers.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case("accept") && v.to_ascii_lowercase().contains("text/event-stream")
    });
    /* 订阅式流没有「10 秒一刀切」的理由了：事件是陆续推给 UI 的，长流正是它要解决的场景。
     * 所以开了流就按请求超时（默认 120 秒）算，UI 显式传 sseMs 仍可覆盖。 */
    let sse_ms = params
        .get("sseMs")
        .and_then(Value::as_u64)
        .unwrap_or(if want_stream { timeout_ms.max(1000) } else { 10_000 })
        .max(1000);

    // 构建 reqwest 请求
    let client = reqwest::blocking::Client::builder()
        .timeout(if wants_sse {
            Duration::from_millis(sse_ms)
        } else if timeout_ms > 0 {
            Duration::from_millis(timeout_ms)
        } else {
            Duration::from_secs(900)
        })
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| PluginError::new(-32000, format!("client build: {e}")))?;

    let m = parse_method(&method)?;
    let mut req = client.request(m, url);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    // body
    if !["GET", "HEAD"].contains(&method.as_str()) {
        let has_ct = headers.keys().any(|k| k.eq_ignore_ascii_case("content-type"));
        if let Some(bytes) = raw_body {
            if !bytes.is_empty() {
                req = req.body(bytes);
            }
        } else if !body.is_empty() {
            req = req.body(body.to_string());
            // 若未声明 Content-Type 且为 json/form，自动补
            if !has_ct {
                match body_type {
                    "json" => req = req.header("Content-Type", "application/json"),
                    "form" => req = req.header("Content-Type", "application/x-www-form-urlencoded"),
                    _ => {}
                }
            }
        }
    }

    let start = Instant::now();
    let mut resp = req.send().map_err(|e| PluginError::new(-32000, format!("send: {e}")))?;
    let status = resp.status().as_u16();
    let status_text = resp.status().canonical_reason().unwrap_or("").to_string();
    let ok = resp.status().is_success();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // 收集响应头
    let mut res_headers = serde_json::Map::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() {
            res_headers.insert(k.as_str().to_string(), Value::String(s.to_string()));
        }
    }
    // 判断二进制：image/audio/video/font/octet-stream/pdf/zip 等
    let is_binary = is_binary_content_type(&content_type);
    let is_sse = wants_sse || content_type.to_ascii_lowercase().contains("text/event-stream");
    /* SSE：边收边攒，最多 512 KiB；到 client 超时（sseMs）或服务端断开就收尾。
     * 其它请求按 READ_CHUNK 分块读 —— 中途被取消就把已收到的部分带回去，
     * 不再把整包灌进内存（S6.1）。 */
    let mut cancelled = false;
    let mut read_error: Option<String> = None;

    /* 订阅式流只在「响应确实是 SSE」时才开。先发一个 open 事件探路：
     * 宿主没给 host.events 权限、或版本太老不转发事件，这里就会失败，
     * 直接退回老的「攒到 512 KiB 一次性返回」路径，行为与 0.9.0 一致。 */
    let stream_ok = want_stream
        && is_sse
        && emitter
            .event(
                STREAM_EVENT,
                json!({
                    "requestId": &stream_id,
                    "phase": "open",
                    "status": status,
                    "statusText": &status_text,
                    "ok": ok,
                    "contentType": &content_type,
                    "headers": res_headers.clone(),
                }),
            )
            .is_ok();

    let (bytes, sse_ended) = if stream_ok {
        /* 逐事件转发：不攒全文，只累计字节数 —— 总量再大也不会撞 8 MiB 单消息上限。 */
        let mut seq: u64 = 0;
        let mut total: u64 = 0;
        let mut pending: Vec<u8> = Vec::new();
        let mut tmp = vec![0u8; 8192];
        let mut ended = false;
        loop {
            if cancel_requested(cancel_ref) {
                cancelled = true;
                break;
            }
            match resp.read(&mut tmp) {
                Ok(0) => {
                    ended = true;
                    break;
                }
                Ok(n) => {
                    total += n as u64;
                    pending.extend_from_slice(&tmp[..n]);
                    loop {
                        let cut = sse_event_end(&pending)
                            .unwrap_or(if pending.len() >= MAX_PENDING { pending.len() } else { 0 });
                        if cut == 0 {
                            break;
                        }
                        let ev: Vec<u8> = pending.drain(..cut).collect();
                        seq += 1;
                        if emitter
                            .event(
                                STREAM_EVENT,
                                json!({
                                    "requestId": &stream_id,
                                    "seq": seq,
                                    "chunk": String::from_utf8_lossy(&ev),
                                }),
                            )
                            .is_err()
                        {
                            read_error = Some("stream: host stopped accepting events".into());
                            break;
                        }
                    }
                    if read_error.is_some() {
                        break;
                    }
                }
                Err(e) => {
                    read_error = Some(e.to_string());
                    break;
                }
            }
        }
        /* 尾部没凑满一个事件的残余也别丢 */
        if read_error.is_none() && !pending.is_empty() {
            seq += 1;
            let _ = emitter.event(
                STREAM_EVENT,
                json!({
                    "requestId": &stream_id,
                    "seq": seq,
                    "chunk": String::from_utf8_lossy(&pending),
                }),
            );
        }
        let time_ms = start.elapsed().as_millis() as u64;
        let truncated = !ended && !cancelled;
        let _ = emitter.event(
            STREAM_EVENT,
            json!({
                "requestId": &stream_id,
                "done": true,
                "seq": seq + 1,
                "status": status,
                "statusText": &status_text,
                "ok": ok,
                "contentType": &content_type,
                "headers": res_headers.clone(),
                "size": total,
                "timeMs": time_ms,
                "cancelled": cancelled,
                "truncated": truncated,
                "error": &read_error,
            }),
        );
        /* 返回体不带 body：正文已经一块块推过去了。这样「多大都行」。 */
        return Ok(json!({
            "status": status,
            "statusText": status_text,
            "ok": ok,
            "contentType": content_type,
            "headers": res_headers,
            "body": "",
            "isBase64": false,
            "size": total,
            "timeMs": time_ms,
            "sse": true,
            "streamed": true,
            "cancelled": cancelled,
            "truncated": truncated,
            "sseTruncated": !ended,
        }));
    } else if is_sse {
        /* 老路径：宿主不支持事件通道时的兜底，512 KiB 或 sseMs 到点收尾。 */
        let mut buf: Vec<u8> = Vec::new();
        let mut tmp = [0u8; 8192];
        let mut ended = false;
        loop {
            if cancel_requested(cancel_ref) { cancelled = true; break; }
            match resp.read(&mut tmp) {
                Ok(0) => { ended = true; break; }
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    if buf.len() >= 512 * 1024 { break; }
                }
                Err(_) => break,   // 超时 / 连接被对端关闭：把已收到的留下
            }
        }
        (buf, ended)
    } else {
        let mut buf: Vec<u8> = Vec::with_capacity(READ_CHUNK);
        let mut tmp = vec![0u8; READ_CHUNK];
        loop {
            if cancel_requested(cancel_ref) { cancelled = true; break; }
            match resp.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&tmp[..n]),
                Err(e) => { read_error = Some(e.to_string()); break; }
            }
        }
        /* 一块都没读到就报错，保持原来的失败语义；读到一半出错则返回部分并标记截断 */
        if buf.is_empty() {
            if let Some(e) = &read_error {
                return Err(PluginError::new(-32000, format!("read body: {e}")));
            }
        }
        (buf, true)
    };
    if cancelled {
        eprintln!("[apifox] request cancelled at {} bytes", bytes.len());
    }
    let time_ms = start.elapsed().as_millis() as u64;

    let (body_out, is_base64) = if is_binary {
        (BASE64_STANDARD.encode(&bytes), true)
    } else {
        let text = String::from_utf8_lossy(&bytes).to_string();
        (text, false)
    };

    Ok(json!({
        "status": status,
        "statusText": status_text,
        "ok": ok,
        "contentType": content_type,
        "headers": Value::Object(res_headers),
        "body": body_out,
        "isBase64": is_base64,
        "size": bytes.len(),
        "timeMs": time_ms,
        "sse": is_sse,
        "sseTruncated": is_sse && !sse_ended,
        /* 非流式路径恒 false；UI 据此决定「事件流已经画过」还是「用这次的 body」。 */
        "streamed": false,
        /* S6.1：UI 点过停止 → true，body 只带已经收到的部分；truncated 表示「没读完」。 */
        "cancelled": cancelled,
        "truncated": if is_sse { !sse_ended } else { cancelled || read_error.is_some() },
    }))
}

fn parse_method(s: &str) -> Result<reqwest::Method, PluginError> {
    match s {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        "PUT" => Ok(reqwest::Method::PUT),
        "PATCH" => Ok(reqwest::Method::PATCH),
        "DELETE" => Ok(reqwest::Method::DELETE),
        "HEAD" => Ok(reqwest::Method::HEAD),
        "OPTIONS" => Ok(reqwest::Method::OPTIONS),
        _ => Err(PluginError::new(-32602, format!("不支持的方法: {s}"))),
    }
}

fn is_binary_content_type(ct: &str) -> bool {
    let ct = ct.split(';').next().unwrap_or("").trim().to_lowercase();
    ct.starts_with("image/")
        || ct.starts_with("audio/")
        || ct.starts_with("video/")
        || ct.starts_with("font/")
        || ct == "application/octet-stream"
        || ct == "application/pdf"
        || ct == "application/zip"
        || ct.starts_with("application/x-")
}

// base64 编码（避免引入额外 crate）—— base64 0.22 用 BASE64_STANDARD 引擎
use base64::prelude::{BASE64_STANDARD};
use base64::Engine;

/* ===================== WebSocket 长连接（S8.5） =====================
 *
 * 与 HTTP 的根本差别不在协议，在生命周期：
 *   HTTP   —— 一次调用 = 一个结果，调完就结束；
 *   WS     —— 一次「connect」之后连接还活着，双向、多帧、可能挂几小时。
 *
 * 所以 sidecar 必须有**跨调用存活的状态**（这是本项目第一次）：
 *   ws/connect  建连、返回 connId；之后所有帧走 WS_EVENT 事件推给 UI
 *   ws/send     往发送队列塞一条（立刻返回，不等对端）
 *   ws/close    置关闭标志 + 发 close 帧
 *   ws/list     清点还活着的连接（UI 重载后对账用）
 *
 * 线程模型：一条连接一个线程，读超时 200ms 当「拍」——
 * 每拍先抽干发送队列，再读一帧。为什么不用 tokio：本项目其余部分是 blocking，
 * 混两套调度后，「停止后连接没断」「帧丢了」这类问题会同时落在两个调度器里，最难查。
 * 200ms 的代价是发送最多晚一拍，人感觉不到。
 */

/// 帧事件名。宿主按 `host.events` 权限转发到 iframe 的 message 事件。
const WS_EVENT: &str = "apifox/http/ws";
/// 读线程的「拍」：既要发送及时，也不能空转烧 CPU。
const WS_TICK_MS: u64 = 200;
/// 单帧上限。host.events 的单条消息有 8 MiB 硬顶，一条大二进制帧会把整条
/// 事件通道撑爆（连后面所有帧一起丢），所以这里先截断并打标记。
const WS_MAX_FRAME: usize = 1024 * 1024;

enum WsCmd {
    Text(String),
    Binary(Vec<u8>),
    Close,
}

struct WsSession {
    tx: Sender<WsCmd>,
    close: Arc<AtomicBool>,
    url: String,
    request_id: String,
    opened_at: u64,
}

fn ws_sessions() -> &'static Mutex<HashMap<String, WsSession>> {
    static CELL: OnceLock<Mutex<HashMap<String, WsSession>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 连接表被 poison 也不能让整条连接链路瘫掉（panic 的那个线程已经不在了，
/// 表本身仍是好的），所以统一走 into_inner。
fn ws_lock() -> MutexGuard<'static, HashMap<String, WsSession>> {
    ws_sessions().lock().unwrap_or_else(|e| e.into_inner())
}

/// ws:// / wss:// 之外也接受 http(s)://：用户从地址栏抄过来很常见，
/// 直接把 scheme 换掉，不要报「地址不合法」让人去改。
fn normalize_ws_url(raw: &str) -> String {
    let s = raw.trim();
    if let Some(rest) = s.strip_prefix("http://") {
        return format!("ws://{rest}");
    }
    if let Some(rest) = s.strip_prefix("https://") {
        return format!("wss://{rest}");
    }
    s.to_string()
}

fn set_ws_read_timeout(stream: &MaybeTlsStream<std::net::TcpStream>, d: Duration) {
    match stream {
        MaybeTlsStream::Plain(t) => {
            let _ = t.set_read_timeout(Some(d));
        }
        MaybeTlsStream::Rustls(s) => {
            let _ = s.sock.set_read_timeout(Some(d));
        }
        /* enum 是 non_exhaustive：以后若开 native-tls 会出现第三个变体。
         * 那种流拿不到裸 TcpStream，就退化成「断开要等对端」——能接受，不该因此编译不过。 */
        _ => {}
    }
}

/// 超长帧截断到 WS_MAX_FRAME（按字符边界切，别切出半个 UTF-8）。
fn clip_frame(s: &str) -> (String, bool) {
    if s.len() <= WS_MAX_FRAME {
        return (s.to_string(), false);
    }
    let mut cut = WS_MAX_FRAME;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    (s[..cut].to_string(), true)
}

fn emit_ws(emitter: &PluginEmitter, payload: Value) {
    /* UI 已经关了 / 重载了，事件写不进去是正常的：这时连接没有主人，
     * 读线程看到 Err 会自己收尾，别在这里重试或 panic。 */
    let _ = emitter.event(WS_EVENT, payload);
}

fn emit_ws_frame(
    emitter: &PluginEmitter,
    conn_id: &str,
    request_id: &str,
    dir: &str,
    kind: &str,
    data: &str,
    seq: u64,
) {
    let (body, truncated) = clip_frame(data);
    emit_ws(emitter, json!({
        "connId": conn_id,
        "requestId": request_id,
        "phase": "frame",
        "dir": dir,
        "kind": kind,
        "seq": seq,
        "size": data.len(),
        "truncated": truncated,
        "at": now_millis(),
        "data": body,
    }));
}

fn handle_ws_connect(params: Value, emitter: &PluginEmitter) -> Result<Value, PluginError> {
    let raw = param_str(&params, "url").unwrap_or("").to_string();
    if raw.trim().is_empty() {
        return Err(PluginError::new(-32602, "缺少 url"));
    }
    let url = normalize_ws_url(&raw);
    if !(url.starts_with("ws://") || url.starts_with("wss://")) {
        return Err(PluginError::new(-32602, format!("不是 WebSocket 地址：{raw}")));
    }
    let request_id = param_str(&params, "requestId").unwrap_or("").to_string();

    /* 握手头照原样带过去：鉴权（Authorization / Cookie / 自定义 token）全在这一步，
     * 连上之后再带就没用了。 */
    let mut req = url
        .as_str()
        .into_client_request()
        .map_err(|e| PluginError::new(-32602, format!("WebSocket 地址不合法：{e}")))?;
    if let Some(Value::Object(hs)) = params.get("headers") {
        let h = req.headers_mut();
        for (k, v) in hs {
            let Some(val) = v.as_str() else { continue };
            if let (Ok(name), Ok(hv)) = (
                tungstenite::http::HeaderName::from_bytes(k.as_bytes()),
                tungstenite::http::HeaderValue::from_str(val),
            ) {
                h.insert(name, hv);
            }
        }
    }

    let (ws, resp) = tungstenite::connect(req)
        .map_err(|e| PluginError::new(-32000, format!("WebSocket 连接失败：{e}")))?;
    /* 没有这个超时，读线程会一直挂在 read 上：用户点断开、UI 关闭、host 停止收事件，
     * 三种情况都醒不过来。 */
    set_ws_read_timeout(ws.get_ref(), Duration::from_millis(WS_TICK_MS));
    let status = resp.status().as_u16();

    static WS_SEQ: AtomicU64 = AtomicU64::new(0);
    let conn_id = format!("ws-{}-{}", now_millis(), WS_SEQ.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = std::sync::mpsc::channel();
    let close = Arc::new(AtomicBool::new(false));
    ws_lock().insert(
        conn_id.clone(),
        WsSession { tx, close: close.clone(), url: url.clone(), request_id: request_id.clone(), opened_at: now_millis() },
    );

    emit_ws(emitter, json!({
        "connId": &conn_id,
        "requestId": &request_id,
        "phase": "open",
        "status": status,
        "url": &url,
    }));

    let em = emitter.clone();
    let cid = conn_id.clone();
    std::thread::spawn(move || ws_read_loop(ws, rx, close, em, cid, request_id));

    Ok(json!({ "connId": conn_id, "status": status, "url": url }))
}

fn ws_read_loop(
    mut ws: WebSocket<MaybeTlsStream<std::net::TcpStream>>,
    rx: Receiver<WsCmd>,
    close: Arc<AtomicBool>,
    emitter: PluginEmitter,
    conn_id: String,
    request_id: String,
) {
    let mut seq: u64 = 0;

    let reason: String = 'conn: loop {
        /* 1) 先把发送队列抽干。放在读之前：读最多阻塞一拍（200ms），
         * 用户在 UI 上点「发送」不该排队等到读超时之后。 */
        loop {
            match rx.try_recv() {
                Ok(WsCmd::Text(t)) => {
                    seq += 1;
                    if ws.send(Message::Text(t.clone().into())).is_err() {
                        break 'conn "send-failed".to_string();
                    }
                    emit_ws_frame(&emitter, &conn_id, &request_id, "out", "text", &t, seq);
                }
                Ok(WsCmd::Binary(b)) => {
                    seq += 1;
                    let b64 = BASE64_STANDARD.encode(&b);
                    if ws.send(Message::Binary(b.into())).is_err() {
                        break 'conn "send-failed".to_string();
                    }
                    emit_ws_frame(&emitter, &conn_id, &request_id, "out", "binary", &b64, seq);
                }
                Ok(WsCmd::Close) => {
                    let _ = ws.close(None);
                    break 'conn "closed".to_string();
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break 'conn "closed".to_string(),
            }
        }

        /* 2) 用户点了「断开」。close(None) 之后对端通常会回一个 close 帧，
         * 但不等它 —— 半开连接（拔网线、对面装死）不能让线程一直挂着。 */
        if close.load(Ordering::Relaxed) {
            let _ = ws.close(None);
            break "closed".to_string();
        }

        /* 3) 读一帧。超时是正常的「拍」，不是错误。 */
        match ws.read() {
            Ok(Message::Text(t)) => {
                seq += 1;
                emit_ws_frame(&emitter, &conn_id, &request_id, "in", "text", t.as_str(), seq);
            }
            Ok(Message::Binary(b)) => {
                seq += 1;
                let b64 = BASE64_STANDARD.encode(&b);
                emit_ws_frame(&emitter, &conn_id, &request_id, "in", "binary", &b64, seq);
            }
            /* 心跳由 tungstenite 自己回 pong，这里不用管，也不该出现在消息面板里。 */
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
            Ok(Message::Close(f)) => {
                break match f {
                    Some(c) => {
                        let why = c.reason.to_string();
                        if why.is_empty() {
                            format!("closed:{}", u16::from(c.code))
                        } else {
                            format!("closed:{} {}", u16::from(c.code), why)
                        }
                    }
                    None => "closed".to_string(),
                };
            }
            /* Frame 是内部分片，tungstenite 已经拼好了，不会走到这里。 */
            Ok(Message::Frame(_)) => {}
            Err(WsError::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(WsError::ConnectionClosed | WsError::AlreadyClosed) => {
                break "closed".to_string();
            }
            Err(e) => break format!("error:{e}"),
        }
    };

    ws_lock().remove(&conn_id);
    emit_ws(&emitter, json!({
        "connId": &conn_id,
        "requestId": &request_id,
        "phase": "close",
        "reason": reason,
    }));
}

fn handle_ws_send(params: Value) -> Result<Value, PluginError> {
    let conn_id = param_str(&params, "connId")
        .ok_or_else(|| PluginError::new(-32602, "缺少 connId"))?
        .to_string();
    let kind = param_str(&params, "kind").unwrap_or("text");
    let data = param_str(&params, "data").unwrap_or("");

    let tx = ws_lock()
        .get(&conn_id)
        .map(|s| s.tx.clone())
        .ok_or_else(|| PluginError::new(-32000, "连接不存在或已关闭"))?;

    let cmd = if kind == "binary" {
        let raw = BASE64_STANDARD
            .decode(data)
            .map_err(|e| PluginError::new(-32602, format!("二进制内容不是合法 base64：{e}")))?;
        WsCmd::Binary(raw)
    } else {
        WsCmd::Text(data.to_string())
    };
    tx.send(cmd)
        .map_err(|_| PluginError::new(-32000, "连接已关闭（读线程已退出）"))?;
    Ok(json!({ "ok": true }))
}

fn handle_ws_close(params: Value) -> Result<Value, PluginError> {
    let conn_id = param_str(&params, "connId").unwrap_or("").to_string();
    if let Some(s) = ws_lock().get(&conn_id) {
        s.close.store(true, Ordering::Relaxed);
        let _ = s.tx.send(WsCmd::Close);
    }
    /* 幂等：UI 可能在 close 事件之后才补这一下，不能因此报错。 */
    Ok(json!({ "ok": true }))
}

fn handle_ws_list() -> Result<Value, PluginError> {
    let items: Vec<Value> = ws_lock()
        .iter()
        .map(|(id, s)| {
            json!({
                "connId": id,
                "url": s.url,
                "requestId": s.request_id,
                "openedAt": s.opened_at,
            })
        })
        .collect();
    Ok(json!({ "items": items }))
}

fn main() -> std::io::Result<()> {
    let metadata = PluginMetadata::new("com.fax.apifox", env!("CARGO_PKG_VERSION"))
        .with_capability("events");
    PluginServer::new(metadata, PolarisApi).serve()
}
