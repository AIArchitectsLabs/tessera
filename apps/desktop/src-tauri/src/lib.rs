use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

mod model_settings;

// Compile-time target triple injected by build.rs via `cargo:rustc-env`.
const TARGET_TRIPLE: &str = env!("TESSERA_TARGET_TRIPLE");
const EXE_EXT: &str = if cfg!(windows) { ".exe" } else { "" };

// ── Transport ────────────────────────────────────────────────────────────────

enum SidecarTransport {
    #[cfg(unix)]
    Unix(PathBuf),
    Tcp(u16),
}

pub struct SidecarHandle {
    transport: SidecarTransport,
    token: String,
}

// SAFETY: PathBuf + u16 + String are all Send+Sync.
unsafe impl Send for SidecarHandle {}
unsafe impl Sync for SidecarHandle {}

struct SidecarChild(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

struct TaskSubscriptions {
    handles: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}

impl Default for TaskSubscriptions {
    fn default() -> Self {
        Self {
            handles: Mutex::new(HashMap::new()),
        }
    }
}

pub struct SseStream {
    reader: Box<dyn AsyncBufRead + Unpin + Send>,
}

impl SseStream {
    async fn skip_headers(&mut self) -> anyhow::Result<()> {
        let mut line = String::new();
        loop {
            line.clear();
            let n = self.reader.read_line(&mut line).await?;
            if n == 0 {
                anyhow::bail!("SSE connection closed during header read");
            }
            if line == "\r\n" || line == "\n" {
                break;
            }
        }
        Ok(())
    }

    pub async fn next_event(&mut self) -> anyhow::Result<Option<String>> {
        let mut data_lines: Vec<String> = Vec::new();
        let mut line = String::new();
        loop {
            line.clear();
            let n = self.reader.read_line(&mut line).await?;
            if n == 0 {
                return Ok(None);
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                if !data_lines.is_empty() {
                    return Ok(Some(data_lines.join("\n")));
                }
                continue;
            }
            if let Some(data) = trimmed.strip_prefix("data: ") {
                data_lines.push(data.to_string());
            }
        }
    }
}

// ── HTTP over UDS/TCP ─────────────────────────────────────────────────────────

impl SidecarHandle {
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> anyhow::Result<String> {
        let body = body.unwrap_or("");
        let header = format!(
            "{method} {path} HTTP/1.1\r\n\
             Host: localhost\r\n\
             Authorization: Bearer {token}\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {len}\r\n\
             Connection: close\r\n\
             \r\n",
            token = self.token,
            len = body.len(),
        );

        let mut buf = Vec::new();
        match &self.transport {
            #[cfg(unix)]
            SidecarTransport::Unix(socket_path) => {
                let mut stream = tokio::net::UnixStream::connect(socket_path)
                    .await
                    .context("Could not connect to sidecar Unix socket")?;
                stream.write_all(header.as_bytes()).await?;
                stream.write_all(body.as_bytes()).await?;
                stream.read_to_end(&mut buf).await?;
            }
            SidecarTransport::Tcp(port) => {
                let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", *port))
                    .await
                    .context("Could not connect to sidecar TCP socket")?;
                stream.write_all(header.as_bytes()).await?;
                stream.write_all(body.as_bytes()).await?;
                stream.read_to_end(&mut buf).await?;
            }
        }

        let response = String::from_utf8(buf).context("Sidecar response is not valid UTF-8")?;
        let body_start = response
            .find("\r\n\r\n")
            .map(|i| i + 4)
            .context("Malformed HTTP response from sidecar")?;

        if !response.starts_with("HTTP/1.1 200") {
            let first_line = response.lines().next().unwrap_or("(empty)");
            bail!("Sidecar returned error: {first_line}");
        }

        Ok(response[body_start..].to_string())
    }

    async fn get(&self, path: &str) -> anyhow::Result<String> {
        self.request("GET", path, None).await
    }

    async fn post(&self, path: &str, body: &str) -> anyhow::Result<String> {
        self.request("POST", path, Some(body)).await
    }

    async fn request_stream(&self, method: &str, path: &str) -> anyhow::Result<SseStream> {
        let header = format!(
            "{method} {path} HTTP/1.1\r\n\
             Host: localhost\r\n\
             Authorization: Bearer {token}\r\n\
             Accept: text/event-stream\r\n\
             Content-Length: 0\r\n\
             \r\n",
            token = self.token,
        );

        let reader: Box<dyn AsyncBufRead + Unpin + Send> = match &self.transport {
            #[cfg(unix)]
            SidecarTransport::Unix(socket_path) => {
                let mut stream = tokio::net::UnixStream::connect(socket_path)
                    .await
                    .context("Could not connect to sidecar Unix socket")?;
                stream.write_all(header.as_bytes()).await?;
                Box::new(BufReader::new(stream))
            }
            SidecarTransport::Tcp(port) => {
                let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", *port))
                    .await
                    .context("Could not connect to sidecar TCP socket")?;
                stream.write_all(header.as_bytes()).await?;
                Box::new(BufReader::new(stream))
            }
        };

        let mut sse = SseStream { reader };
        sse.skip_headers().await?;
        Ok(sse)
    }
}

// ── Sidecar-ready wire format ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct SidecarReadyMsg {
    #[serde(rename = "type")]
    msg_type: String,
    transport: String,
    path: Option<String>,
    port: Option<u16>,
    token: String,
}

fn parse_ready(msg: SidecarReadyMsg) -> anyhow::Result<SidecarHandle> {
    match msg.transport.as_str() {
        #[cfg(unix)]
        "unix" => {
            let path = msg
                .path
                .ok_or_else(|| anyhow!("Missing path in unix ready message"))?;
            Ok(SidecarHandle {
                transport: SidecarTransport::Unix(PathBuf::from(path)),
                token: msg.token,
            })
        }
        "tcp" => {
            let port = msg
                .port
                .ok_or_else(|| anyhow!("Missing port in tcp ready message"))?;
            Ok(SidecarHandle {
                transport: SidecarTransport::Tcp(port),
                token: msg.token,
            })
        }
        other => bail!("Unknown sidecar transport: {other}"),
    }
}

// ── Path resolution ───────────────────────────────────────────────────────────

fn binaries_dir(app: &AppHandle) -> anyhow::Result<PathBuf> {
    if cfg!(debug_assertions) {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        Ok(manifest.join("binaries"))
    } else {
        app.path()
            .resource_dir()
            .context("Could not resolve resource dir")
    }
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn provider_config_json(provider: &model_settings::ProviderConfig) -> serde_json::Value {
    match provider.provider {
        model_settings::ModelProvider::Openai => serde_json::json!({
            "provider": "openai",
            "model": provider.model,
            "apiKeyEnv": "OPENAI_API_KEY"
        }),
        model_settings::ModelProvider::Anthropic => serde_json::json!({
            "provider": "anthropic",
            "model": provider.model,
            "apiKeyEnv": "ANTHROPIC_API_KEY"
        }),
        model_settings::ModelProvider::Openrouter => serde_json::json!({
            "provider": "openrouter",
            "model": provider.model,
            "apiKeyEnv": "OPENROUTER_API_KEY"
        }),
        model_settings::ModelProvider::Local => serde_json::json!({
            "provider": "local",
            "model": provider.model,
            "baseUrl": provider
                .base_url
                .clone()
                .unwrap_or_else(|| "http://127.0.0.1:11434/v1".to_string())
        }),
    }
}

fn model_connection_test_body(
    provider: &model_settings::ProviderConfig,
    credential: Option<String>,
) -> serde_json::Value {
    let provider_value = provider_config_json(provider);

    let mut body = serde_json::json!({
        "prompt": "Reply with OK.",
        "provider": provider_value,
        "timeoutMs": 30_000,
    });
    if let Some(api_key) = credential {
        body["credential"] = serde_json::json!({ "apiKey": api_key });
    }
    body
}

fn default_agent_profile_json() -> serde_json::Value {
    serde_json::json!({
        "id": "default",
        "name": "Tessera",
        "model": { "mode": "default" },
        "instructions": "You are Tessera's workspace agent. Work inside the selected workspace.",
        "soul": "",
        "skills": [],
        "tools": [
            "workspace_read",
            "workspace_list",
            "workspace_search",
            "workspace_write",
            "workspace_edit"
        ],
        "createdAt": "1970-01-01T00:00:00.000Z",
        "updatedAt": "1970-01-01T00:00:00.000Z"
    })
}

fn attach_default_task_execution(
    app: &AppHandle,
    mut request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if request.get("execution").is_some() {
        return Ok(request);
    }

    let settings_path = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join(model_settings::SETTINGS_FILE);
    let settings =
        model_settings::load_settings_file(&settings_path).map_err(|error| error.to_string())?;
    let provider =
        model_settings::selected_provider_config(&settings).map_err(|error| error.to_string())?;
    let credential =
        model_settings::get_credential(provider.provider).map_err(|error| error.to_string())?;

    if credential.is_none() && provider.provider != model_settings::ModelProvider::Local {
        return Err(format!(
            "{} is not configured. Add an API key in Settings > Model.",
            provider.provider.label()
        ));
    }

    let mut execution = serde_json::json!({
        "agent": default_agent_profile_json(),
        "provider": provider_config_json(&provider)
    });

    if let Some(api_key) = credential {
        execution["credential"] = serde_json::json!({ "apiKey": api_key });
    }

    request["execution"] = execution;
    Ok(request)
}

// ── Setup ─────────────────────────────────────────────────────────────────────

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let bin_dir = binaries_dir(app.handle()).context("Could not resolve binaries dir")?;
    let cli_path = bin_dir.join(format!("tessera-cli-{TARGET_TRIPLE}{EXE_EXT}"));
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("Could not resolve app data dir")?;
    fs::create_dir_all(&app_data_dir).context("Could not create app data dir")?;
    let workflow_db_path = app_data_dir.join("workflow-runs.sqlite");
    let task_db_path = app_data_dir.join("tasks.sqlite");

    let (mut rx, child) = app
        .shell()
        .sidecar("tessera-sidecar")
        .context("Could not create sidecar command")?
        .env("TESSERA_CLI_PATH", cli_path.to_string_lossy().as_ref())
        .env(
            "TESSERA_WORKFLOW_DB_PATH",
            workflow_db_path.to_string_lossy().as_ref(),
        )
        .env(
            "TESSERA_TASK_DB_PATH",
            task_db_path.to_string_lossy().as_ref(),
        )
        // pi-coding-agent resolves its package dir via dirname(process.execPath) when
        // running as a compiled Bun binary, but Tauri copies the sidecar to target/debug/.
        // Point it at binaries/ where package.json is kept alongside the sources.
        .env("PI_PACKAGE_DIR", bin_dir.to_string_lossy().as_ref())
        .spawn()
        .context("Could not spawn sidecar")?;

    // Block until the sidecar emits its ready JSON line (10 s timeout).
    let handle = tauri::async_runtime::block_on(async {
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(event) = rx.recv().await {
                if let CommandEvent::Stdout(line) = event {
                    let text = String::from_utf8_lossy(&line);
                    if let Ok(msg) = serde_json::from_str::<SidecarReadyMsg>(text.trim()) {
                        if msg.msg_type == "ready" {
                            return parse_ready(msg);
                        }
                    }
                }
            }
            bail!("Sidecar channel closed before sending ready message")
        })
        .await
        .unwrap_or_else(|_| bail!("Sidecar startup timed out after 10 s"))
    })?;

    app.manage(handle);
    app.manage(SidecarChild(Mutex::new(Some(child))));
    app.manage(TaskSubscriptions::default());

    Ok(())
}

fn kill_sidecar(app: &AppHandle) {
    if let Some(state) = app.try_state::<SidecarChild>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

// ── Tauri command ─────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    signal: Option<String>,
    duration_ms: u64,
}

#[tauri::command]
async fn sidecar_ping(state: State<'_, SidecarHandle>) -> Result<SpawnResult, String> {
    let body = r#"{"binary":"workspace-cli","args":["ping"]}"#;
    let json = state
        .post("/spawn", body)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn workflow_run(
    state: State<'_, SidecarHandle>,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "workflowId": "demo.write-approval",
        "input": input,
    })
    .to_string();
    let json = state
        .post("/workflows/run", &body)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn workflow_list_pending(
    state: State<'_, SidecarHandle>,
) -> Result<serde_json::Value, String> {
    let json = state
        .get("/workflows/runs?status=blocked")
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn workflow_resume(
    state: State<'_, SidecarHandle>,
    run_id: String,
    decision: String,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "runId": &run_id,
        "decision": decision,
    })
    .to_string();
    let path = format!("/workflows/{run_id}/resume");
    let json = state.post(&path, &body).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn task_list(
    state: State<'_, SidecarHandle>,
    workspace_root: String,
) -> Result<serde_json::Value, String> {
    let path = format!("/tasks?workspaceRoot={}", percent_encode(&workspace_root));
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn task_create(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request = attach_default_task_execution(&app, request)?;
    let json = state
        .post("/tasks", &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn task_get(
    state: State<'_, SidecarHandle>,
    task_id: String,
) -> Result<serde_json::Value, String> {
    let path = format!("/tasks/{}", percent_encode(&task_id));
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn task_update(
    state: State<'_, SidecarHandle>,
    task_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let path = format!("/tasks/{}", percent_encode(&task_id));
    let json = state
        .request("PATCH", &path, Some(&request.to_string()))
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn task_create_turn(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    task_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request = attach_default_task_execution(&app, request)?;
    let path = format!("/tasks/{}/turns", percent_encode(&task_id));
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn model_settings_get(app: AppHandle) -> Result<model_settings::ModelSettingsRead, String> {
    model_settings::read(&app).map_err(|error| error.to_string())
}

#[tauri::command]
async fn model_settings_save(
    app: AppHandle,
    request: model_settings::ModelSettingsSaveRequest,
) -> Result<model_settings::ModelSettingsRead, String> {
    model_settings::save(&app, request).map_err(|error| error.to_string())
}

#[tauri::command]
async fn model_credential_delete(
    app: AppHandle,
    request: model_settings::ModelCredentialDeleteRequest,
) -> Result<model_settings::ModelSettingsRead, String> {
    model_settings::delete(&app, request).map_err(|error| error.to_string())
}

#[tauri::command]
async fn model_connection_test(
    state: State<'_, SidecarHandle>,
    request: model_settings::ModelConnectionTestRequest,
) -> Result<model_settings::ModelConnectionTestResult, String> {
    let provider =
        model_settings::validate_provider_config(&request.provider).map_err(|e| e.to_string())?;
    let credential = match request.credential {
        Some(input) => {
            let api_key = input.api_key.trim();
            (!api_key.is_empty()).then(|| api_key.to_string())
        }
        None => {
            model_settings::get_credential(provider.provider).map_err(|error| error.to_string())?
        }
    };

    if credential.is_none() && provider.provider != model_settings::ModelProvider::Local {
        return Ok(model_settings::missing_credential_result(provider.provider));
    }

    let body = model_connection_test_body(&provider, credential).to_string();
    let json = tokio::time::timeout(Duration::from_secs(20), state.post("/agent/turn", &body))
        .await
        .map_err(|_| "Connection test timed out after 20s".to_string())?
        .map_err(|error| error.to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(&json).map_err(|error| error.to_string())?;
    let ok = value.get("status").and_then(|status| status.as_str()) == Some("completed");

    let message = if ok {
        "Connection test succeeded".to_string()
    } else {
        value
            .get("error")
            .and_then(|error| error.as_str())
            .or_else(|| {
                value
                    .get("messages")
                    .and_then(|messages| messages.as_array())
                    .and_then(|messages| messages.last())
                    .and_then(|message| message.get("text"))
                    .and_then(|text| text.as_str())
            })
            .unwrap_or("Connection test failed")
            .to_string()
    };

    Ok(model_settings::ModelConnectionTestResult { ok, message })
}

#[tauri::command]
async fn task_subscribe(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    subs: State<'_, TaskSubscriptions>,
    task_id: String,
) -> Result<(), String> {
    {
        let map = subs.handles.lock().unwrap();
        if map.contains_key(&task_id) {
            return Ok(());
        }
    }

    let _ = state;
    let id = task_id.clone();

    let join = {
        let app_for_task = app.clone();
        let id_for_task = id.clone();
        tokio::spawn(async move {
            let handle = app_for_task.state::<SidecarHandle>();
            let path = format!("/tasks/{}/events", percent_encode(&id_for_task));
            let mut stream = match handle.request_stream("GET", &path).await {
                Ok(s) => s,
                Err(e) => {
                    if let Some(s) = app_for_task.try_state::<TaskSubscriptions>() {
                        s.handles.lock().unwrap().remove(&id_for_task);
                    }
                    let _ = app_for_task
                        .emit(&format!("task:event:{}:closed", id_for_task), e.to_string());
                    return;
                }
            };
            loop {
                match stream.next_event().await {
                    Ok(Some(payload)) => {
                        let _ = app_for_task
                            .emit(&format!("task:event:{}", id_for_task), payload);
                    }
                    _ => break,
                }
            }
            if let Some(s) = app_for_task.try_state::<TaskSubscriptions>() {
                s.handles.lock().unwrap().remove(&id_for_task);
            }
            let _ = app_for_task
                .emit(&format!("task:event:{}:closed", id_for_task), ());
        })
    };

    subs.handles.lock().unwrap().insert(task_id, join);
    Ok(())
}

#[tauri::command]
async fn task_unsubscribe(
    subs: State<'_, TaskSubscriptions>,
    task_id: String,
) -> Result<(), String> {
    if let Some(handle) = subs.handles.lock().unwrap().remove(&task_id) {
        handle.abort();
    }
    Ok(())
}

// ── Agent Profiles ─────────────────────────────────────────────────────────────

#[tauri::command]
async fn agent_profile_list(
    state: State<'_, SidecarHandle>,
) -> Result<serde_json::Value, String> {
    let json = state.get("/agent-profiles").await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn agent_profile_get(
    state: State<'_, SidecarHandle>,
    id: String,
) -> Result<serde_json::Value, String> {
    let path = format!("/agent-profiles/{}", percent_encode(&id));
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn agent_profile_create(
    state: State<'_, SidecarHandle>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let json = state
        .post("/agent-profiles", &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn agent_profile_update(
    state: State<'_, SidecarHandle>,
    id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let path = format!("/agent-profiles/{}", percent_encode(&id));
    let json = state
        .request("PATCH", &path, Some(&request.to_string()))
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn agent_profile_delete(
    state: State<'_, SidecarHandle>,
    id: String,
) -> Result<serde_json::Value, String> {
    let path = format!("/agent-profiles/{}", percent_encode(&id));
    let json = state
        .request("DELETE", &path, None)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

// ── Entry point ───────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| setup(app))
        .invoke_handler(tauri::generate_handler![
            agent_profile_list,
            agent_profile_get,
            agent_profile_create,
            agent_profile_update,
            agent_profile_delete,
            model_connection_test,
            model_credential_delete,
            model_settings_get,
            model_settings_save,
            sidecar_ping,
            task_create,
            task_create_turn,
            task_get,
            task_list,
            task_subscribe,
            task_unsubscribe,
            task_update,
            workflow_list_pending,
            workflow_run,
            workflow_resume
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Tessera")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(subs) = app_handle.try_state::<TaskSubscriptions>() {
                    let handles: Vec<_> = subs
                        .handles
                        .lock()
                        .unwrap()
                        .drain()
                        .map(|(_, h)| h)
                        .collect();
                    for h in handles {
                        h.abort();
                    }
                }
                kill_sidecar(app_handle);
            }
        });
}
