use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

// ── HTTP over UDS/TCP ─────────────────────────────────────────────────────────

impl SidecarHandle {
    async fn post(&self, path: &str, body: &str) -> anyhow::Result<String> {
        let header = format!(
            "POST {path} HTTP/1.1\r\n\
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

fn cli_binary_path(app: &AppHandle) -> anyhow::Result<PathBuf> {
    let name = format!("tessera-cli-{TARGET_TRIPLE}{EXE_EXT}");
    if cfg!(debug_assertions) {
        // Dev: binaries live in src-tauri/binaries/ next to Cargo.toml.
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        Ok(manifest.join("binaries").join(name))
    } else {
        Ok(app
            .path()
            .resource_dir()
            .context("Could not resolve resource dir")?
            .join(name))
    }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let cli_path = cli_binary_path(app.handle()).context("Could not resolve CLI binary path")?;

    let (mut rx, child) = app
        .shell()
        .sidecar("tessera-sidecar")
        .context("Could not create sidecar command")?
        .env("TESSERA_CLI_PATH", cli_path.to_string_lossy().as_ref())
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

// ── Entry point ───────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| setup(app))
        .invoke_handler(tauri::generate_handler![
            sidecar_ping,
            workflow_run,
            workflow_resume
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Tessera")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                kill_sidecar(app_handle);
            }
        });
}
