// backend/src/apifox.rs — Apifox 同步（内部 API 优先 + 官方 OpenAPI 降级）。
//
// 这一层只负责“和 Apifox 说话”，不碰本地 .http 文件：
//   - apifox/test              连接测试
//   - apifox/getApiTree        接口树（api-tree-list → http-apis 分页 → export-openapi）
//   - apifox/getApi            单个接口详情
//   - apifox/listFolders       目录列表
//   - apifox/createApi         新增接口（内部失败且可降级时整文档 OpenAPI 回灌）
//   - apifox/updateApi         修改接口（支持 originalPath/originalMethod）
//   - apifox/deleteApi         删除接口（含降级伪 ID）
//   - apifox/listEnvironments  环境列表 + 详情 + 服务名装饰
//   - apifox/createEnvironment / updateEnvironment / deleteEnvironment
//   - apifox/diagnoseSync      数量差异诊断
//   - apifox/exportOpenapi / importOpenapi
//
// 配置由 UI 每次调用传入（config 对象）；accessToken 只在进程内存里使用，不落盘、不回显。

use dbx_plugin_sdk::{PluginEmitter, PluginError};
use reqwest::blocking::Client;
use reqwest::{Method, Url};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

const DEFAULT_BASE: &str = "https://api.apifox.com";
const DEFAULT_API_VERSION: &str = "2024-03-28";
const DEFAULT_CLIENT_VERSION: &str = "2.8.28-alpha.1";
const KNOWN_METHODS: [&str; 8] = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

#[derive(Clone, Debug)]
struct ApifoxConfig {
    base_url: String,
    access_token: String,
    project_id: String,
    api_version: String,
    client_version: String,
}

fn clean_str(v: &Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(x) = v.get(*k) {
            match x {
                Value::String(s) => {
                    let t = s.trim();
                    if !t.is_empty() {
                        return t.to_string();
                    }
                }
                Value::Number(n) => return num_text(n),
                Value::Bool(b) => return b.to_string(),
                _ => {}
            }
        }
    }
    String::new()
}

fn num_text(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    if let Some(f) = n.as_f64() {
        if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
            return format!("{}", f as i64);
        }
        return f.to_string();
    }
    n.to_string()
}

fn config_from(params: &Value) -> Result<ApifoxConfig, PluginError> {
    let src = params.get("config").filter(|v| v.is_object()).unwrap_or(params);
    let mut base = clean_str(src, &["baseUrl", "base_url"]);
    if base.is_empty() {
        base = DEFAULT_BASE.to_string();
    }
    let base = base.trim_end_matches('/').to_string();
    let access_token = clean_str(src, &["accessToken", "access_token"]);
    let project_id = clean_str(src, &["projectId", "project_id"]);
    if access_token.is_empty() {
        return Err(PluginError::new(-32602, "缺少 Apifox accessToken"));
    }
    if project_id.is_empty() {
        return Err(PluginError::new(-32602, "缺少 Apifox projectId"));
    }
    let mut api_version = clean_str(src, &["apiVersion", "api_version"]);
    if api_version.is_empty() {
        api_version = DEFAULT_API_VERSION.to_string();
    }
    let mut client_version = clean_str(src, &["clientVersion", "client_version"]);
    if client_version.is_empty() {
        client_version = DEFAULT_CLIENT_VERSION.to_string();
    }
    Ok(ApifoxConfig { base_url: base, access_token, project_id, api_version, client_version })
}

#[derive(Debug, Clone)]
struct ApiErr {
    status: u16,
    message: String,
}

impl ApiErr {
    fn plain(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
    fn text(&self) -> String {
        if self.status == 0 {
            self.message.clone()
        } else {
            format!("apifox http {}: {}", self.status, self.message)
        }
    }
    fn plugin(&self) -> PluginError {
        PluginError::new(-32000, format!("Apifox API failed: {}", self.text()))
    }
}

fn truncated(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

fn error_message(body: &str) -> String {
    let v: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return truncated(body, 300),
    };
    for k in ["message", "errorMessage", "error"] {
        let s = clean_str(&v, &[k]);
        if !s.is_empty() {
            return truncated(&s, 300);
        }
    }
    truncated(body.trim(), 300)
}

fn parse_json(raw: &str) -> Result<Value, ApiErr> {
    if raw.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(raw).map_err(|e| ApiErr::plain(0, format!("failed to parse Apifox response: {}", e)))
}

fn api_call(
    cfg: &ApifoxConfig,
    official: bool,
    method: &str,
    path: &str,
    query: &[(&str, String)],
    body: Option<&Value>,
) -> Result<(u16, String), ApiErr> {
    let prefix = if official { "v1" } else { "api/v1" };
    let base = format!("{}/{}/{}", cfg.base_url, prefix, path.trim_start_matches('/'));
    let mut url = Url::parse(&base)
        .map_err(|e| ApiErr::plain(0, format!("invalid Apifox URL: {}", e)))?;
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (k, v) in query {
            pairs.append_pair(k, v);
        }
    }
    let http_method = Method::from_bytes(method.to_uppercase().as_bytes())
        .unwrap_or(Method::GET);
    let client = Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| ApiErr::plain(0, format!("failed to build HTTP client: {}", e)))?;
    let mut req = client
        .request(http_method, url)
        .header("Authorization", format!("Bearer {}", cfg.access_token))
        .header("X-Apifox-Api-Version", &cfg.api_version)
        .header("Accept", "application/json");
    if !official {
        // 这两个头是内部 API 的硬性要求；缺 X-Client-Version 会拿到 400/400105。
        req = req.header("X-Client-Version", &cfg.client_version);
        if !cfg.project_id.is_empty() {
            req = req.header("X-Project-Id", &cfg.project_id);
        }
    }
    if let Some(b) = body {
        // 项目里的 reqwest 没开 json feature：手工序列化 + body() 等效，不引入新依赖。
        let text = serde_json::to_string(b)
            .map_err(|e| ApiErr::plain(0, format!("failed to encode request body: {}", e)))?;
        req = req.header("Content-Type", "application/json").body(text);
    } else if official {
        req = req.header("Content-Type", "application/json");
    }
    let resp = req.send().map_err(|e| ApiErr::plain(0, format!("network error: {}", e)))?;
    let status = resp.status().as_u16();
    let text = resp.text().unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(ApiErr { status, message: error_message(&text) });
    }
    Ok((status, text))
}

fn call_json(
    cfg: &ApifoxConfig,
    official: bool,
    method: &str,
    path: &str,
    query: &[(&str, String)],
    body: Option<&Value>,
) -> Result<Value, ApiErr> {
    let (_, text) = api_call(cfg, official, method, path, query, body)?;
    parse_json(&text)
}

fn unwrap_data(v: &Value) -> Value {
    if let Some(obj) = v.as_object() {
        if obj.get("success").and_then(|x| x.as_bool()) == Some(true) {
            if let Some(d) = obj.get("data") {
                if !d.is_null() {
                    return d.clone();
                }
            }
        }
    }
    v.clone()
}

fn i(method: &str, cfg: &ApifoxConfig, path: &str, query: &[(&str, String)], body: Option<&Value>) -> Result<Value, ApiErr> {
    call_json(cfg, false, method, path, query, body)
}

fn pp(s: &str) -> String {
    s.trim().to_string()
}

/* ===================== 接口树 ===================== */

fn folder_node(id: String, name: String, children: Vec<Value>) -> Value {
    json!({ "id": id, "name": name, "type": "folder", "children": children })
}

fn api_node(id: String, name: String, method: String, path: String, definition: Value, folder_path: String, degraded: bool) -> Value {
    let mut n = json!({
        "id": id,
        "name": name,
        "type": "api",
        "method": method,
        "path": path,
        "definition": definition
    });
    if !folder_path.is_empty() {
        n["folderPath"] = Value::String(folder_path);
    }
    if degraded {
        n["degraded"] = Value::Bool(true);
    }
    n
}

fn convert_internal_node(v: &Value) -> Option<Value> {
    let api = if let Some(a) = v.get("api") {
        if a.is_object() { a } else { v }
    } else if matches!(clean_str(v, &["type"]).as_str(), "apiDetail" | "api") {
        v
    } else {
        v
    };
    let method = pp(&clean_str(api, &["method", "httpMethod"]));
    let path = pp(&clean_str(api, &["path", "url", "uri"]));
    if !method.is_empty() && !path.is_empty() {
        let id = clean_str(api, &["id", "apiId"]);
        let name = {
            let n = clean_str(api, &["name", "summary", "title"]);
            if n.is_empty() { path.clone() } else { n }
        };
        return Some(api_node(
            if id.is_empty() { format!("{} {}", method.to_uppercase(), path) } else { id.clone() },
            name,
            method.to_uppercase(),
            path,
            api.clone(),
            String::new(),
            false,
        ));
    }
    let children = match v.get("children").and_then(|x| x.as_array()) {
        Some(a) => a.iter().filter_map(convert_internal_node).collect::<Vec<_>>(),
        None => Vec::new(),
    };
    let mut name = clean_str(v, &["name", "summary", "folderName", "title", "label"]);
    if name.is_empty() && children.is_empty() {
        return None;
    }
    if name.is_empty() {
        name = "未命名目录".to_string();
    }
    let id = {
        let x = clean_str(v, &["id", "folderId", "key"]);
        if x.is_empty() { format!("folder:{}", name) } else { x }
    };
    Some(folder_node(id, name, children))
}

fn normalize_internal_tree(raw: &Value) -> Vec<Value> {
    let data = unwrap_data(raw);
    let arr = if data.is_array() {
        data.as_array().cloned().unwrap_or_default()
    } else if data.is_object() {
        let mut found = None;
        for k in ["tree", "nodes", "items", "data", "children"] {
            if let Some(a) = data.get(k).and_then(|x| x.as_array()) {
                found = Some(a.clone());
                break;
            }
        }
        found.unwrap_or_default()
    } else {
        Vec::new()
    };
    arr.iter().filter_map(convert_internal_node).collect()
}

fn decode_api_list_page(raw: &Value) -> (Vec<Value>, usize) {
    let d = unwrap_data(raw);
    let mut items: Vec<Value> = Vec::new();
    let mut total = 0usize;
    if d.is_array() {
        items = d.as_array().cloned().unwrap_or_default();
        total = items.len();
    } else if let Some(obj) = d.as_object() {
        for k in ["total", "totalCount", "count", "totalSize"] {
            if let Some(n) = obj.get(k).and_then(|x| x.as_u64()) {
                total = n as usize;
                break;
            }
        }
        for k in ["items", "list", "data", "apis", "records", "httpApis", "rows"] {
            if let Some(a) = obj.get(k).and_then(|x| x.as_array()) {
                items = a.clone();
                break;
            }
        }
        if items.is_empty() {
            for wrap in ["data", "result"] {
                if let Some(inner) = obj.get(wrap) {
                    if let Some(a) = inner.get("list").and_then(|x| x.as_array()) {
                        items = a.clone();
                    } else if let Some(a) = inner.get("items").and_then(|x| x.as_array()) {
                        items = a.clone();
                    } else if let Some(a) = inner.get("records").and_then(|x| x.as_array()) {
                        items = a.clone();
                    }
                    if total == 0 {
                        for k in ["total", "totalCount", "count"] {
                            if let Some(n) = inner.get(k).and_then(|x| x.as_u64()) {
                                total = n as usize;
                                break;
                            }
                        }
                    }
                    if !items.is_empty() {
                        break;
                    }
                }
            }
        }
    }
    (items, total)
}

fn list_all_http_apis(cfg: &ApifoxConfig) -> Result<(Vec<Value>, usize), ApiErr> {
    let mut all = Vec::new();
    let mut reported = 0usize;
    let mut seen: HashSet<String> = HashSet::new();
    for page in 1..=200usize {
        let p = page.to_string();
        let q = [
            ("pageSize", "200".to_string()),
            ("page", p.clone()),
            ("pageIndex", p),
        ];
        let raw = i("GET", cfg, &format!("projects/{}/http-apis", cfg.project_id), &q, None)?;
        let (items, total) = decode_api_list_page(&raw);
        if total > reported {
            reported = total;
        }
        /* 不能再用「本页不足 200 条」提前停：Apifox 部分项目忽略了 pageSize，
         * 每页只回 10 条，但仍能按 page 继续翻。按接口身份去重后，
         * 只有「本页没有任何新接口」才说明分页参数无效或已到末页。 */
        let mut fresh = Vec::new();
        for item in items {
            let id = clean_str(&item, &["id", "apiId"]);
            let key = if !id.is_empty() {
                id
            } else {
                let m = clean_str(&item, &["method", "httpMethod", "requestMethod"]).to_uppercase();
                let pth = clean_str(&item, &["path", "url", "uri", "requestPath"]);
                format!("{} {}", m, pth)
            };
            if seen.insert(key) {
                fresh.push(item);
            }
        }
        let n = fresh.len();
        all.extend(fresh);
        if n == 0 {
            break;
        }
        if reported > 0 && all.len() >= reported {
            break;
        }
    }
    Ok((all, reported))
}

fn list_folders_raw(cfg: &ApifoxConfig) -> Result<Vec<Value>, ApiErr> {
    let raw = i("GET", cfg, &format!("projects/{}/api-detail-folders", cfg.project_id), &[], None)?;
    let d = unwrap_data(&raw);
    if d.is_array() {
        return Ok(d.as_array().cloned().unwrap_or_default());
    }
    if let Some(obj) = d.as_object() {
        for k in ["items", "folders", "data", "list"] {
            if let Some(a) = obj.get(k).and_then(|x| x.as_array()) {
                return Ok(a.clone());
            }
        }
    }
    Ok(Vec::new())
}

fn build_tree_from_lists(apis: Vec<Value>, folders: Vec<Value>) -> Vec<Value> {
    let mut fmap: HashMap<String, (String, String)> = HashMap::new(); // id -> (name, parent)
    let mut forder: Vec<String> = Vec::new();
    for f in &folders {
        let id = clean_str(f, &["id", "folderId", "key"]);
        if id.is_empty() || fmap.contains_key(&id) {
            continue;
        }
        let name = {
            let n = clean_str(f, &["name", "folderName", "title", "summary"]);
            if n.is_empty() { "未命名目录".to_string() } else { n }
        };
        let parent = clean_str(f, &["parentId", "parentID", "parent_id", "pid"]);
        fmap.insert(id.clone(), (name, parent));
        forder.push(id);
    }
    let mut amap: HashMap<String, Vec<Value>> = HashMap::new();
    let mut root_apis: Vec<Value> = Vec::new();
    for a in &apis {
        let method = clean_str(a, &["method", "httpMethod", "requestMethod"]);
        let path = pp(&clean_str(a, &["path", "url", "uri", "requestPath"]));
        if method.is_empty() || path.is_empty() {
            continue;
        }
        let id = clean_str(a, &["id", "apiId"]);
        let name = {
            let n = clean_str(a, &["name", "summary", "title"]);
            if n.is_empty() { path.clone() } else { n }
        };
        let node = api_node(
            if id.is_empty() { format!("{} {}", method.to_uppercase(), path) } else { id },
            name,
            method.to_uppercase(),
            path,
            a.clone(),
            String::new(),
            false,
        );
        let fid = clean_str(a, &["folderId", "apiFolderId", "apiDetailFolderId", "folder_id"]);
        if !fid.is_empty() && fmap.contains_key(&fid) {
            amap.entry(fid).or_default().push(node);
        } else {
            root_apis.push(node);
        }
    }

    fn build(
        fid: &str,
        fmap: &HashMap<String, (String, String)>,
        forder: &[String],
        amap: &HashMap<String, Vec<Value>>,
        visited: &mut HashSet<String>,
    ) -> Value {
        let (name, _) = fmap.get(fid).cloned().unwrap_or_else(|| (fid.to_string(), String::new()));
        let mut children = Vec::new();
        if visited.insert(fid.to_string()) {
            for child in forder {
                let (_, parent) = fmap.get(child).cloned().unwrap_or_default();
                if parent == fid && child != fid && !visited.contains(child) {
                    children.push(build(child, fmap, forder, amap, visited));
                }
            }
            visited.remove(fid);
        }
        if let Some(list) = amap.get(fid) {
            children.extend(list.clone());
        }
        folder_node(fid.to_string(), name, children)
    }

    let mut out = Vec::new();
    for fid in &forder {
        let (_, parent) = fmap.get(fid).cloned().unwrap_or_default();
        if parent.is_empty() || !fmap.contains_key(&parent) {
            let mut visited = HashSet::new();
            out.push(build(fid, &fmap, &forder, &amap, &mut visited));
        }
    }
    out.extend(root_apis);
    out
}

/* ===== OpenAPI 顺序：从原始 JSON 文本里取对象 key，避免 serde_json Map 排序丢失 Apifox 原始顺序 ===== */

fn skip_ws(raw: &str, mut i: usize) -> usize {
    let b = raw.as_bytes();
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

fn read_json_string(raw: &str, start: usize) -> Option<(String, usize)> {
    let b = raw.as_bytes();
    if b.get(start) != Some(&b'"') {
        return None;
    }
    let mut i = start + 1;
    let mut escaped = false;
    while i < b.len() {
        if escaped {
            escaped = false;
            i += 1;
            continue;
        }
        if b[i] == b'\\' {
            escaped = true;
            i += 1;
            continue;
        }
        if b[i] == b'"' {
            let s: String = serde_json::from_str(&raw[start..=i]).ok()?;
            return Some((s, i + 1));
        }
        i += 1;
    }
    None
}

fn find_key_start(raw: &str, from: usize, key: &str) -> Option<usize> {
    let b = raw.as_bytes();
    let mut i = from;
    let mut depth = 0i32;
    while i < b.len() {
        match b[i] {
            b'{' | b'[' => {
                depth += 1;
                i += 1;
            }
            b'}' | b']' => {
                if depth == 0 {
                    return None;
                }
                depth -= 1;
                i += 1;
            }
            b'"' if depth == 0 => {
                let (s, next) = read_json_string(raw, i)?;
                if s == key {
                    let p = skip_ws(raw, next);
                    if b.get(p) == Some(&b':') {
                        return Some(p + 1);
                    }
                }
                i = next;
            }
            _ => i += 1,
        }
    }
    None
}

fn keys_at(raw: &str, path: &[&str]) -> Vec<String> {
    let b = raw.as_bytes();
    let mut pos = 0usize;
    for k in path {
        let p = match find_key_start(raw, pos, k) {
            Some(p) => p,
            None => return Vec::new(),
        };
        pos = skip_ws(raw, p);
        if b.get(pos) != Some(&b'{') {
            return Vec::new();
        }
    }
    let mut out = Vec::new();
    let mut i = pos + 1;
    let mut depth = 0i32;
    while i < b.len() {
        match b[i] {
            b'{' | b'[' => {
                depth += 1;
                i += 1;
            }
            b'}' | b']' => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
                i += 1;
            }
            b'"' if depth == 0 => {
                if let Some((s, next)) = read_json_string(raw, i) {
                    let p = skip_ws(raw, next);
                    if b.get(p) == Some(&b':') {
                        out.push(s);
                    }
                    i = next;
                } else {
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }
    out
}

fn folder_path_of(op: &Value) -> String {
    let direct = clean_str(op, &["x-apifox-folder"]);
    if !direct.is_empty() {
        return direct;
    }
    if let Some(tags) = op.get("tags").and_then(|x| x.as_array()) {
        for t in tags {
            if let Some(s) = t.as_str() {
                if !s.trim().is_empty() {
                    return s.trim().to_string();
                }
            }
            let inner = clean_str(t, &["name", "value"]);
            if !inner.is_empty() {
                return inner;
            }
        }
    }
    String::new()
}

fn openapi_tree(doc: &Value, raw: &str) -> Vec<Value> {
    let paths = match doc.get("paths").and_then(|x| x.as_object()) {
        Some(p) => p,
        None => return Vec::new(),
    };
    let mut path_keys = keys_at(raw, &["paths"]);
    if path_keys.is_empty() {
        path_keys = paths.keys().cloned().collect();
    }
    let mut out = Vec::new();
    for path in path_keys {
        let entry = match paths.get(&path).and_then(|x| x.as_object()) {
            Some(e) => e,
            None => continue,
        };
        let mut methods = keys_at(raw, &["paths", &path]);
        if methods.is_empty() {
            methods = entry.keys().cloned().collect();
        }
        for m in methods {
            let lower = m.to_lowercase();
            if !KNOWN_METHODS.contains(&lower.as_str()) {
                continue;
            }
            let op = match entry.get(&lower) {
                Some(v) if v.is_object() => v,
                _ => continue,
            };
            let name = {
                let n = clean_str(op, &["summary", "operationId"]);
                if n.is_empty() { path.clone() } else { n }
            };
            let fp = folder_path_of(op);
            let id = format!("{} {}", lower.to_uppercase(), path);
            out.push(api_node(id, name, lower.to_uppercase(), path.clone(), op.clone(), fp, true));
        }
    }
    out
}

fn export_openapi_raw(cfg: &ApifoxConfig) -> Result<String, ApiErr> {
    let body = json!({
        "scope": { "type": "ALL" },
        "options": { "includeApifoxExtensionProperties": true, "addFoldersToTags": true },
        "oasVersion": "3.1",
        "exportFormat": "JSON"
    });
    let (_, text) = api_call(
        cfg,
        true,
        "POST",
        &format!("projects/{}/export-openapi?locale=zh-CN", cfg.project_id),
        &[],
        Some(&body),
    )?;
    Ok(text)
}

fn export_openapi_doc(cfg: &ApifoxConfig) -> Result<Value, ApiErr> {
    parse_json(&export_openapi_raw(cfg)?)
}

fn count_api_nodes(nodes: &[Value]) -> usize {
    nodes.iter().map(|n| {
        let self_n = if n.get("type").and_then(|x| x.as_str()) == Some("api") { 1 } else { 0 };
        let kids = n.get("children").and_then(|x| x.as_array())
            .map(|a| count_api_nodes(a)).unwrap_or(0);
        self_n + kids
    }).sum()
}

fn get_api_tree(cfg: &ApifoxConfig) -> Result<Value, ApiErr> {
    // api-tree-list 在部分项目里只给叶子 id/name，没有 method/path；
    // http-apis 在部分项目里分页参数被忽略、只回第一页（例如 10 条）。
    // 因此把三者都取回来按数量择优，而不是「内部列表非空就直接用」。
    let tree_nodes = match i("GET", cfg, &format!("projects/{}/api-tree-list", cfg.project_id), &[], None) {
        Ok(raw) => normalize_internal_tree(&raw),
        Err(_) => Vec::new(),
    };
    let tree_count = count_api_nodes(&tree_nodes);

    let internal = list_all_http_apis(cfg).ok();
    let list_count = internal.as_ref().map(|(a, _)| a.len()).unwrap_or(0);
    let reported = internal.as_ref().map(|(_, r)| *r).unwrap_or(0);

    // OpenAPI 导出通常是全量的（重复 method+path 会被合并，但远好过只拿到第一页）。
    // 仅当它比内部候选更全时才采用；导出失败则静默忽略。
    let openapi_nodes = (|| -> Option<Vec<Value>> {
        let raw = export_openapi_raw(cfg).ok()?;
        let doc = parse_json(&raw).ok()?;
        Some(openapi_tree(&doc, &raw))
    })();
    let openapi_count = openapi_nodes.as_ref().map(|n| count_api_nodes(n)).unwrap_or(0);

    if openapi_count > list_count && openapi_count > tree_count {
        if let Some(nodes) = openapi_nodes.clone() {
            return Ok(json!({
                "nodes": nodes,
                "source": "openapi",
                "degraded": true,
                "treeCount": tree_count,
                "listCount": list_count,
                "openapiCount": openapi_count,
                "reportedTotal": reported,
                "note": format!("内部接口列表只拿到 {} 个、接口树 {} 个，OpenAPI 导出 {} 个；已自动改用 OpenAPI（重复 method+path 会合并）", list_count, tree_count, openapi_count)
            }));
        }
    }

    if let Some((apis, reported)) = internal {
        if !apis.is_empty() {
            let list_count = apis.len();
            let (nodes, source, note) = if !tree_nodes.is_empty() && tree_count >= list_count {
                (tree_nodes, "internal", String::new())
            } else {
                let folders = list_folders_raw(cfg).unwrap_or_default();
                let note = if tree_nodes.is_empty() {
                    "api-tree-list 不可用，已使用内部全量接口列表".to_string()
                } else {
                    format!("api-tree-list 只识别到 {} 个接口，已改用内部全量列表 {} 个接口", tree_count, list_count)
                };
                (build_tree_from_lists(apis, folders), "internal-http-apis", note)
            };
            let mut out = json!({
                "nodes": nodes,
                "source": source,
                "degraded": false,
                "treeCount": tree_count,
                "listCount": list_count,
                "openapiCount": openapi_count,
                "reportedTotal": reported
            });
            if !note.is_empty() { out["note"] = json!(note); }
            return Ok(out);
        }
    }

    // 内部全量列表不可用时，退回 api-tree-list（即使它可能不完整，也优于空结果）。
    if !tree_nodes.is_empty() || !openapi_nodes.is_none() {
        let (nodes, source, degraded, note) = if !tree_nodes.is_empty() {
            (tree_nodes, "internal", false,
             if tree_count == 0 { "api-tree-list 未返回可识别的接口（叶子缺少 method/path），且内部全量列表不可用".to_string() } else { String::new() })
        } else {
            (openapi_nodes.unwrap_or_default(), "openapi", true,
             "内部 API 不可用，已使用官方 OpenAPI 降级；重复 method+path 会合并".to_string())
        };
        let mut out = json!({
            "nodes": nodes,
            "source": source,
            "degraded": degraded,
            "treeCount": tree_count,
            "listCount": 0,
            "openapiCount": openapi_count,
            "reportedTotal": 0
        });
        if !note.is_empty() { out["note"] = json!(note); }
        return Ok(out);
    }

    // 所有数据源都失败：把错误抛出去，别返回空树让用户以为同步成功。
    Err(ApiErr::plain(0, "api-tree-list、内部接口列表与 OpenAPI 导出全部不可用"))
}

/* ===================== 环境 ===================== */

fn decode_embedded(v: &Value) -> Value {
    if let Some(s) = v.as_str() {
        if let Ok(x) = serde_json::from_str::<Value>(s) {
            return x;
        }
    }
    v.clone()
}

fn server_infos(v: &Value) -> Vec<Value> {
    let arr = decode_embedded(v);
    let mut out = Vec::new();
    if let Some(a) = arr.as_array() {
        for s in a {
            let mut id = clean_str(s, &["id", "serverId", "key"]);
            let mut name = clean_str(s, &["name", "label", "title"]);
            let module = clean_str(s, &["moduleName", "module", "groupName"]);
            if id.is_empty() && !name.is_empty() {
                id = name.clone();
            }
            if name.is_empty() {
                name = id.clone();
            }
            if id.is_empty() {
                continue;
            }
            out.push(json!({ "id": id, "name": name, "module": module }));
        }
    }
    out
}

fn decorate_environment(env: &Value, project_servers: &[Value]) -> Value {
    let mut out = env.as_object().cloned().unwrap_or_default();
    let mut names: HashMap<String, String> = HashMap::new();
    let mut modules: HashMap<String, String> = HashMap::new();
    for s in project_servers {
        let id = clean_str(s, &["id"]);
        if id.is_empty() {
            continue;
        }
        names.insert(id.clone(), clean_str(s, &["name"]));
        modules.insert(id.clone(), clean_str(s, &["module"]));
    }
    let env_servers = server_infos(env.get("servers").unwrap_or(&Value::Null));
    for s in &env_servers {
        let id = clean_str(s, &["id"]);
        if id.is_empty() {
            continue;
        }
        names.insert(id.clone(), clean_str(s, &["name"]));
        modules.insert(id.clone(), clean_str(s, &["module"]));
    }
    names.insert("default".to_string(), "默认".to_string());
    modules.insert("default".to_string(), "默认模块".to_string());

    let variables = decode_embedded(env.get("variables").unwrap_or(&Value::Null));
    let base_urls = decode_embedded(env.get("baseUrls").unwrap_or(&Value::Null));
    out.insert("variables".to_string(), variables.clone());
    out.insert("baseUrls".to_string(), base_urls.clone());

    let mut rows = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for s in env_servers.iter().chain(project_servers.iter()) {
        let id = clean_str(s, &["id"]);
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let url = base_urls.get(&id).map(|x| x.as_str().unwrap_or("").to_string()).unwrap_or_default();
        rows.push(json!({
            "id": id,
            "name": names.get(&id).cloned().unwrap_or_default(),
            "moduleName": modules.get(&id).cloned().unwrap_or_default(),
            "url": url
        }));
    }
    if let Some(obj) = base_urls.as_object() {
        let mut rest: Vec<&String> = obj.keys().filter(|k| !seen.contains(*k)).collect();
        rest.sort();
        for id in rest {
            let url = obj.get(id).and_then(|x| x.as_str()).unwrap_or("").to_string();
            rows.push(json!({
                "id": id,
                "name": names.get(id).cloned().unwrap_or_default(),
                "moduleName": modules.get(id).cloned().unwrap_or_default(),
                "url": url
            }));
        }
    }
    out.insert("serverNames".to_string(), json!(names));
    out.insert("serverModules".to_string(), json!(modules));
    out.insert("baseUrlRows".to_string(), json!(rows));
    Value::Object(out)
}

fn list_environments(cfg: &ApifoxConfig) -> Result<Value, ApiErr> {
    let raw = i("GET", cfg, &format!("projects/{}/environments", cfg.project_id), &[], None)?;
    let d = unwrap_data(&raw);
    let list = if d.is_array() {
        d.as_array().cloned().unwrap_or_default()
    } else if let Some(obj) = d.as_object() {
        let mut found = None;
        for k in ["items", "list", "data", "environments"] {
            if let Some(a) = obj.get(k).and_then(|x| x.as_array()) {
                found = Some(a.clone());
                break;
            }
        }
        found.ok_or_else(|| ApiErr::plain(0, "failed to parse environment list"))?
    } else {
        return Err(ApiErr::plain(0, "failed to parse environment list"));
    };
    let project_servers = match i("GET", cfg, &format!("projects/{}/project-setting", cfg.project_id), &[], None) {
        Ok(v) => server_infos(unwrap_data(&v).get("servers").unwrap_or(&Value::Null)),
        Err(_) => Vec::new(),
    };
    let mut items = Vec::new();
    for summary in list {
        let id = clean_str(&summary, &["id"]);
        let mut env = summary.clone();
        if !id.is_empty() {
            if let Ok(detail_raw) = i("GET", cfg, &format!("environments/{}", id), &[], None) {
                let detail = unwrap_data(&detail_raw);
                if detail.is_object() {
                    let mut merged = summary.as_object().cloned().unwrap_or_default();
                    if let Some(dobj) = detail.as_object() {
                        for (k, v) in dobj {
                            merged.insert(k.clone(), v.clone());
                        }
                    }
                    if merged.get("variables").map(|x| x.as_array().map(|a| a.is_empty()).unwrap_or(false)).unwrap_or(false) {
                        if let Some(v) = summary.get("variables") {
                            merged.insert("variables".to_string(), v.clone());
                        }
                    }
                    if !merged.contains_key("baseUrls") {
                        if let Some(v) = summary.get("baseUrls") {
                            merged.insert("baseUrls".to_string(), v.clone());
                        }
                    }
                    env = Value::Object(merged);
                }
            }
        }
        items.push(decorate_environment(&env, &project_servers));
    }
    Ok(json!({ "items": items }))
}

/* ===================== 诊断 ===================== */

fn diagnose(cfg: &ApifoxConfig) -> Result<Value, ApiErr> {
    let tree_diag = match i("GET", cfg, &format!("projects/{}/api-tree-list", cfg.project_id), &[], None) {
        Ok(raw) => {
            let nodes = normalize_internal_tree(&raw);
            fn count(ns: &[Value]) -> usize {
                ns.iter().map(|n| {
                    let self_n = if n.get("type").and_then(|x| x.as_str()) == Some("api") { 1 } else { 0 };
                    let kids = n.get("children").and_then(|x| x.as_array()).map(|a| count(a)).unwrap_or(0);
                    self_n + kids
                }).sum()
            }
            json!({ "source": "api-tree-list", "count": count(&nodes) })
        }
        Err(e) => json!({ "source": "api-tree-list", "count": 0, "error": e.text() }),
    };
    let list_diag = match list_all_http_apis(cfg) {
        Ok((apis, reported)) => {
            let mut groups: HashMap<String, Vec<String>> = HashMap::new();
            for a in &apis {
                let m = clean_str(a, &["method", "httpMethod", "requestMethod"]).to_uppercase();
                let p = clean_str(a, &["path", "url", "uri", "requestPath"]);
                let key = format!("{} {}", m, p);
                groups.entry(key).or_default().push(clean_str(a, &["name", "summary", "title"]));
            }
            let mut dup = Vec::new();
            for (k, names) in groups {
                if names.len() > 1 {
                    dup.push(format!("{}  ←  {}", k, names.join(" | ")));
                }
            }
            dup.sort();
            let mut d = json!({ "source": "internal-http-apis", "count": apis.len(), "total": reported });
            if !dup.is_empty() {
                d["duplicate"] = json!(dup);
            }
            d
        }
        Err(e) => json!({ "source": "internal-http-apis", "count": 0, "error": e.text() }),
    };
    let open_diag = match export_openapi_doc(cfg) {
        Ok(doc) => {
            let paths = doc.get("paths").and_then(|x| x.as_object());
            let mut count = 0usize;
            if let Some(ps) = paths {
                for (_, entry) in ps {
                    if let Some(eo) = entry.as_object() {
                        count += eo.keys().filter(|k| KNOWN_METHODS.contains(&k.to_lowercase().as_str())).count();
                    }
                }
            }
            json!({ "source": "openapi", "count": count })
        }
        Err(e) => json!({ "source": "openapi", "count": 0, "error": e.text() }),
    };
    let list_count = list_diag.get("count").and_then(|x| x.as_u64()).unwrap_or(0);
    let open_count = open_diag.get("count").and_then(|x| x.as_u64()).unwrap_or(0);
    let dup_len = list_diag.get("duplicate").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
    let conclusion = if open_count > list_count {
        format!(
            "内部接口列表只返回 {} 个（很可能只拿到第一页），OpenAPI 导出 {} 个 operation。拉取已自动改用 OpenAPI；注意方法+路径相同的接口会被合并。",
            list_count, open_count
        )
    } else if list_count > open_count && open_count > 0 {
        format!(
            "内部 API 共 {} 个接口，OpenAPI 导出仅 {} 个 operation（差 {} 个）。OpenAPI 的 paths[路径][方法] 只能有一个 operation，Apifox 里方法+路径相同的接口导出时会被合并，降级模式只能看到合并后的数量。重复 method+path 共 {} 组。",
            list_count, open_count, list_count - open_count, dup_len
        )
    } else {
        format!("内部 API 共 {} 个接口；OpenAPI 导出 {} 个 operation。", list_count, open_count)
    };
    Ok(json!({
        "internalTree": tree_diag,
        "internalList": list_diag,
        "openapi": open_diag,
        "conclusion": conclusion
    }))
}

/* ===================== RPC 入口 ===================== */

fn call_internal(cfg: &ApifoxConfig, method: &str, path: &str, query: &[(&str, String)], body: Option<&Value>) -> Result<Value, PluginError> {
    i(method, cfg, path, query, body).map(|v| unwrap_data(&v)).map_err(|e| e.plugin())
}

pub fn handle(method: &str, params: &Value, _emitter: &PluginEmitter) -> Option<Result<Value, PluginError>> {
    if !method.starts_with("apifox/") {
        return None;
    }
    let result = (|| -> Result<Value, PluginError> {
        match method {
            "apifox/test" | "apifox/ping" => {
                let cfg = config_from(params)?;
                match i("GET", &cfg, &format!("projects/{}/http-apis?pageSize=1", cfg.project_id), &[], None) {
                    Ok(_) => Ok(json!({ "success": true, "message": "Token 与项目 ID 已验证" })),
                    Err(e) => Ok(json!({
                        "success": false,
                        "message": format!("内部 API 验证失败：{}", e.text()),
                        "fallback": "Token 可能有效，但内部 API 不可用；实际操作时会自动尝试官方 OpenAPI。"
                    })),
                }
            }
            "apifox/getApiTree" => {
                let cfg = config_from(params)?;
                get_api_tree(&cfg).map_err(|e| e.plugin())
            }
            "apifox/getApi" => {
                let cfg = config_from(params)?;
                let id = clean_str(params, &["apiId"]);
                if id.is_empty() {
                    return Err(PluginError::new(-32602, "缺少 apiId"));
                }
                call_internal(&cfg, "GET", &format!("projects/{}/http-apis/{}", cfg.project_id, id), &[], None)
            }
            "apifox/listApis" => {
                let cfg = config_from(params)?;
                let size = clean_str(params, &["pageSize"]);
                let size = if size.is_empty() { "200".to_string() } else { size };
                let mut q = vec![("pageSize", size)];
                let kw = clean_str(params, &["keyword"]);
                if !kw.is_empty() {
                    q.push(("keyword", kw));
                }
                call_internal(&cfg, "GET", &format!("projects/{}/http-apis", cfg.project_id), &q, None)
            }
            "apifox/listFolders" => {
                let cfg = config_from(params)?;
                Ok(json!({ "items": list_folders_raw(&cfg).map_err(|e| e.plugin())? }))
            }
            "apifox/listEnvironments" => {
                let cfg = config_from(params)?;
                list_environments(&cfg).map_err(|e| e.plugin())
            }
            "apifox/exportOpenapi" => {
                let cfg = config_from(params)?;
                export_openapi_doc(&cfg).map_err(|e| e.plugin())
            }
            /* 只读插件：createApi/updateApi/deleteApi、环境增删改、importOpenapi
             * 已从分发中移除。这些写操作即使被 UI 误调用也会返回 method_not_found，
             * 从后端层面保证不会把本地改动写回 Apifox。 */
            "apifox/diagnoseSync" => {
                let cfg = config_from(params)?;
                diagnose(&cfg).map_err(|e| e.plugin())
            }
            _ => return Err(PluginError::method_not_found(method)),
        }
    })();
    Some(result)
}
