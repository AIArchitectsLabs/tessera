use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

mod integration_settings;
mod model_settings;

// Compile-time target triple injected by build.rs via `cargo:rustc-env`.
const TARGET_TRIPLE: &str = env!("TESSERA_TARGET_TRIPLE");
const EXE_EXT: &str = if cfg!(windows) { ".exe" } else { "" };
const GOOGLE_WORKSPACE_OAUTH_CLIENT_ID_ENV: &str = "TESSERA_GOOGLE_WORKSPACE_CLIENT_ID";
const GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET_ENV: &str = "TESSERA_GOOGLE_WORKSPACE_CLIENT_SECRET";
const GOOGLE_WORKSPACE_OAUTH_CLIENT_FILE_ENV: &str = "TESSERA_GOOGLE_WORKSPACE_OAUTH_CLIENT_FILE";
const GOOGLE_WORKSPACE_BUNDLED_OAUTH_CLIENT_FILE: &str = "google-workspace-oauth-client.json";
const GOOGLE_WORKSPACE_GWS_CLIENT_SECRET_FILE: &str = "client_secret.json";
const GOOGLE_WORKSPACE_DEFAULT_PROJECT_ID: &str = "tessera";
const GOOGLE_WORKSPACE_AUTH_SCOPES: &str = concat!(
    "https://www.googleapis.com/auth/calendar.readonly,",
    "https://www.googleapis.com/auth/gmail.readonly,",
    "https://www.googleapis.com/auth/gmail.compose,",
    "https://www.googleapis.com/auth/drive.readonly,",
    "https://www.googleapis.com/auth/contacts.readonly,",
    "https://www.googleapis.com/auth/documents.readonly,",
    "https://www.googleapis.com/auth/documents,",
    "https://www.googleapis.com/auth/spreadsheets"
);
const GWS_CLI_URL_ENV: &str = "TESSERA_GWS_CLI_URL";
const GWS_CLI_SHA256_ENV: &str = "TESSERA_GWS_CLI_SHA256";
const GWS_CLI_VERSION_ENV: &str = "TESSERA_GWS_CLI_VERSION";
const GWS_CLI_SIZE_BYTES_ENV: &str = "TESSERA_GWS_CLI_SIZE_BYTES";
const PDF_RENDER_URL_ENV: &str = "TESSERA_PDF_RENDER_URL";
const PDF_RENDER_SHA256_ENV: &str = "TESSERA_PDF_RENDER_SHA256";
const PDF_RENDER_VERSION_ENV: &str = "TESSERA_PDF_RENDER_VERSION";
const PDF_RENDER_SIZE_BYTES_ENV: &str = "TESSERA_PDF_RENDER_SIZE_BYTES";
const PDF_RENDER_ARCHIVE_KIND_ENV: &str = "TESSERA_PDF_RENDER_ARCHIVE_KIND";
const PDF_RENDER_ARCHIVE_ENTRY_ENV: &str = "TESSERA_PDF_RENDER_ARCHIVE_ENTRY";
const PDF_TRANSFORM_URL_ENV: &str = "TESSERA_PDF_TRANSFORM_URL";
const PDF_TRANSFORM_SHA256_ENV: &str = "TESSERA_PDF_TRANSFORM_SHA256";
const PDF_TRANSFORM_VERSION_ENV: &str = "TESSERA_PDF_TRANSFORM_VERSION";
const PDF_TRANSFORM_SIZE_BYTES_ENV: &str = "TESSERA_PDF_TRANSFORM_SIZE_BYTES";
const PDF_TRANSFORM_ARCHIVE_KIND_ENV: &str = "TESSERA_PDF_TRANSFORM_ARCHIVE_KIND";
const PDF_TRANSFORM_ARCHIVE_ENTRY_ENV: &str = "TESSERA_PDF_TRANSFORM_ARCHIVE_ENTRY";
const PYTHON_RUNNER_URL_ENV: &str = "TESSERA_PYTHON_RUNNER_URL";
const PYTHON_RUNNER_SHA256_ENV: &str = "TESSERA_PYTHON_RUNNER_SHA256";
const PYTHON_RUNNER_VERSION_ENV: &str = "TESSERA_PYTHON_RUNNER_VERSION";
const PYTHON_RUNNER_SIZE_BYTES_ENV: &str = "TESSERA_PYTHON_RUNNER_SIZE_BYTES";
const PYTHON_RUNNER_ARCHIVE_KIND_ENV: &str = "TESSERA_PYTHON_RUNNER_ARCHIVE_KIND";
const PYTHON_RUNNER_ARCHIVE_ENTRY_ENV: &str = "TESSERA_PYTHON_RUNNER_ARCHIVE_ENTRY";
const BROWSER_RUNTIME_URL_ENV: &str = "TESSERA_BROWSER_RUNTIME_URL";
const BROWSER_RUNTIME_SHA256_ENV: &str = "TESSERA_BROWSER_RUNTIME_SHA256";
const BROWSER_RUNTIME_VERSION_ENV: &str = "TESSERA_BROWSER_RUNTIME_VERSION";
const BROWSER_RUNTIME_SIZE_BYTES_ENV: &str = "TESSERA_BROWSER_RUNTIME_SIZE_BYTES";
const BROWSER_RUNTIME_ARCHIVE_KIND_ENV: &str = "TESSERA_BROWSER_RUNTIME_ARCHIVE_KIND";
const BROWSER_RUNTIME_ARCHIVE_ENTRY_ENV: &str = "TESSERA_BROWSER_RUNTIME_ARCHIVE_ENTRY";
const BROWSER_RUNTIME_ARCHIVE_ROOT_ENV: &str = "TESSERA_BROWSER_RUNTIME_ARCHIVE_ROOT";

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
            let body = response[body_start..].trim();
            let detail = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|value| {
                    value
                        .get("error")
                        .and_then(|error| error.as_str())
                        .map(|error| error.to_string())
                })
                .filter(|error| !error.trim().is_empty())
                .unwrap_or_else(|| first_line.to_string());
            bail!("Sidecar returned error: {detail}");
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

fn external_bin_path(app: &AppHandle, name: &str) -> anyhow::Result<PathBuf> {
    if cfg!(debug_assertions) {
        Ok(binaries_dir(app)?.join(format!("{name}-{TARGET_TRIPLE}{EXE_EXT}")))
    } else {
        let executable = std::env::current_exe().context("Could not resolve current executable")?;
        let executable_dir = executable
            .parent()
            .ok_or_else(|| anyhow!("Current executable has no parent directory"))?;
        Ok(executable_dir.join(format!("{name}{EXE_EXT}")))
    }
}

fn bundled_gws_path(app: &AppHandle) -> anyhow::Result<PathBuf> {
    Ok(binaries_dir(app)?.join(format!("gws-{TARGET_TRIPLE}{EXE_EXT}")))
}

async fn managed_capability_binary_status(
    state: &SidecarHandle,
    capability_id: &str,
    binary_name: &str,
) -> anyhow::Result<CapabilityBinaryResult> {
    let path = format!(
        "/capabilities/{}/binaries/{}",
        percent_encode(capability_id),
        percent_encode(binary_name)
    );
    let json = state.get(&path).await?;
    serde_json::from_str(&json).map_err(Into::into)
}

async fn managed_capability_binary_install(
    state: &SidecarHandle,
    capability_id: &str,
    binary_name: &str,
) -> anyhow::Result<CapabilityBinaryResult> {
    let path = format!(
        "/capabilities/{}/binaries/{}/install",
        percent_encode(capability_id),
        percent_encode(binary_name)
    );
    let json = state.post(&path, "{}").await?;
    serde_json::from_str(&json).map_err(Into::into)
}

async fn managed_capability_binary_path(
    state: &SidecarHandle,
    capability_id: &str,
    binary_name: &str,
) -> anyhow::Result<Option<PathBuf>> {
    let result = managed_capability_binary_status(state, capability_id, binary_name).await?;
    Ok(result.path.map(PathBuf::from))
}

async fn google_workspace_cli_path(
    app: &AppHandle,
    state: &SidecarHandle,
) -> Result<PathBuf, String> {
    let bundled = bundled_gws_path(app).map_err(|error| error.to_string())?;
    resolve_google_workspace_cli_path(
        Some(&bundled),
        || async { managed_capability_binary_path(state, "google-workspace-cli", "gws").await },
        || async { managed_capability_binary_install(state, "google-workspace-cli", "gws").await },
    )
    .await
}

async fn resolve_google_workspace_cli_path<S, I, SFut, IFut>(
    bundled: Option<&Path>,
    sidecar_get: S,
    sidecar_install: I,
) -> Result<PathBuf, String>
where
    S: FnOnce() -> SFut,
    SFut: Future<Output = anyhow::Result<Option<PathBuf>>>,
    I: FnOnce() -> IFut,
    IFut: Future<Output = anyhow::Result<CapabilityBinaryResult>>,
{
    if let Ok(Some(path)) = sidecar_get().await {
        return Ok(path);
    }

    if let Some(bundled) = bundled {
        if bundled.exists() {
            return Ok(bundled.to_path_buf());
        }
    }

    if let Some(path) = sidecar_install()
        .await
        .map_err(|error| error.to_string())?
        .path
    {
        return Ok(PathBuf::from(path));
    }

    Ok(PathBuf::from(if cfg!(windows) { "gws.exe" } else { "gws" }))
}

fn bundled_google_workspace_oauth_client_path(app: &AppHandle) -> anyhow::Result<PathBuf> {
    Ok(binaries_dir(app)?.join(GOOGLE_WORKSPACE_BUNDLED_OAUTH_CLIENT_FILE))
}

fn google_workspace_config_dir(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join("google-workspace")
}

fn google_workspace_gws_client_secret_path(config_dir: &Path) -> PathBuf {
    config_dir.join(GOOGLE_WORKSPACE_GWS_CLIENT_SECRET_FILE)
}

fn google_workspace_auth_log_path(config_dir: &Path) -> PathBuf {
    config_dir.join("auth-login.log")
}

fn google_workspace_oauth_client_id() -> Option<String> {
    runtime_or_build_env(
        GOOGLE_WORKSPACE_OAUTH_CLIENT_ID_ENV,
        option_env!("TESSERA_GOOGLE_WORKSPACE_CLIENT_ID"),
    )
}

fn google_workspace_oauth_client_secret() -> Option<String> {
    runtime_or_build_env(
        GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET_ENV,
        option_env!("TESSERA_GOOGLE_WORKSPACE_CLIENT_SECRET"),
    )
}

fn google_workspace_oauth_client_file() -> Option<PathBuf> {
    runtime_or_build_env(
        GOOGLE_WORKSPACE_OAUTH_CLIENT_FILE_ENV,
        option_env!("TESSERA_GOOGLE_WORKSPACE_OAUTH_CLIENT_FILE"),
    )
    .map(PathBuf::from)
}

fn google_workspace_oauth_client_env_configured() -> bool {
    google_workspace_oauth_client_id().is_some() && google_workspace_oauth_client_secret().is_some()
}

fn google_workspace_saved_oauth_client_values(config_dir: &Path) -> Option<(String, String)> {
    let path = google_workspace_gws_client_secret_path(config_dir);
    let value = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())?;
    let installed = value.get("installed")?;
    let client_id = installed.get("client_id")?.as_str()?.trim().to_string();
    let client_secret = installed.get("client_secret")?.as_str()?.trim().to_string();
    if client_id.is_empty() || client_secret.is_empty() {
        return None;
    }
    Some((client_id, client_secret))
}

fn runtime_or_build_env(name: &str, build_value: Option<&str>) -> Option<String> {
    std::env::var(name)
        .ok()
        .or_else(|| build_value.map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn copy_google_workspace_oauth_client_if_needed(
    source: &Path,
    destination: &Path,
) -> anyhow::Result<()> {
    if destination.exists() {
        let existing = fs::read(destination)
            .with_context(|| format!("Could not read {}", destination.display()))?;
        let incoming =
            fs::read(source).with_context(|| format!("Could not read {}", source.display()))?;
        if existing == incoming {
            return Ok(());
        }
    }
    fs::copy(source, destination).with_context(|| {
        format!(
            "Could not install Google Workspace OAuth client from {} to {}",
            source.display(),
            destination.display()
        )
    })?;
    Ok(())
}

fn normalize_google_workspace_oauth_client_file(path: &Path) -> anyhow::Result<()> {
    if !path.exists() {
        return Ok(());
    }

    let text =
        fs::read_to_string(path).with_context(|| format!("Could not read {}", path.display()))?;
    let text_without_bom = text.trim_start_matches('\u{feff}');
    let had_bom = text_without_bom.len() != text.len();
    let mut value: serde_json::Value = serde_json::from_str(text_without_bom)
        .with_context(|| format!("Could not parse {}", path.display()))?;
    let Some(installed) = value
        .get_mut("installed")
        .and_then(|value| value.as_object_mut())
    else {
        return Ok(());
    };
    if installed.contains_key("project_id") && !had_bom {
        return Ok(());
    }

    installed
        .entry("project_id".to_string())
        .or_insert_with(|| {
            serde_json::Value::String(GOOGLE_WORKSPACE_DEFAULT_PROJECT_ID.to_string())
        });
    let mut bytes = serde_json::to_vec_pretty(&value)?;
    bytes.push(b'\n');
    fs::write(path, bytes).with_context(|| format!("Could not update {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("Could not secure {}", path.display()))?;
    }
    Ok(())
}

fn install_google_workspace_oauth_client_file(
    app: &AppHandle,
    config_dir: &Path,
) -> anyhow::Result<bool> {
    if google_workspace_oauth_client_env_configured() {
        return Ok(true);
    }

    let destination = google_workspace_gws_client_secret_path(config_dir);
    if let Some(explicit_file) = google_workspace_oauth_client_file() {
        if !explicit_file.exists() {
            bail!(
                "{} points to a missing Google Workspace OAuth client file: {}",
                GOOGLE_WORKSPACE_OAUTH_CLIENT_FILE_ENV,
                explicit_file.display()
            );
        }
        copy_google_workspace_oauth_client_if_needed(&explicit_file, &destination)?;
        normalize_google_workspace_oauth_client_file(&destination)?;
        return Ok(true);
    }

    if destination.exists() {
        normalize_google_workspace_oauth_client_file(&destination)?;
        return Ok(true);
    }

    let bundled_file = bundled_google_workspace_oauth_client_path(app)?;
    if bundled_file.exists() {
        copy_google_workspace_oauth_client_if_needed(&bundled_file, &destination)?;
        normalize_google_workspace_oauth_client_file(&destination)?;
        return Ok(true);
    }

    Ok(false)
}

fn google_workspace_oauth_missing_message() -> String {
    format!(
        "Google Workspace OAuth client is not bundled for this build. Provide {} and {} at build time, or bundle {}.",
        GOOGLE_WORKSPACE_OAUTH_CLIENT_ID_ENV,
        GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET_ENV,
        GOOGLE_WORKSPACE_BUNDLED_OAUTH_CLIENT_FILE
    )
}

fn apply_google_workspace_env(
    command: &mut std::process::Command,
    gws_path: &Path,
    config_dir: &Path,
) {
    command.env("TESSERA_GWS_CLI_PATH", gws_path.to_string_lossy().as_ref());
    command.env(
        "TESSERA_GWS_CONFIG_DIR",
        config_dir.to_string_lossy().as_ref(),
    );
    command.env(
        "GOOGLE_WORKSPACE_CLI_CONFIG_DIR",
        config_dir.to_string_lossy().as_ref(),
    );
    if let Some(client_id) = google_workspace_oauth_client_id() {
        command.env("GOOGLE_WORKSPACE_CLI_CLIENT_ID", client_id);
        if let Some(client_secret) = google_workspace_oauth_client_secret() {
            command.env("GOOGLE_WORKSPACE_CLI_CLIENT_SECRET", client_secret);
        }
    } else if let Some((client_id, client_secret)) =
        google_workspace_saved_oauth_client_values(config_dir)
    {
        command.env("GOOGLE_WORKSPACE_CLI_CLIENT_ID", client_id);
        command.env("GOOGLE_WORKSPACE_CLI_CLIENT_SECRET", client_secret);
    }
}

fn workspace_cli_uses_google_workspace(args: &[&str]) -> bool {
    matches!(
        args.first().copied(),
        Some("calendar")
            | Some("contacts")
            | Some("docs")
            | Some("drive")
            | Some("gcal")
            | Some("gmail")
            | Some("mail")
            | Some("people")
            | Some("sheets")
    )
}

fn first_useful_process_line(result: &SpawnResult) -> String {
    result
        .stderr
        .lines()
        .chain(result.stdout.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Command failed")
        .to_string()
}

fn json_object_from_process_output(output: &str) -> Option<serde_json::Value> {
    let start = output.find('{')?;
    let end = output.rfind('}')?;
    serde_json::from_str(&output[start..=end]).ok()
}

fn fnv1a64_hex(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn google_workspace_credentials_path(config_dir: &Path) -> PathBuf {
    config_dir.join("credentials.enc")
}

fn google_account_email_from_output(output: &str) -> Option<String> {
    json_object_from_process_output(output).and_then(|value| {
        value
            .get("account")
            .or_else(|| value.get("user"))
            .or_else(|| value.get("email"))
            .and_then(|account| account.as_str())
            .map(str::trim)
            .filter(|account| !account.is_empty() && *account != "(unknown)")
            .map(str::to_string)
    })
}

fn google_authenticated_user_from_outputs(
    config_dir: &Path,
    outputs: &[&SpawnResult],
) -> Option<integration_settings::AuthenticatedUser> {
    for output in outputs {
        let combined = format!("{}\n{}", output.stderr, output.stdout);
        if let Some(email) = google_account_email_from_output(&combined) {
            let normalized = email.to_lowercase();
            return Some(integration_settings::AuthenticatedUser {
                user_key: format!("google-{}", fnv1a64_hex(normalized.as_bytes())),
                email: Some(email),
            });
        }
    }

    let credential_bytes = fs::read(google_workspace_credentials_path(config_dir)).ok()?;
    Some(integration_settings::AuthenticatedUser {
        user_key: format!("google-{}", fnv1a64_hex(&credential_bytes)),
        email: None,
    })
}

fn google_workspace_auth_status_connected(result: &SpawnResult) -> bool {
    json_object_from_process_output(&format!("{}\n{}", result.stderr, result.stdout))
        .and_then(|value| {
            value
                .get("auth_method")
                .and_then(|auth_method| auth_method.as_str())
                .map(|auth_method| auth_method != "none")
        })
        .unwrap_or(false)
}

fn google_workspace_process_message(result: &SpawnResult) -> String {
    let combined = format!("{}\n{}", result.stderr, result.stdout);
    if let Some(message) = json_object_from_process_output(&combined)
        .and_then(|value| value.get("error").cloned())
        .and_then(|error| error.get("message").cloned())
        .and_then(|message| message.as_str().map(str::to_string))
    {
        if message.contains("dns error") || message.contains("failed to lookup address") {
            return "Google API could not be reached. Check your internet connection.".to_string();
        }
        if message.contains("Access denied") || message.contains("No credentials") {
            return "Google sign-in needs to be refreshed.".to_string();
        }
        return message
            .lines()
            .next()
            .unwrap_or("Connection test failed")
            .to_string();
    }

    combined
        .lines()
        .map(str::trim)
        .find(|line| {
            !line.is_empty()
                && !line.starts_with("Using keyring backend")
                && !line.starts_with("Warning:")
        })
        .unwrap_or("Connection test failed")
        .to_string()
}

fn extract_google_oauth_url(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|part| {
        let candidate = part.trim_matches(|ch: char| {
            matches!(
                ch,
                '"' | '\'' | '<' | '>' | '(' | ')' | '[' | ']' | ',' | '.'
            )
        });
        (candidate.starts_with("https://accounts.google.com/") && candidate.contains("/o/oauth"))
            .then(|| candidate.to_string())
    })
}

fn optional_capability_env_sources() -> [(&'static str, Option<&'static str>); 29] {
    [
        (GWS_CLI_URL_ENV, option_env!("TESSERA_GWS_CLI_URL")),
        (GWS_CLI_SHA256_ENV, option_env!("TESSERA_GWS_CLI_SHA256")),
        (GWS_CLI_VERSION_ENV, option_env!("TESSERA_GWS_CLI_VERSION")),
        (
            GWS_CLI_SIZE_BYTES_ENV,
            option_env!("TESSERA_GWS_CLI_SIZE_BYTES"),
        ),
        (PDF_RENDER_URL_ENV, option_env!("TESSERA_PDF_RENDER_URL")),
        (
            PDF_RENDER_SHA256_ENV,
            option_env!("TESSERA_PDF_RENDER_SHA256"),
        ),
        (
            PDF_RENDER_VERSION_ENV,
            option_env!("TESSERA_PDF_RENDER_VERSION"),
        ),
        (
            PDF_RENDER_SIZE_BYTES_ENV,
            option_env!("TESSERA_PDF_RENDER_SIZE_BYTES"),
        ),
        (
            PDF_RENDER_ARCHIVE_KIND_ENV,
            option_env!("TESSERA_PDF_RENDER_ARCHIVE_KIND"),
        ),
        (
            PDF_RENDER_ARCHIVE_ENTRY_ENV,
            option_env!("TESSERA_PDF_RENDER_ARCHIVE_ENTRY"),
        ),
        (
            PDF_TRANSFORM_URL_ENV,
            option_env!("TESSERA_PDF_TRANSFORM_URL"),
        ),
        (
            PDF_TRANSFORM_SHA256_ENV,
            option_env!("TESSERA_PDF_TRANSFORM_SHA256"),
        ),
        (
            PDF_TRANSFORM_VERSION_ENV,
            option_env!("TESSERA_PDF_TRANSFORM_VERSION"),
        ),
        (
            PDF_TRANSFORM_SIZE_BYTES_ENV,
            option_env!("TESSERA_PDF_TRANSFORM_SIZE_BYTES"),
        ),
        (
            PDF_TRANSFORM_ARCHIVE_KIND_ENV,
            option_env!("TESSERA_PDF_TRANSFORM_ARCHIVE_KIND"),
        ),
        (
            PDF_TRANSFORM_ARCHIVE_ENTRY_ENV,
            option_env!("TESSERA_PDF_TRANSFORM_ARCHIVE_ENTRY"),
        ),
        (
            PYTHON_RUNNER_URL_ENV,
            option_env!("TESSERA_PYTHON_RUNNER_URL"),
        ),
        (
            PYTHON_RUNNER_SHA256_ENV,
            option_env!("TESSERA_PYTHON_RUNNER_SHA256"),
        ),
        (
            PYTHON_RUNNER_VERSION_ENV,
            option_env!("TESSERA_PYTHON_RUNNER_VERSION"),
        ),
        (
            PYTHON_RUNNER_SIZE_BYTES_ENV,
            option_env!("TESSERA_PYTHON_RUNNER_SIZE_BYTES"),
        ),
        (
            PYTHON_RUNNER_ARCHIVE_KIND_ENV,
            option_env!("TESSERA_PYTHON_RUNNER_ARCHIVE_KIND"),
        ),
        (
            PYTHON_RUNNER_ARCHIVE_ENTRY_ENV,
            option_env!("TESSERA_PYTHON_RUNNER_ARCHIVE_ENTRY"),
        ),
        (
            BROWSER_RUNTIME_URL_ENV,
            option_env!("TESSERA_BROWSER_RUNTIME_URL"),
        ),
        (
            BROWSER_RUNTIME_SHA256_ENV,
            option_env!("TESSERA_BROWSER_RUNTIME_SHA256"),
        ),
        (
            BROWSER_RUNTIME_VERSION_ENV,
            option_env!("TESSERA_BROWSER_RUNTIME_VERSION"),
        ),
        (
            BROWSER_RUNTIME_SIZE_BYTES_ENV,
            option_env!("TESSERA_BROWSER_RUNTIME_SIZE_BYTES"),
        ),
        (
            BROWSER_RUNTIME_ARCHIVE_KIND_ENV,
            option_env!("TESSERA_BROWSER_RUNTIME_ARCHIVE_KIND"),
        ),
        (
            BROWSER_RUNTIME_ARCHIVE_ENTRY_ENV,
            option_env!("TESSERA_BROWSER_RUNTIME_ARCHIVE_ENTRY"),
        ),
        (
            BROWSER_RUNTIME_ARCHIVE_ROOT_ENV,
            option_env!("TESSERA_BROWSER_RUNTIME_ARCHIVE_ROOT"),
        ),
    ]
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

fn scoped_command_user_key(user_key: Option<&str>) -> Result<Option<&str>, String> {
    user_key
        .map(model_settings::validate_user_key)
        .transpose()
        .map_err(|error| error.to_string())
}

fn push_user_key_param(params: &mut Vec<String>, user_key: Option<&str>) -> Result<(), String> {
    if let Some(user_key) = scoped_command_user_key(user_key)? {
        params.push(format!("userKey={}", percent_encode(user_key)));
    }
    Ok(())
}

fn push_workspace_root_param(params: &mut Vec<String>, workspace_root: Option<&str>) {
    if let Some(workspace_root) = workspace_root
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        params.push(format!("workspaceRoot={}", percent_encode(workspace_root)));
    }
}

fn path_with_params(base: String, params: Vec<String>) -> String {
    if params.is_empty() {
        base
    } else {
        format!("{}?{}", base, params.join("&"))
    }
}

fn provider_config_json(provider: &model_settings::ProviderConfig) -> serde_json::Value {
    match provider.provider {
        model_settings::ModelProvider::Openai => serde_json::json!({
            "provider": "openai",
            "model": provider.model,
            "apiKeyEnv": "OPENAI_API_KEY"
        }),
        model_settings::ModelProvider::OpenaiCodex => serde_json::json!({
            "provider": "openai-codex",
            "model": provider.model
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
    credential: Option<serde_json::Value>,
) -> serde_json::Value {
    let provider_value = provider_config_json(provider);

    let mut body = serde_json::json!({
        "prompt": "Reply with OK.",
        "provider": provider_value,
        "timeoutMs": 30_000,
    });
    if let Some(credential) = credential {
        body["credential"] = credential;
    }
    body
}

fn api_key_runtime_credential(api_key: String) -> serde_json::Value {
    serde_json::json!({ "apiKey": api_key })
}

async fn codex_oauth_runtime_credential(
    state: &SidecarHandle,
    user_key: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    let Some(mut credential) = model_settings::get_codex_oauth_credential_for_user(user_key)
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };

    if model_settings::codex_access_token_is_expiring(&credential.tokens.access_token, 120) {
        let body = model_settings::encode_codex_oauth_credential(&credential)
            .map_err(|error| error.to_string())?;
        let json = tokio::time::timeout(
            Duration::from_secs(20),
            state.post("/model/codex-oauth/refresh", &body),
        )
        .await
        .map_err(|_| "Codex sign-in refresh timed out after 20s".to_string())?
        .map_err(|error| error.to_string())?;
        credential =
            model_settings::decode_codex_oauth_credential(&json).map_err(|e| e.to_string())?;
        model_settings::set_codex_oauth_credential_for_user(user_key, &credential)
            .map_err(|error| error.to_string())?;
    }

    Ok(Some(model_settings::codex_oauth_runtime_credential(
        &credential,
    )))
}

fn tool_policy_runtime_json(preset: &str) -> serde_json::Value {
    match preset {
        "read_only" => serde_json::json!({
            "preset": "read_only",
            "label": "Read-only",
            "approvalMode": "never",
            "summary": "Can inspect and search the workspace, research the public web, and maintain the task checklist, but cannot make file changes.",
            "capabilities": ["Read files", "List directories", "Search content", "Search and fetch public web pages", "Manage task checklist"],
            "allowedTools": ["workspace_read", "workspace_list", "workspace_search", "shell", "todo", "skill_list", "skill_load"]
        }),
        "elevated_with_approval" => serde_json::json!({
            "preset": "elevated_with_approval",
            "label": "Elevated with approval",
            "approvalMode": "ask",
            "summary": "Can edit the workspace, research the public web, and maintain the task checklist, but should ask before taking mutating actions.",
            "capabilities": ["Read files", "List directories", "Search content", "Search and fetch public web pages", "Write files", "Edit files", "Manage task checklist", "Run declared skill Python helpers"],
            "allowedTools": ["workspace_read", "workspace_list", "workspace_search", "shell", "workspace_write", "workspace_edit", "todo", "skill_list", "skill_load", "skill_run_python"]
        }),
        _ => serde_json::json!({
            "preset": "workspace_editor",
            "label": "Workspace editor",
            "approvalMode": "never",
            "summary": "Can inspect the workspace, research the public web, maintain the task checklist, and update files directly when needed.",
            "capabilities": ["Read files", "List directories", "Search content", "Search and fetch public web pages", "Write files", "Edit files", "Manage task checklist", "Run declared skill Python helpers"],
            "allowedTools": ["workspace_read", "workspace_list", "workspace_search", "shell", "workspace_write", "workspace_edit", "todo", "skill_list", "skill_load", "skill_run_python"]
        }),
    }
}

fn summarize_section(text: Option<&str>, empty: &str) -> String {
    let normalized = text
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        return empty.to_string();
    }
    if normalized.len() <= 140 {
        return normalized;
    }
    format!("{}...", normalized[..137].trim_end())
}

fn compile_agent_runtime_json(agent: &serde_json::Value) -> serde_json::Value {
    let preset = agent
        .get("toolPolicyPreset")
        .and_then(|value| value.as_str())
        .unwrap_or("workspace_editor");
    let model_source = if agent
        .get("model")
        .and_then(|model| model.get("mode"))
        .and_then(|mode| mode.as_str())
        == Some("override")
    {
        "profile_override"
    } else {
        "global"
    };

    let tool_policy = tool_policy_runtime_json(preset);
    let label = tool_policy
        .get("label")
        .and_then(|value| value.as_str())
        .unwrap_or("Workspace editor");
    let approval_mode = tool_policy
        .get("approvalMode")
        .and_then(|value| value.as_str())
        .unwrap_or("never");
    let skill_count = agent
        .get("skills")
        .and_then(|value| value.as_array())
        .map(|skills| skills.len())
        .unwrap_or(0);
    let skill_summary = match skill_count {
        0 => "No profile skills enabled.".to_string(),
        1 => "1 profile skill enabled.".to_string(),
        count => format!("{} profile skills enabled.", count),
    };

    let mut runtime = serde_json::json!({
        "profileId": agent.get("id").and_then(|value| value.as_str()).unwrap_or("default"),
        "profileName": agent.get("name").and_then(|value| value.as_str()).unwrap_or("Tessera"),
        "modelSource": model_source,
        "sectionSummaries": {
            "instructions": summarize_section(agent.get("instructions").and_then(|value| value.as_str()), "No operating contract added."),
            "soul": summarize_section(agent.get("soul").and_then(|value| value.as_str()), "No tone guidance added."),
            "userContext": summarize_section(agent.get("userContext").and_then(|value| value.as_str()), "No user context added."),
            "memoryDefaults": summarize_section(agent.get("memoryDefaults").and_then(|value| value.as_str()), "No default memory added.")
        },
        "toolPolicy": tool_policy,
        "compiledSummary": if model_source == "profile_override" {
            format!(
                "{} uses {} access with approval mode {}, overrides the model configuration, and has {}",
                agent.get("name").and_then(|value| value.as_str()).unwrap_or("Tessera"),
                label,
                approval_mode,
                skill_summary
            )
        } else {
            format!(
                "{} uses {} access with approval mode {}, inherits the workspace model settings, and has {}",
                agent.get("name").and_then(|value| value.as_str()).unwrap_or("Tessera"),
                label,
                approval_mode,
                skill_summary
            )
        }
    });

    if let Some(template_id) = agent.get("templateId").and_then(|value| value.as_str()) {
        runtime["templateId"] = serde_json::json!(template_id);
    }

    if let Some(template_label) = agent.get("templateLabel").and_then(|value| value.as_str()) {
        runtime["templateLabel"] = serde_json::json!(template_label);
    }

    runtime
}

fn parse_model_provider(provider: &str) -> Result<model_settings::ModelProvider, String> {
    match provider {
        "openai" => Ok(model_settings::ModelProvider::Openai),
        "openai-codex" => Ok(model_settings::ModelProvider::OpenaiCodex),
        "anthropic" => Ok(model_settings::ModelProvider::Anthropic),
        "openrouter" => Ok(model_settings::ModelProvider::Openrouter),
        "local" => Ok(model_settings::ModelProvider::Local),
        other => Err(format!("Unsupported provider: {}", other)),
    }
}

async fn resolve_task_agent_json(
    app: &AppHandle,
    agent_id: Option<&str>,
    user_key: Option<&str>,
) -> Result<serde_json::Value, String> {
    let id = agent_id.unwrap_or("default");
    let handle = app.state::<SidecarHandle>();
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key)?;
    let path = path_with_params(format!("/agent-profiles/{}", percent_encode(id)), params);
    let json = handle.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

async fn attach_default_task_execution(
    app: &AppHandle,
    mut request: serde_json::Value,
    user_key: Option<&str>,
) -> Result<serde_json::Value, String> {
    if request.get("execution").is_some() {
        return Ok(request);
    }

    let settings_path =
        model_settings::settings_path_for_user(app, user_key).map_err(|error| error.to_string())?;
    let settings =
        model_settings::load_settings_file(&settings_path).map_err(|error| error.to_string())?;
    let agent = resolve_task_agent_json(
        app,
        request.get("agentId").and_then(|value| value.as_str()),
        user_key,
    )
    .await?;
    let provider = if agent
        .get("model")
        .and_then(|model| model.get("mode"))
        .and_then(|mode| mode.as_str())
        == Some("override")
    {
        agent
            .get("model")
            .and_then(|model| model.get("provider"))
            .cloned()
            .ok_or_else(|| "Agent model override is missing provider details".to_string())?
    } else {
        let selected = model_settings::selected_provider_config(&settings)
            .map_err(|error| error.to_string())?;
        provider_config_json(&selected)
    };
    let credential_provider = parse_model_provider(
        provider
            .get("provider")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "Resolved provider is missing a provider id".to_string())?,
    )?;
    let credential = if credential_provider == model_settings::ModelProvider::OpenaiCodex {
        let state = app.state::<SidecarHandle>();
        codex_oauth_runtime_credential(&state, user_key).await?
    } else {
        model_settings::get_credential_for_user(credential_provider, user_key)
            .map_err(|error| error.to_string())?
            .map(api_key_runtime_credential)
    };

    if credential.is_none() && credential_provider != model_settings::ModelProvider::Local {
        return Err(model_settings::missing_credential_result(credential_provider).message);
    }

    let mut execution = serde_json::json!({
        "agent": agent,
        "runtime": compile_agent_runtime_json(&agent),
        "provider": provider
    });

    if let Some(credential) = credential {
        execution["credential"] = credential;
    }

    request["execution"] = execution;
    Ok(request)
}

async fn attach_default_workflow_execution(
    app: &AppHandle,
    mut request: serde_json::Value,
    user_key: Option<&str>,
) -> Result<serde_json::Value, String> {
    if request.get("agentProvider").is_some() || request.get("credential").is_some() {
        return Ok(request);
    }

    let settings_path =
        model_settings::settings_path_for_user(app, user_key).map_err(|error| error.to_string())?;
    let settings =
        model_settings::load_settings_file(&settings_path).map_err(|error| error.to_string())?;
    let selected =
        model_settings::selected_provider_config(&settings).map_err(|error| error.to_string())?;
    let provider = provider_config_json(&selected);
    let credential = if selected.provider == model_settings::ModelProvider::OpenaiCodex {
        let state = app.state::<SidecarHandle>();
        codex_oauth_runtime_credential(&state, user_key).await?
    } else {
        model_settings::get_credential_for_user(selected.provider, user_key)
            .map_err(|error| error.to_string())?
            .map(api_key_runtime_credential)
    };

    if credential.is_none() && selected.provider != model_settings::ModelProvider::Local {
        return Err(model_settings::missing_credential_result(selected.provider).message);
    }

    request["agentProvider"] = provider;
    if let Some(credential) = credential {
        request["credential"] = credential;
    }

    Ok(request)
}

// ── Setup ─────────────────────────────────────────────────────────────────────

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let bin_dir = binaries_dir(app.handle()).context("Could not resolve binaries dir")?;
    let cli_path = external_bin_path(app.handle(), "tessera-cli")?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("Could not resolve app data dir")?;
    let app_config_dir = app
        .path()
        .app_config_dir()
        .context("Could not resolve app config dir")?;
    fs::create_dir_all(&app_data_dir).context("Could not create app data dir")?;
    fs::create_dir_all(&app_config_dir).context("Could not create app config dir")?;
    let google_workspace_config_dir = google_workspace_config_dir(&app_config_dir);
    fs::create_dir_all(&google_workspace_config_dir)
        .context("Could not create Google Workspace config dir")?;
    let workflow_db_path = app_data_dir.join("workflow-runs.sqlite");
    let task_db_path = app_data_dir.join("tasks.sqlite");
    let curated_skills_dir = bin_dir.join("skills");
    let playwright_browsers_dir = bin_dir.join("playwright-browsers");

    let mut sidecar_command = app
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
        .env(
            "TESSERA_APP_CONFIG_DIR",
            app_config_dir.to_string_lossy().as_ref(),
        )
        .env(
            "TESSERA_GWS_CONFIG_DIR",
            google_workspace_config_dir.to_string_lossy().as_ref(),
        )
        .env(
            "TESSERA_CURATED_SKILLS_DIR",
            curated_skills_dir.to_string_lossy().as_ref(),
        )
        .env("TESSERA_GRAPH_RUN_WORKER", "1")
        // pi-coding-agent resolves package assets at module init. Point it at the
        // Tauri binaries/resource dir where packaging keeps package.json.
        .env("PI_PACKAGE_DIR", bin_dir.to_string_lossy().as_ref());

    for (name, build_value) in optional_capability_env_sources() {
        if let Some(value) = runtime_or_build_env(name, build_value) {
            sidecar_command = sidecar_command.env(name, value);
        }
    }

    if playwright_browsers_dir.exists() {
        sidecar_command = sidecar_command.env(
            "TESSERA_PLAYWRIGHT_BROWSERS_PATH",
            playwright_browsers_dir.to_string_lossy().as_ref(),
        );
    }

    let (mut rx, child) = sidecar_command.spawn().context("Could not spawn sidecar")?;

    // Block until the sidecar emits its ready JSON line (60 s timeout).
    let handle = tauri::async_runtime::block_on(async {
        tokio::time::timeout(Duration::from_secs(60), async {
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
        .unwrap_or_else(|_| bail!("Sidecar startup timed out after 60 s"))
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityBinaryResult {
    capability_id: String,
    binary_name: String,
    path: Option<String>,
    installed: bool,
    install_available: bool,
    version: String,
    size_bytes: Option<u64>,
    message: Option<String>,
    progress: Option<CapabilityInstallProgress>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityInstallProgress {
    phase: String,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleWorkspaceServiceHealth {
    service: String,
    ok: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleWorkspaceOAuthClientStatus {
    has_client: bool,
    source: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleWorkspaceOAuthClientSaveRequest {
    client_id: String,
    client_secret: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDirEntry {
    name: String,
    relative_path: String,
    is_directory: bool,
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
async fn memory_status_get(
    state: State<'_, SidecarHandle>,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params("/memory/status".to_string(), params);
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn memory_review_list(
    state: State<'_, SidecarHandle>,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params("/memory/review".to_string(), params);
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn memory_review_decide(
    state: State<'_, SidecarHandle>,
    decision: serde_json::Value,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params("/memory/review/decision".to_string(), params);
    let body = serde_json::to_string(&decision).map_err(|e| e.to_string())?;
    let json = state.post(&path, &body).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn memory_forget(
    state: State<'_, SidecarHandle>,
    request: serde_json::Value,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params("/memory/forget".to_string(), params);
    let body = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    let json = state.post(&path, &body).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

async fn run_workspace_cli_command(
    app: &AppHandle,
    state: &SidecarHandle,
    args: &[&str],
    credential_env: Option<(String, String)>,
) -> Result<SpawnResult, String> {
    let cli_path = external_bin_path(app, "tessera-cli").map_err(|error| error.to_string())?;
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let google_workspace_config_dir = google_workspace_config_dir(&app_config_dir);
    let start = std::time::Instant::now();
    let mut command = std::process::Command::new(cli_path);
    command.args(args);
    command.env(
        "TESSERA_APP_CONFIG_DIR",
        app_config_dir.to_string_lossy().as_ref(),
    );
    if workspace_cli_uses_google_workspace(args) {
        fs::create_dir_all(&google_workspace_config_dir).map_err(|error| error.to_string())?;
        install_google_workspace_oauth_client_file(app, &google_workspace_config_dir)
            .map_err(|error| error.to_string())?;
        let gws_path = google_workspace_cli_path(app, state).await?;
        apply_google_workspace_env(&mut command, &gws_path, &google_workspace_config_dir);
    }
    if let Some((env_name, credential)) = credential_env {
        command.env(env_name, credential);
    }
    let output = command.output().map_err(|error| error.to_string())?;

    Ok(SpawnResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
        signal: None,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

async fn run_google_workspace_cli_command(
    app: &AppHandle,
    state: &SidecarHandle,
    args: &[&str],
) -> Result<SpawnResult, String> {
    let gws_path = google_workspace_cli_path(app, state).await?;
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let google_workspace_config_dir = google_workspace_config_dir(&app_config_dir);
    fs::create_dir_all(&google_workspace_config_dir).map_err(|error| error.to_string())?;
    install_google_workspace_oauth_client_file(app, &google_workspace_config_dir)
        .map_err(|error| error.to_string())?;

    let start = std::time::Instant::now();
    let mut command = std::process::Command::new(gws_path.clone());
    command.args(args);
    apply_google_workspace_env(&mut command, &gws_path, &google_workspace_config_dir);
    let output = command.output().map_err(|error| error.to_string())?;

    Ok(SpawnResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
        signal: None,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

async fn start_google_workspace_login_command(
    app: &AppHandle,
    state: &SidecarHandle,
    args: &[&str],
) -> Result<SpawnResult, String> {
    let gws_path = google_workspace_cli_path(app, state).await?;
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let google_workspace_config_dir = google_workspace_config_dir(&app_config_dir);
    fs::create_dir_all(&google_workspace_config_dir).map_err(|error| error.to_string())?;
    install_google_workspace_oauth_client_file(app, &google_workspace_config_dir)
        .map_err(|error| error.to_string())?;

    let log_path = google_workspace_auth_log_path(&google_workspace_config_dir);
    let log = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&log_path)
        .map_err(|error| error.to_string())?;
    let stderr = log.try_clone().map_err(|error| error.to_string())?;

    let start = std::time::Instant::now();
    let mut command = std::process::Command::new(gws_path.clone());
    command.args(args);
    apply_google_workspace_env(&mut command, &gws_path, &google_workspace_config_dir);
    command.stdout(Stdio::from(log));
    command.stderr(Stdio::from(stderr));
    let mut child = command.spawn().map_err(|error| error.to_string())?;

    for _ in 0..20 {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let output = fs::read_to_string(&log_path).unwrap_or_default();
            let _ = fs::remove_file(&log_path);
            return Ok(SpawnResult {
                stdout: output,
                stderr: String::new(),
                exit_code: status.code().unwrap_or(-1),
                signal: None,
                duration_ms: start.elapsed().as_millis() as u64,
            });
        }
        let output = fs::read_to_string(&log_path).unwrap_or_default();
        if let Some(url) = extract_google_oauth_url(&output) {
            let _ = fs::remove_file(&log_path);
            #[allow(deprecated)]
            return match app.shell().open(url.clone(), None) {
                Ok(()) => Ok(SpawnResult {
                    stdout: "Google sign-in opened in your browser. Complete it there, then click Test connection.".to_string(),
                    stderr: String::new(),
                    exit_code: 124,
                    signal: None,
                    duration_ms: start.elapsed().as_millis() as u64,
                }),
                Err(error) => Ok(SpawnResult {
                    stdout: format!(
                        "Could not open your browser automatically. Open this URL to continue Google sign-in: {url}"
                    ),
                    stderr: error.to_string(),
                    exit_code: 124,
                    signal: None,
                    duration_ms: start.elapsed().as_millis() as u64,
                }),
            };
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    let output = fs::read_to_string(&log_path).unwrap_or_default();
    let _ = fs::remove_file(&log_path);
    Ok(SpawnResult {
        stdout: extract_google_oauth_url(&output)
            .map(|url| format!("Open this URL to continue Google sign-in: {url}"))
            .unwrap_or_else(|| {
                "Google sign-in is waiting. Complete it in your browser, then click Test connection."
                    .to_string()
            }),
        stderr: String::new(),
        exit_code: 124,
        signal: None,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

async fn google_workspace_auth_status(
    app: &AppHandle,
    state: &SidecarHandle,
) -> Result<SpawnResult, String> {
    run_google_workspace_cli_command(app, state, &["auth", "status"]).await
}

fn google_workspace_auth_args() -> Vec<&'static str> {
    vec!["auth", "login", "--scopes", GOOGLE_WORKSPACE_AUTH_SCOPES]
}

fn google_identity_auth_args() -> Vec<&'static str> {
    vec!["auth", "login", "--scopes", "openid,email,profile"]
}

fn google_workspace_oauth_client_json(client_id: &str, client_secret: &str) -> serde_json::Value {
    serde_json::json!({
        "installed": {
            "client_id": client_id,
            "project_id": GOOGLE_WORKSPACE_DEFAULT_PROJECT_ID,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
            "redirect_uris": ["http://localhost"],
        }
    })
}

fn write_google_workspace_oauth_client_file(
    path: &Path,
    client_id: &str,
    client_secret: &str,
) -> anyhow::Result<()> {
    let mut bytes = serde_json::to_vec_pretty(&google_workspace_oauth_client_json(
        client_id,
        client_secret,
    ))?;
    bytes.push(b'\n');
    fs::write(path, bytes).with_context(|| {
        format!(
            "Could not save Google Workspace OAuth client to {}",
            path.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).with_context(|| {
            format!(
                "Could not secure Google Workspace OAuth client file {}",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn google_workspace_oauth_client_status_for_paths(
    config_dir: &Path,
    bundled_file: &Path,
) -> GoogleWorkspaceOAuthClientStatus {
    let source = if google_workspace_oauth_client_env_configured() {
        "build"
    } else if google_workspace_gws_client_secret_path(config_dir).exists() {
        "saved"
    } else if bundled_file.exists() {
        "bundled"
    } else {
        "missing"
    };

    GoogleWorkspaceOAuthClientStatus {
        has_client: source != "missing",
        source: source.to_string(),
    }
}

fn google_workspace_oauth_client_status_result(
    app: &AppHandle,
) -> anyhow::Result<GoogleWorkspaceOAuthClientStatus> {
    let app_config_dir = app.path().app_config_dir()?;
    let google_workspace_config_dir = google_workspace_config_dir(&app_config_dir);
    let bundled_file = bundled_google_workspace_oauth_client_path(app)?;
    Ok(google_workspace_oauth_client_status_for_paths(
        &google_workspace_config_dir,
        &bundled_file,
    ))
}

#[tauri::command]
async fn google_workspace_oauth_client_status(
    app: AppHandle,
) -> Result<GoogleWorkspaceOAuthClientStatus, String> {
    google_workspace_oauth_client_status_result(&app).map_err(|error| error.to_string())
}

#[tauri::command]
async fn google_workspace_capability_status(
    state: tauri::State<'_, SidecarHandle>,
) -> Result<CapabilityBinaryResult, String> {
    managed_capability_binary_status(state.inner(), "google-workspace-cli", "gws")
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn google_workspace_capability_install(
    state: tauri::State<'_, SidecarHandle>,
) -> Result<CapabilityBinaryResult, String> {
    managed_capability_binary_install(state.inner(), "google-workspace-cli", "gws")
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn browser_runtime_capability_status(
    state: tauri::State<'_, SidecarHandle>,
) -> Result<CapabilityBinaryResult, String> {
    managed_capability_binary_status(state.inner(), "browser-runtime", "chromium")
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn browser_runtime_capability_install(
    state: tauri::State<'_, SidecarHandle>,
) -> Result<CapabilityBinaryResult, String> {
    managed_capability_binary_install(state.inner(), "browser-runtime", "chromium")
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn google_workspace_oauth_client_save(
    app: AppHandle,
    request: GoogleWorkspaceOAuthClientSaveRequest,
) -> Result<GoogleWorkspaceOAuthClientStatus, String> {
    let client_id = request.client_id.trim();
    let client_secret = request.client_secret.trim();
    if client_id.is_empty() {
        return Err("OAuth client ID cannot be empty".to_string());
    }
    if client_secret.is_empty() {
        return Err("OAuth client secret cannot be empty".to_string());
    }

    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let google_workspace_config_dir = google_workspace_config_dir(&app_config_dir);
    fs::create_dir_all(&google_workspace_config_dir).map_err(|error| error.to_string())?;
    write_google_workspace_oauth_client_file(
        &google_workspace_gws_client_secret_path(&google_workspace_config_dir),
        client_id,
        client_secret,
    )
    .map_err(|error| error.to_string())?;
    google_workspace_oauth_client_status_result(&app).map_err(|error| error.to_string())
}

#[tauri::command]
async fn google_workspace_oauth_client_delete(
    app: AppHandle,
) -> Result<GoogleWorkspaceOAuthClientStatus, String> {
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let google_workspace_config_dir = google_workspace_config_dir(&app_config_dir);
    let saved_file = google_workspace_gws_client_secret_path(&google_workspace_config_dir);
    if saved_file.exists() {
        fs::remove_file(&saved_file).map_err(|error| error.to_string())?;
    }
    google_workspace_oauth_client_status_result(&app).map_err(|error| error.to_string())
}

#[tauri::command]
async fn playbook_list(
    state: State<'_, SidecarHandle>,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params("/playbooks".to_string(), params);
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn playbook_get(
    state: State<'_, SidecarHandle>,
    playbook_id: String,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params(
        format!("/playbooks/{}", percent_encode(&playbook_id)),
        params,
    );
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn playbook_run_preference_get(
    state: State<'_, SidecarHandle>,
    playbook_id: String,
    workspace_root: String,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    push_workspace_root_param(&mut params, Some(&workspace_root));
    let path = path_with_params(
        format!("/playbooks/{}/run-preference", percent_encode(&playbook_id)),
        params,
    );
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn playbook_run_preference_save(
    state: State<'_, SidecarHandle>,
    playbook_id: String,
    request: serde_json::Value,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params(
        format!("/playbooks/{}/run-preference", percent_encode(&playbook_id)),
        params,
    );
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn playbook_preflight(
    state: State<'_, SidecarHandle>,
    playbook_id: String,
    request: serde_json::Value,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params(
        format!("/playbooks/{}/preflight", percent_encode(&playbook_id)),
        params,
    );
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn playbook_import(
    state: State<'_, SidecarHandle>,
    zip_path: Option<String>,
    source_path: Option<String>,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let zip_path = zip_path.unwrap_or_default();
    let zip_path = zip_path.trim();
    let source_path = source_path.unwrap_or_default();
    let source_path = source_path.trim();
    if zip_path.is_empty() && source_path.is_empty() {
        return Err("zip_path or source_path is required".to_string());
    }
    if !zip_path.is_empty() && !source_path.is_empty() {
        return Err("Provide either zip_path or source_path, not both".to_string());
    }
    if !zip_path.is_empty() && !std::path::Path::new(zip_path).is_absolute() {
        return Err("zip_path must be an absolute path".to_string());
    }
    if !source_path.is_empty() && !std::path::Path::new(source_path).is_absolute() {
        return Err("source_path must be an absolute path".to_string());
    }
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params("/graph-playbooks/import".to_string(), params);
    let body = if zip_path.is_empty() {
        serde_json::json!({ "sourceRoot": source_path })
    } else {
        serde_json::json!({ "zipPath": zip_path })
    };
    let json = state
        .post(&path, &body.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn workspace_style_guide_get(
    state: State<'_, SidecarHandle>,
    workspace_root: String,
) -> Result<serde_json::Value, String> {
    let path = format!(
        "/workspace/style-guide?workspaceRoot={}",
        percent_encode(&workspace_root)
    );
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn workspace_style_guide_save(
    state: State<'_, SidecarHandle>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let json = state
        .post("/workspace/style-guide", &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn graph_run_create(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    request: serde_json::Value,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let scoped_user_key = scoped_command_user_key(user_key.as_deref())?;
    let request = attach_default_workflow_execution(&app, request, scoped_user_key).await?;
    let mut params = Vec::new();
    push_user_key_param(&mut params, scoped_user_key)?;
    let path = path_with_params("/graph-runs".to_string(), params);
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn graph_run_drain(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    run_id: String,
    user_key: Option<String>,
    workspace_root: Option<String>,
) -> Result<serde_json::Value, String> {
    let scoped_user_key = scoped_command_user_key(user_key.as_deref())?;
    let request =
        attach_default_workflow_execution(&app, serde_json::json!({}), scoped_user_key).await?;
    let mut params = Vec::new();
    push_user_key_param(&mut params, scoped_user_key)?;
    push_workspace_root_param(&mut params, workspace_root.as_deref());
    let path = path_with_params(
        format!("/graph-runs/{}/drain", percent_encode(&run_id)),
        params,
    );
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn graph_run_list(
    state: State<'_, SidecarHandle>,
    playbook_id: Option<String>,
    status: Option<String>,
    limit: Option<u32>,
    user_key: Option<String>,
    workspace_root: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    push_workspace_root_param(&mut params, workspace_root.as_deref());
    if let Some(playbook_id) = playbook_id {
        params.push(format!("playbookId={}", percent_encode(&playbook_id)));
    }
    if let Some(status) = status {
        params.push(format!("status={}", percent_encode(&status)));
    }
    if let Some(limit) = limit {
        params.push(format!("limit={}", limit));
    }
    let path = if params.is_empty() {
        "/graph-runs".to_string()
    } else {
        format!("/graph-runs?{}", params.join("&"))
    };
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn graph_run_get(
    state: State<'_, SidecarHandle>,
    run_id: String,
    user_key: Option<String>,
    workspace_root: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    push_workspace_root_param(&mut params, workspace_root.as_deref());
    let path = path_with_params(format!("/graph-runs/{}", percent_encode(&run_id)), params);
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn graph_run_review_surface(
    state: State<'_, SidecarHandle>,
    run_id: String,
    user_key: Option<String>,
    workspace_root: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    push_workspace_root_param(&mut params, workspace_root.as_deref());
    let path = path_with_params(
        format!("/graph-runs/{}/review-surface", percent_encode(&run_id)),
        params,
    );
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn graph_run_git_milestone_commit(
    state: State<'_, SidecarHandle>,
    run_id: String,
    request: serde_json::Value,
    user_key: Option<String>,
    workspace_root: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    push_workspace_root_param(&mut params, workspace_root.as_deref());
    let path = path_with_params(
        format!("/graph-runs/{}/git-milestone", percent_encode(&run_id)),
        params,
    );
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn graph_run_git_milestone_preview(
    state: State<'_, SidecarHandle>,
    run_id: String,
    request: serde_json::Value,
    user_key: Option<String>,
    workspace_root: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    push_workspace_root_param(&mut params, workspace_root.as_deref());
    let path = path_with_params(
        format!(
            "/graph-runs/{}/git-milestone/preview",
            percent_encode(&run_id)
        ),
        params,
    );
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn graph_run_resume(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    run_id: String,
    request: serde_json::Value,
    user_key: Option<String>,
    workspace_root: Option<String>,
) -> Result<serde_json::Value, String> {
    let scoped_user_key = scoped_command_user_key(user_key.as_deref())?;
    let request = attach_default_workflow_execution(&app, request, scoped_user_key).await?;
    let body = request.to_string();
    let mut params = Vec::new();
    push_user_key_param(&mut params, scoped_user_key)?;
    push_workspace_root_param(&mut params, workspace_root.as_deref());
    let path = path_with_params(
        format!("/graph-runs/{}/resume", percent_encode(&run_id)),
        params,
    );
    let json = state.post(&path, &body).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn inbox_list(
    state: State<'_, SidecarHandle>,
    status: Option<String>,
    message_type: Option<String>,
    workspace_root: Option<String>,
    task_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    if let Some(status) = status {
        params.push(format!("status={}", percent_encode(&status)));
    }
    if let Some(message_type) = message_type {
        params.push(format!("type={}", percent_encode(&message_type)));
    }
    if let Some(workspace_root) = workspace_root {
        params.push(format!("workspaceRoot={}", percent_encode(&workspace_root)));
    }
    if let Some(task_id) = task_id {
        params.push(format!("taskId={}", percent_encode(&task_id)));
    }

    let path = if params.is_empty() {
        "/inbox".to_string()
    } else {
        format!("/inbox?{}", params.join("&"))
    };
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn inbox_get(
    state: State<'_, SidecarHandle>,
    message_id: String,
) -> Result<serde_json::Value, String> {
    let path = format!("/inbox/{}", percent_encode(&message_id));
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn inbox_create(
    state: State<'_, SidecarHandle>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let json = state
        .post("/inbox", &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn inbox_resolve(
    state: State<'_, SidecarHandle>,
    message_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let path = format!("/inbox/{}/resolve", percent_encode(&message_id));
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn inbox_snooze(
    state: State<'_, SidecarHandle>,
    message_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let path = format!("/inbox/{}/snooze", percent_encode(&message_id));
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn inbox_cancel(
    state: State<'_, SidecarHandle>,
    message_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let path = format!("/inbox/{}/cancel", percent_encode(&message_id));
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
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
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let scoped_user_key = scoped_command_user_key(user_key.as_deref())?;
    let request = attach_default_task_execution(&app, request, scoped_user_key).await?;
    let mut params = Vec::new();
    push_user_key_param(&mut params, scoped_user_key)?;
    let path = path_with_params("/tasks".to_string(), params);
    let json = state
        .post(&path, &request.to_string())
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
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let scoped_user_key = scoped_command_user_key(user_key.as_deref())?;
    let request = attach_default_task_execution(&app, request, scoped_user_key).await?;
    let mut params = Vec::new();
    push_user_key_param(&mut params, scoped_user_key)?;
    let path = path_with_params(format!("/tasks/{}/turns", percent_encode(&task_id)), params);
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn task_todo_apply(
    state: State<'_, SidecarHandle>,
    task_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let path = format!("/tasks/{}/todo", percent_encode(&task_id));
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn task_clarify_request(
    state: State<'_, SidecarHandle>,
    task_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let path = format!("/tasks/{}/clarify", percent_encode(&task_id));
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn task_clarify_resolve(
    state: State<'_, SidecarHandle>,
    task_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let path = format!("/tasks/{}/clarify/resolve", percent_encode(&task_id));
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn task_notify(
    state: State<'_, SidecarHandle>,
    task_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let path = format!("/tasks/{}/notify", percent_encode(&task_id));
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn skill_list(
    state: State<'_, SidecarHandle>,
    workspace_root: Option<String>,
    agent_id: Option<String>,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    if let Some(workspace_root) = workspace_root {
        params.push(format!("workspaceRoot={}", percent_encode(&workspace_root)));
    }
    if let Some(agent_id) = agent_id {
        params.push(format!("agentId={}", percent_encode(&agent_id)));
    }
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params("/skills".to_string(), params);
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn skill_get(
    state: State<'_, SidecarHandle>,
    id: String,
    workspace_root: Option<String>,
    agent_id: Option<String>,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    if let Some(workspace_root) = workspace_root {
        params.push(format!("workspaceRoot={}", percent_encode(&workspace_root)));
    }
    if let Some(agent_id) = agent_id {
        params.push(format!("agentId={}", percent_encode(&agent_id)));
    }
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params(format!("/skills/{}", percent_encode(&id)), params);
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn task_skill_add(
    state: State<'_, SidecarHandle>,
    task_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let path = format!("/tasks/{}/skills", percent_encode(&task_id));
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn task_skill_remove(
    state: State<'_, SidecarHandle>,
    task_id: String,
    skill_id: String,
) -> Result<serde_json::Value, String> {
    let path = format!(
        "/tasks/{}/skills/{}",
        percent_encode(&task_id),
        percent_encode(&skill_id)
    );
    let json = state
        .request("DELETE", &path, None)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn model_settings_get(
    app: AppHandle,
    user_key: Option<String>,
) -> Result<model_settings::ModelSettingsRead, String> {
    model_settings::read_for_user(&app, user_key.as_deref()).map_err(|error| error.to_string())
}

#[tauri::command]
async fn model_settings_save(
    app: AppHandle,
    request: model_settings::ModelSettingsSaveRequest,
    user_key: Option<String>,
) -> Result<model_settings::ModelSettingsRead, String> {
    model_settings::save_for_user(&app, user_key.as_deref(), request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn model_credential_delete(
    app: AppHandle,
    request: model_settings::ModelCredentialDeleteRequest,
    user_key: Option<String>,
) -> Result<model_settings::ModelSettingsRead, String> {
    model_settings::delete_for_user(&app, user_key.as_deref(), request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn model_codex_oauth_status(
    user_key: Option<String>,
) -> Result<model_settings::CodexOAuthStatus, String> {
    model_settings::codex_oauth_status_for_user(user_key.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn model_codex_oauth_save(
    app: AppHandle,
    credential: model_settings::CodexOAuthCredential,
    user_key: Option<String>,
) -> Result<model_settings::ModelSettingsRead, String> {
    model_settings::set_codex_oauth_credential_for_user(user_key.as_deref(), &credential)
        .map_err(|error| error.to_string())?;
    model_settings::read_for_user(&app, user_key.as_deref()).map_err(|error| error.to_string())
}

#[tauri::command]
async fn model_codex_oauth_device_code(
    state: State<'_, SidecarHandle>,
) -> Result<serde_json::Value, String> {
    let json = tokio::time::timeout(
        Duration::from_secs(20),
        state.post("/model/codex-oauth/device-code", "{}"),
    )
    .await
    .map_err(|_| "Codex sign-in request timed out after 20s".to_string())?
    .map_err(|error| error.to_string())?;
    serde_json::from_str(&json).map_err(|error| error.to_string())
}

#[tauri::command]
async fn model_codex_oauth_poll(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    device_auth_id: String,
    user_code: String,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "deviceAuthId": device_auth_id,
        "userCode": user_code
    })
    .to_string();
    let json = tokio::time::timeout(
        Duration::from_secs(20),
        state.post("/model/codex-oauth/poll", &body),
    )
    .await
    .map_err(|_| "Codex sign-in poll timed out after 20s".to_string())?
    .map_err(|error| error.to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(&json).map_err(|error| error.to_string())?;
    if value.get("status").and_then(|status| status.as_str()) == Some("authorized") {
        let credential = value
            .get("credential")
            .cloned()
            .ok_or_else(|| "Codex sign-in response is missing credential".to_string())
            .and_then(|credential| {
                serde_json::from_value::<model_settings::CodexOAuthCredential>(credential)
                    .map_err(|error| error.to_string())
            })?;
        model_settings::set_codex_oauth_credential_for_user(user_key.as_deref(), &credential)
            .map_err(|error| error.to_string())?;
        let read = model_settings::read_for_user(&app, user_key.as_deref())
            .map_err(|error| error.to_string())?;
        return Ok(serde_json::json!({
            "status": "authorized",
            "settings": read
        }));
    }
    Ok(value)
}

#[tauri::command]
async fn model_connection_test(
    state: State<'_, SidecarHandle>,
    request: model_settings::ModelConnectionTestRequest,
    user_key: Option<String>,
) -> Result<model_settings::ModelConnectionTestResult, String> {
    let provider =
        model_settings::validate_provider_config(&request.provider).map_err(|e| e.to_string())?;
    let credential = if provider.provider == model_settings::ModelProvider::OpenaiCodex {
        codex_oauth_runtime_credential(&state, user_key.as_deref()).await?
    } else {
        match request.credential {
            Some(input) => {
                let api_key = input.api_key.trim();
                (!api_key.is_empty()).then(|| api_key_runtime_credential(api_key.to_string()))
            }
            None => model_settings::get_credential_for_user(provider.provider, user_key.as_deref())
                .map_err(|error| error.to_string())?
                .map(api_key_runtime_credential),
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
async fn integration_settings_get(
    app: AppHandle,
    user_key: Option<String>,
) -> Result<integration_settings::IntegrationSettingsRead, String> {
    integration_settings::read_for_user(&app, user_key.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn integration_settings_save(
    app: AppHandle,
    request: integration_settings::IntegrationSettingsSaveRequest,
    user_key: Option<String>,
) -> Result<integration_settings::IntegrationSettingsRead, String> {
    integration_settings::save_for_user(&app, user_key.as_deref(), request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn integration_credential_delete(
    app: AppHandle,
    request: integration_settings::IntegrationCredentialDeleteRequest,
    user_key: Option<String>,
) -> Result<integration_settings::IntegrationSettingsRead, String> {
    integration_settings::delete_for_user(&app, user_key.as_deref(), request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn integration_connection_test(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    request: integration_settings::IntegrationConnectionTestRequest,
    user_key: Option<String>,
) -> Result<integration_settings::IntegrationConnectionTestResult, String> {
    let scoped_user_key = scoped_command_user_key(user_key.as_deref())?;
    let target = request.target().map_err(|error| error.to_string())?;
    let (command_args, credential_env, provider, search_provider) = match target {
        integration_settings::IntegrationRequestTarget::Integration(provider) => {
            let (command_args, credential_env_name) = match provider {
                integration_settings::IntegrationProvider::BraveSearch => {
                    search_connection_command(integration_settings::SearchProvider::BraveSearch)
                }
                integration_settings::IntegrationProvider::GoogleWorkspace => {
                    let status = google_workspace_auth_status(&app, state.inner()).await?;
                    if status.exit_code != 0 || !google_workspace_auth_status_connected(&status) {
                        integration_settings::set_google_workspace_connected_for_user(
                            &app,
                            scoped_user_key,
                            false,
                        )
                        .map_err(|error| error.to_string())?;
                        return Ok(integration_settings::IntegrationConnectionTestResult {
                            ok: false,
                            message: first_useful_process_line(&status),
                            provider: Some(provider),
                            search_provider: None,
                            user: None,
                        });
                    }
                    (vec!["gcal", "list", "--limit", "1"], None)
                }
            };
            let credential = if credential_env_name.is_some() {
                match request.credential {
                    Some(input) => {
                        let api_key = input.api_key.trim();
                        (!api_key.is_empty()).then(|| api_key.to_string())
                    }
                    None => {
                        integration_settings::get_credential_for_user(provider, scoped_user_key)
                            .map_err(|error| error.to_string())?
                    }
                }
            } else {
                None
            };

            if credential_env_name.is_some() && credential.is_none() {
                return Ok(integration_settings::missing_credential_result(provider));
            }

            let credential_env = credential.as_deref().and_then(|value| {
                credential_env_name.map(|name| (name.to_string(), value.to_string()))
            });
            (command_args, credential_env, Some(provider), None)
        }
        integration_settings::IntegrationRequestTarget::Search(search_provider) => {
            let credential = match request.credential {
                Some(input) => {
                    let api_key = input.api_key.trim();
                    (!api_key.is_empty()).then(|| api_key.to_string())
                }
                None => integration_settings::get_search_credential_for_user(
                    search_provider,
                    scoped_user_key,
                )
                .map_err(|error| error.to_string())?,
            };

            if credential.is_none()
                && search_provider != integration_settings::SearchProvider::DuckDuckGo
            {
                return Ok(integration_settings::missing_search_credential_result(
                    search_provider,
                ));
            }

            let (command_args, credential_env_name) = search_connection_command(search_provider);
            let credential_env = credential.as_deref().and_then(|value| {
                credential_env_name.map(|name| (name.to_string(), value.to_string()))
            });
            (command_args, credential_env, None, Some(search_provider))
        }
    };

    let result =
        run_workspace_cli_command(&app, state.inner(), &command_args, credential_env).await?;
    let ok = result.exit_code == 0;
    let message = if ok {
        "Connection test succeeded".to_string()
    } else {
        result
            .stderr
            .trim()
            .split('\n')
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Connection test failed")
            .to_string()
    };
    if provider == Some(integration_settings::IntegrationProvider::GoogleWorkspace) {
        integration_settings::set_google_workspace_connected_for_user(&app, scoped_user_key, ok)
            .map_err(|error| error.to_string())?;
    }

    Ok(connection_test_result(
        ok,
        message,
        provider,
        search_provider,
    ))
}

#[tauri::command]
async fn google_workspace_connection_status(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    user_key: Option<String>,
) -> Result<integration_settings::IntegrationConnectionTestResult, String> {
    let scoped_user_key = scoped_command_user_key(user_key.as_deref())?;
    let status = google_workspace_auth_status(&app, state.inner()).await?;
    let ok = status.exit_code == 0 && google_workspace_auth_status_connected(&status);
    if ok {
        integration_settings::set_google_workspace_connected_for_user(&app, scoped_user_key, true)
            .map_err(|error| error.to_string())?;
    }

    Ok(integration_settings::IntegrationConnectionTestResult {
        ok,
        message: if ok {
            "Google Workspace connected.".to_string()
        } else {
            "Waiting for Google sign-in to finish.".to_string()
        },
        provider: Some(integration_settings::IntegrationProvider::GoogleWorkspace),
        search_provider: None,
        user: None,
    })
}

#[tauri::command]
async fn google_workspace_connect(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    user_key: Option<String>,
) -> Result<integration_settings::IntegrationConnectionTestResult, String> {
    let scoped_user_key = scoped_command_user_key(user_key.as_deref())?;
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let google_workspace_config_dir = google_workspace_config_dir(&app_config_dir);
    fs::create_dir_all(&google_workspace_config_dir).map_err(|error| error.to_string())?;
    if !install_google_workspace_oauth_client_file(&app, &google_workspace_config_dir)
        .map_err(|error| error.to_string())?
    {
        return Ok(integration_settings::IntegrationConnectionTestResult {
            ok: false,
            message: google_workspace_oauth_missing_message(),
            provider: Some(integration_settings::IntegrationProvider::GoogleWorkspace),
            search_provider: None,
            user: None,
        });
    }

    let login =
        start_google_workspace_login_command(&app, state.inner(), &google_workspace_auth_args())
            .await?;
    if login.exit_code == 124 {
        return Ok(integration_settings::IntegrationConnectionTestResult {
            ok: false,
            message: first_useful_process_line(&login),
            provider: Some(integration_settings::IntegrationProvider::GoogleWorkspace),
            search_provider: None,
            user: None,
        });
    }
    if login.exit_code != 0 {
        return Ok(integration_settings::IntegrationConnectionTestResult {
            ok: false,
            message: first_useful_process_line(&login),
            provider: Some(integration_settings::IntegrationProvider::GoogleWorkspace),
            search_provider: None,
            user: None,
        });
    }

    let status = google_workspace_auth_status(&app, state.inner()).await?;
    let ok = status.exit_code == 0 && google_workspace_auth_status_connected(&status);
    if ok {
        integration_settings::set_google_workspace_connected_for_user(&app, scoped_user_key, true)
            .map_err(|error| error.to_string())?;
    }

    Ok(integration_settings::IntegrationConnectionTestResult {
        ok,
        message: if ok {
            "Google Workspace connected.".to_string()
        } else {
            first_useful_process_line(&status)
        },
        provider: Some(integration_settings::IntegrationProvider::GoogleWorkspace),
        search_provider: None,
        user: None,
    })
}

#[tauri::command]
async fn google_identity_connection_status(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
) -> Result<integration_settings::IntegrationConnectionTestResult, String> {
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let google_workspace_config_dir = google_workspace_config_dir(&app_config_dir);
    let status = google_workspace_auth_status(&app, state.inner()).await?;
    let ok = status.exit_code == 0 && google_workspace_auth_status_connected(&status);
    let user = ok
        .then(|| google_authenticated_user_from_outputs(&google_workspace_config_dir, &[&status]))
        .flatten();

    Ok(integration_settings::IntegrationConnectionTestResult {
        ok,
        message: if ok {
            "Google sign-in complete.".to_string()
        } else {
            "Waiting for Google sign-in to finish.".to_string()
        },
        provider: None,
        search_provider: None,
        user,
    })
}

#[tauri::command]
async fn google_identity_connect(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
) -> Result<integration_settings::IntegrationConnectionTestResult, String> {
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let google_workspace_config_dir = google_workspace_config_dir(&app_config_dir);
    fs::create_dir_all(&google_workspace_config_dir).map_err(|error| error.to_string())?;
    if !install_google_workspace_oauth_client_file(&app, &google_workspace_config_dir)
        .map_err(|error| error.to_string())?
    {
        return Ok(integration_settings::IntegrationConnectionTestResult {
            ok: false,
            message: google_workspace_oauth_missing_message(),
            provider: None,
            search_provider: None,
            user: None,
        });
    }

    let login =
        start_google_workspace_login_command(&app, state.inner(), &google_identity_auth_args())
            .await?;
    if login.exit_code == 124 {
        return Ok(integration_settings::IntegrationConnectionTestResult {
            ok: false,
            message: first_useful_process_line(&login),
            provider: None,
            search_provider: None,
            user: None,
        });
    }
    if login.exit_code != 0 {
        return Ok(integration_settings::IntegrationConnectionTestResult {
            ok: false,
            message: first_useful_process_line(&login),
            provider: None,
            search_provider: None,
            user: None,
        });
    }

    let status = google_workspace_auth_status(&app, state.inner()).await?;
    let ok = status.exit_code == 0 && google_workspace_auth_status_connected(&status);
    let user = ok
        .then(|| {
            google_authenticated_user_from_outputs(&google_workspace_config_dir, &[&login, &status])
        })
        .flatten();

    Ok(integration_settings::IntegrationConnectionTestResult {
        ok,
        message: if ok {
            "Google sign-in complete.".to_string()
        } else {
            first_useful_process_line(&status)
        },
        provider: None,
        search_provider: None,
        user,
    })
}

#[tauri::command]
async fn google_workspace_disconnect(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    user_key: Option<String>,
) -> Result<integration_settings::IntegrationSettingsRead, String> {
    let scoped_user_key = scoped_command_user_key(user_key.as_deref())?;
    let logout = run_google_workspace_cli_command(&app, state.inner(), &["auth", "logout"]).await?;
    if logout.exit_code != 0 {
        return Err(first_useful_process_line(&logout));
    }
    integration_settings::set_google_workspace_connected_for_user(&app, scoped_user_key, false)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn google_workspace_health(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
) -> Result<Vec<GoogleWorkspaceServiceHealth>, String> {
    let checks: [(&str, Vec<&str>); 4] = [
        (
            "Calendar",
            vec![
                "calendar",
                "calendarList",
                "list",
                "--params",
                "{\"maxResults\":1}",
            ],
        ),
        (
            "Gmail",
            vec![
                "gmail",
                "users",
                "messages",
                "list",
                "--params",
                "{\"userId\":\"me\",\"maxResults\":1}",
            ],
        ),
        (
            "Drive",
            vec![
                "drive",
                "files",
                "list",
                "--params",
                "{\"pageSize\":1,\"fields\":\"files(id,name,mimeType)\"}",
            ],
        ),
        (
            "Contacts",
            vec![
                "people",
                "people",
                "connections",
                "list",
                "--params",
                "{\"resourceName\":\"people/me\",\"pageSize\":1}",
            ],
        ),
    ];
    let mut results = Vec::with_capacity(6);
    let mut drive_ok = false;

    for (service, args) in checks {
        let result = run_google_workspace_cli_command(&app, state.inner(), &args).await?;
        let ok = result.exit_code == 0;
        let message = if ok {
            "Ready".to_string()
        } else {
            google_workspace_process_message(&result)
        };
        if service == "Drive" {
            drive_ok = ok;
        }
        results.push(GoogleWorkspaceServiceHealth {
            service: service.to_string(),
            ok,
            message,
        });
    }

    let drive_message = if drive_ok {
        "Ready through Drive file access.".to_string()
    } else {
        "Docs and Sheets use Drive file access. Fix Drive first, then test again.".to_string()
    };
    results.push(GoogleWorkspaceServiceHealth {
        service: "Docs".to_string(),
        ok: drive_ok,
        message: drive_message.clone(),
    });
    results.push(GoogleWorkspaceServiceHealth {
        service: "Sheets".to_string(),
        ok: drive_ok,
        message: drive_message,
    });

    Ok(results)
}

fn search_connection_command(
    provider: integration_settings::SearchProvider,
) -> (Vec<&'static str>, Option<&'static str>) {
    match provider {
        integration_settings::SearchProvider::BraveSearch => (
            vec!["web-search", "search", "tessera"],
            Some("TESSERA_BRAVE_SEARCH_API_KEY"),
        ),
        integration_settings::SearchProvider::Tavily => (
            vec!["web-search", "search", "tessera"],
            Some("TESSERA_TAVILY_API_KEY"),
        ),
        integration_settings::SearchProvider::DuckDuckGo => {
            (vec!["web-search", "search", "tessera"], None)
        }
    }
}

fn connection_test_result(
    ok: bool,
    message: String,
    provider: Option<integration_settings::IntegrationProvider>,
    search_provider: Option<integration_settings::SearchProvider>,
) -> integration_settings::IntegrationConnectionTestResult {
    integration_settings::IntegrationConnectionTestResult {
        ok,
        message,
        provider,
        search_provider,
        user: None,
    }
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
                        let _ = app_for_task.emit(&format!("task:event:{}", id_for_task), payload);
                    }
                    _ => break,
                }
            }
            if let Some(s) = app_for_task.try_state::<TaskSubscriptions>() {
                s.handles.lock().unwrap().remove(&id_for_task);
            }
            let _ = app_for_task.emit(&format!("task:event:{}:closed", id_for_task), ());
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

fn canonical_workspace_root(workspace_root: &str) -> anyhow::Result<PathBuf> {
    let workspace_root = workspace_root.trim();
    if workspace_root.is_empty() {
        bail!("workspaceRoot is required");
    }
    let workspace_root = Path::new(workspace_root);
    if !workspace_root.is_absolute() {
        bail!("workspaceRoot must be an absolute path");
    }
    let workspace = fs::canonicalize(workspace_root)
        .with_context(|| format!("Could not access workspace: {}", workspace_root.display()))?;
    if !workspace.is_dir() {
        bail!("Workspace is not a directory: {}", workspace.display());
    }
    Ok(workspace)
}

fn clean_relative_workspace_path(path: &str) -> anyhow::Result<PathBuf> {
    let mut clean_path = PathBuf::new();
    for component in Path::new(path.trim()).components() {
        match component {
            Component::Normal(part) => clean_path.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("Workspace path must stay inside the selected workspace");
            }
        }
    }
    Ok(clean_path)
}

fn path_has_parent_component(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn path_has_hidden_component(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(part) => part.to_string_lossy().starts_with('.'),
        _ => false,
    })
}

fn resolve_workspace_path(
    workspace_root: &str,
    path: &str,
    allow_absolute_path: bool,
) -> anyhow::Result<PathBuf> {
    let workspace = canonical_workspace_root(workspace_root)?;
    let path = path.trim();
    let target = if path.is_empty() {
        workspace.clone()
    } else {
        let requested = Path::new(path);
        if requested.is_absolute() {
            if !allow_absolute_path {
                bail!("Workspace path must be relative");
            }
            if path_has_parent_component(requested) {
                bail!("Workspace path must stay inside the selected workspace");
            }
            requested.to_path_buf()
        } else {
            workspace.join(clean_relative_workspace_path(path)?)
        }
    };
    let target = fs::canonicalize(&target)
        .with_context(|| format!("Could not access path: {}", target.display()))?;
    if !target.starts_with(&workspace) {
        bail!("Workspace path must stay inside the selected workspace");
    }
    Ok(target)
}

fn workspace_relative_child_path(relative_path: &Path, child_name: &str) -> String {
    if relative_path.as_os_str().is_empty() {
        return child_name.to_string();
    }
    format!(
        "{}/{}",
        relative_path.to_string_lossy().replace('\\', "/"),
        child_name
    )
}

fn workspace_dir_list_impl(
    workspace_root: &str,
    relative_path: Option<&str>,
) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
    let relative_path = clean_relative_workspace_path(relative_path.unwrap_or_default())?;
    if path_has_hidden_component(&relative_path) {
        bail!("Hidden workspace paths cannot be listed");
    }
    let target = resolve_workspace_path(
        workspace_root,
        relative_path.to_string_lossy().as_ref(),
        false,
    )?;
    if !target.is_dir() {
        bail!("Workspace path is not a directory: {}", target.display());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&target)
        .with_context(|| format!("Could not read directory: {}", target.display()))?
    {
        let entry = entry?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type()?;
        entries.push(WorkspaceDirEntry {
            relative_path: workspace_relative_child_path(&relative_path, &file_name),
            name: file_name,
            is_directory: file_type.is_dir(),
        });
    }

    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

#[tauri::command]
async fn workspace_dir_list(
    workspace_root: String,
    relative_path: Option<String>,
) -> Result<Vec<WorkspaceDirEntry>, String> {
    workspace_dir_list_impl(&workspace_root, relative_path.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn workspace_file_open(
    app: AppHandle,
    workspace_root: String,
    path: String,
) -> Result<(), String> {
    let target =
        resolve_workspace_path(&workspace_root, &path, true).map_err(|error| error.to_string())?;
    if !target.is_file() {
        return Err(format!("Not a file: {}", target.display()));
    }

    #[allow(deprecated)]
    app.shell()
        .open(target.to_string_lossy().to_string(), None)
        .map_err(|error| error.to_string())
}

// ── Agent Profiles ─────────────────────────────────────────────────────────────

#[tauri::command]
async fn agent_profile_list(
    state: State<'_, SidecarHandle>,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params("/agent-profiles".to_string(), params);
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn agent_profile_get(
    state: State<'_, SidecarHandle>,
    id: String,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params(format!("/agent-profiles/{}", percent_encode(&id)), params);
    let json = state.get(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn agent_profile_create(
    state: State<'_, SidecarHandle>,
    request: serde_json::Value,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params("/agent-profiles".to_string(), params);
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn agent_profile_update(
    state: State<'_, SidecarHandle>,
    id: String,
    request: serde_json::Value,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params(format!("/agent-profiles/{}", percent_encode(&id)), params);
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
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params(format!("/agent-profiles/{}", percent_encode(&id)), params);
    let json = state
        .request("DELETE", &path, None)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn agent_profile_reset(
    state: State<'_, SidecarHandle>,
    id: String,
    user_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = Vec::new();
    push_user_key_param(&mut params, user_key.as_deref())?;
    let path = path_with_params(
        format!("/agent-profiles/{}/reset", percent_encode(&id)),
        params,
    );
    let json = state.post(&path, "{}").await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

// ── Entry point ───────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| setup(app))
        .invoke_handler(tauri::generate_handler![
            agent_profile_list,
            agent_profile_get,
            agent_profile_create,
            agent_profile_update,
            agent_profile_delete,
            agent_profile_reset,
            graph_run_create,
            graph_run_drain,
            graph_run_get,
            graph_run_git_milestone_commit,
            graph_run_git_milestone_preview,
            graph_run_list,
            graph_run_review_surface,
            graph_run_resume,
            inbox_cancel,
            inbox_create,
            inbox_get,
            inbox_list,
            inbox_resolve,
            inbox_snooze,
            browser_runtime_capability_install,
            browser_runtime_capability_status,
            google_identity_connect,
            google_identity_connection_status,
            google_workspace_capability_install,
            google_workspace_capability_status,
            google_workspace_connect,
            google_workspace_connection_status,
            google_workspace_disconnect,
            google_workspace_health,
            google_workspace_oauth_client_delete,
            google_workspace_oauth_client_save,
            google_workspace_oauth_client_status,
            integration_connection_test,
            integration_credential_delete,
            integration_settings_get,
            integration_settings_save,
            memory_forget,
            memory_review_decide,
            memory_review_list,
            memory_status_get,
            model_connection_test,
            model_codex_oauth_device_code,
            model_codex_oauth_poll,
            model_codex_oauth_save,
            model_codex_oauth_status,
            model_credential_delete,
            model_settings_get,
            model_settings_save,
            playbook_get,
            playbook_import,
            playbook_list,
            playbook_preflight,
            playbook_run_preference_get,
            playbook_run_preference_save,
            sidecar_ping,
            skill_get,
            skill_list,
            task_create,
            task_clarify_request,
            task_clarify_resolve,
            task_create_turn,
            task_get,
            task_list,
            task_notify,
            task_skill_add,
            task_skill_remove,
            task_subscribe,
            task_todo_apply,
            task_unsubscribe,
            task_update,
            workspace_dir_list,
            workspace_file_open,
            workspace_style_guide_get,
            workspace_style_guide_save
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

#[cfg(test)]
mod tests {
    use super::{
        connection_test_result, first_useful_process_line, google_identity_auth_args,
        google_workspace_auth_args, google_workspace_config_dir,
        google_workspace_gws_client_secret_path, google_workspace_oauth_client_json,
        google_workspace_oauth_missing_message, normalize_google_workspace_oauth_client_file,
        resolve_google_workspace_cli_path, search_connection_command, tool_policy_runtime_json,
        workspace_cli_uses_google_workspace, CapabilityBinaryResult, SpawnResult,
        GOOGLE_WORKSPACE_AUTH_SCOPES, GOOGLE_WORKSPACE_OAUTH_CLIENT_ID_ENV,
        GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET_ENV,
    };
    use crate::integration_settings::{IntegrationProvider, SearchProvider};
    use std::path::PathBuf;

    fn capability_binary_result(path: Option<&str>) -> CapabilityBinaryResult {
        CapabilityBinaryResult {
            capability_id: "google-workspace-cli".to_string(),
            binary_name: "gws".to_string(),
            path: path.map(str::to_string),
            installed: path.is_some(),
            install_available: true,
            version: "0.22.5".to_string(),
            size_bytes: None,
            message: None,
            progress: None,
        }
    }

    #[test]
    fn workspace_dir_list_returns_visible_relative_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let workspace = dir.path().join("workspace");
        std::fs::create_dir_all(workspace.join("src")).expect("create src");
        std::fs::create_dir_all(workspace.join(".git")).expect("create hidden dir");
        std::fs::write(workspace.join("README.md"), "hello").expect("write file");

        let entries = super::workspace_dir_list_impl(workspace.to_str().unwrap(), None)
            .expect("list workspace");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "src");
        assert_eq!(entries[0].relative_path, "src");
        assert!(entries[0].is_directory);
        assert_eq!(entries[1].name, "README.md");
        assert_eq!(entries[1].relative_path, "README.md");
        assert!(!entries[1].is_directory);
    }

    #[test]
    fn workspace_dir_list_reads_nested_relative_directories() {
        let dir = tempfile::tempdir().expect("tempdir");
        let workspace = dir.path().join("workspace");
        std::fs::create_dir_all(workspace.join("src/nested")).expect("create nested");
        std::fs::write(workspace.join("src/app.ts"), "export {};").expect("write file");

        let entries = super::workspace_dir_list_impl(workspace.to_str().unwrap(), Some("src"))
            .expect("list nested workspace path");

        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec!["src/nested", "src/app.ts"]
        );
    }

    #[test]
    fn workspace_dir_list_rejects_missing_workspace_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("missing");

        let error = super::workspace_dir_list_impl(missing.to_str().unwrap(), None)
            .expect_err("missing workspace should fail");

        assert!(error.to_string().contains("Could not access workspace"));
    }

    #[test]
    fn workspace_dir_list_rejects_file_as_workspace_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let workspace_file = dir.path().join("workspace.txt");
        std::fs::write(&workspace_file, "not a directory").expect("write file");

        let error = super::workspace_dir_list_impl(workspace_file.to_str().unwrap(), None)
            .expect_err("file workspace root should fail");

        assert!(error.to_string().contains("Workspace is not a directory"));
    }

    #[test]
    fn workspace_dir_list_rejects_file_target() {
        let dir = tempfile::tempdir().expect("tempdir");
        let workspace = dir.path().join("workspace");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::write(workspace.join("README.md"), "hello").expect("write file");

        let error = super::workspace_dir_list_impl(workspace.to_str().unwrap(), Some("README.md"))
            .expect_err("file target should fail");

        assert!(error.to_string().contains("not a directory"));
    }

    #[test]
    fn workspace_dir_list_rejects_absolute_relative_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let workspace = dir.path().join("workspace");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::create_dir_all(&outside).expect("create outside");

        let error = super::workspace_dir_list_impl(
            workspace.to_str().unwrap(),
            Some(outside.to_str().unwrap()),
        )
        .expect_err("absolute listing target should fail");

        assert!(error
            .to_string()
            .contains("Workspace path must stay inside the selected workspace"));
    }

    #[test]
    fn workspace_dir_list_rejects_parent_escape() {
        let dir = tempfile::tempdir().expect("tempdir");
        let workspace = dir.path().join("workspace");
        std::fs::create_dir_all(&workspace).expect("create workspace");

        let error = super::workspace_dir_list_impl(workspace.to_str().unwrap(), Some("../outside"))
            .expect_err("parent traversal should fail");

        assert!(error
            .to_string()
            .contains("Workspace path must stay inside the selected workspace"));
    }

    #[cfg(unix)]
    #[test]
    fn workspace_dir_list_rejects_symlink_escape() {
        let dir = tempfile::tempdir().expect("tempdir");
        let workspace = dir.path().join("workspace");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::create_dir_all(&outside).expect("create outside");
        std::os::unix::fs::symlink(&outside, workspace.join("outside-link"))
            .expect("create symlink");

        let error =
            super::workspace_dir_list_impl(workspace.to_str().unwrap(), Some("outside-link"))
                .expect_err("symlink escape should fail");

        assert!(error
            .to_string()
            .contains("Workspace path must stay inside the selected workspace"));
    }

    #[test]
    fn default_task_tool_policies_include_shell_access() {
        for preset in ["read_only", "workspace_editor", "elevated_with_approval"] {
            let tool_policy = tool_policy_runtime_json(preset);
            let allowed_tools = tool_policy
                .get("allowedTools")
                .and_then(|value| value.as_array())
                .expect("allowedTools should be an array");
            assert!(
                allowed_tools
                    .iter()
                    .any(|value| value.as_str() == Some("shell")),
                "preset {preset} should include shell access"
            );

            let capabilities = tool_policy
                .get("capabilities")
                .and_then(|value| value.as_array())
                .expect("capabilities should be an array");
            assert!(
                capabilities
                    .iter()
                    .any(|value| value.as_str() == Some("Search and fetch public web pages")),
                "preset {preset} should advertise web access"
            );
        }
    }

    #[test]
    fn connection_test_result_includes_provenance_fields() {
        let provider_result = connection_test_result(
            true,
            "Connection test succeeded".to_string(),
            Some(IntegrationProvider::GoogleWorkspace),
            None,
        );
        assert_eq!(
            provider_result.provider,
            Some(IntegrationProvider::GoogleWorkspace)
        );
        assert_eq!(provider_result.search_provider, None);

        let search_result = connection_test_result(
            true,
            "Connection test succeeded".to_string(),
            None,
            Some(SearchProvider::Tavily),
        );
        assert_eq!(search_result.provider, None);
        assert_eq!(search_result.search_provider, Some(SearchProvider::Tavily));
    }

    #[test]
    fn search_connection_command_uses_provider_specific_api_key_env() {
        let (args, env_name) = search_connection_command(SearchProvider::BraveSearch);
        assert_eq!(args, vec!["web-search", "search", "tessera"]);
        assert_eq!(env_name, Some("TESSERA_BRAVE_SEARCH_API_KEY"));

        let (args, env_name) = search_connection_command(SearchProvider::Tavily);
        assert_eq!(args, vec!["web-search", "search", "tessera"]);
        assert_eq!(env_name, Some("TESSERA_TAVILY_API_KEY"));

        let (args, env_name) = search_connection_command(SearchProvider::DuckDuckGo);
        assert_eq!(args, vec!["web-search", "search", "tessera"]);
        assert_eq!(env_name, None);
    }

    #[test]
    fn workspace_cli_google_detection_skips_non_workspace_commands() {
        assert!(workspace_cli_uses_google_workspace(&["gcal", "list"]));
        assert!(workspace_cli_uses_google_workspace(&[
            "mail", "read", "msg-1"
        ]));
        assert!(workspace_cli_uses_google_workspace(&[
            "calendar",
            "calendarList",
            "list"
        ]));
        assert!(workspace_cli_uses_google_workspace(&[
            "sheets",
            "rows.upsert",
            "--dry-run"
        ]));
        assert!(workspace_cli_uses_google_workspace(&[
            "docs",
            "documents.create",
            "--dry-run"
        ]));
        assert!(!workspace_cli_uses_google_workspace(&[
            "web-search",
            "search",
            "tessera"
        ]));
        assert!(!workspace_cli_uses_google_workspace(&[
            "web-fetch",
            "fetch",
            "https://example.com"
        ]));
    }

    #[tokio::test]
    async fn google_workspace_cli_path_installs_when_managed_and_bundled_missing() {
        let installed_path = PathBuf::from("/managed/google-workspace-cli/gws");
        let result = resolve_google_workspace_cli_path(
            None,
            || async { Ok::<Option<PathBuf>, anyhow::Error>(None) },
            || async {
                Ok::<CapabilityBinaryResult, anyhow::Error>(capability_binary_result(Some(
                    "/managed/google-workspace-cli/gws",
                )))
            },
        )
        .await
        .expect("resolve gws path");

        assert_eq!(result, installed_path);
    }

    #[tokio::test]
    async fn google_workspace_cli_path_falls_back_to_path_when_install_returns_no_path() {
        let result = resolve_google_workspace_cli_path(
            None,
            || async { Ok::<Option<PathBuf>, anyhow::Error>(None) },
            || async {
                Ok::<CapabilityBinaryResult, anyhow::Error>(capability_binary_result(None))
            },
        )
        .await
        .expect("resolve gws path");

        assert_eq!(
            result,
            PathBuf::from(if cfg!(windows) { "gws.exe" } else { "gws" })
        );
    }

    #[test]
    fn google_workspace_config_dir_is_app_scoped() {
        let app_config = std::path::PathBuf::from("/tmp/tessera-config");
        assert_eq!(
            google_workspace_config_dir(&app_config),
            std::path::PathBuf::from("/tmp/tessera-config/google-workspace")
        );
    }

    #[test]
    fn google_workspace_oauth_client_secret_file_is_scoped_to_gws_config() {
        let config = std::path::PathBuf::from("/tmp/tessera-config/google-workspace");
        assert_eq!(
            google_workspace_gws_client_secret_path(&config),
            std::path::PathBuf::from("/tmp/tessera-config/google-workspace/client_secret.json")
        );
    }

    #[test]
    fn google_workspace_oauth_missing_message_names_build_input() {
        let message = google_workspace_oauth_missing_message();
        assert!(message.contains(GOOGLE_WORKSPACE_OAUTH_CLIENT_ID_ENV));
        assert!(message.contains(GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET_ENV));
        assert!(message.contains("google-workspace-oauth-client.json"));
    }

    #[test]
    fn google_workspace_oauth_client_json_matches_desktop_client_shape() {
        assert_eq!(
            google_workspace_oauth_client_json("client-id", "client-secret"),
            serde_json::json!({
                "installed": {
                    "client_id": "client-id",
                    "project_id": "tessera",
                    "client_secret": "client-secret",
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
                    "redirect_uris": ["http://localhost"]
                }
            })
        );
    }

    #[test]
    fn google_workspace_oauth_client_normalization_adds_project_id() {
        let path =
            std::env::temp_dir().join(format!("tessera-client-secret-{}.json", std::process::id()));
        std::fs::write(
            &path,
            serde_json::json!({
                "installed": {
                    "client_id": "client-id",
                    "client_secret": "client-secret",
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
                    "redirect_uris": ["http://localhost"]
                }
            })
            .to_string(),
        )
        .expect("write temp client");

        normalize_google_workspace_oauth_client_file(&path).expect("normalize");
        let normalized: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read temp"))
                .expect("parse normalized");
        assert_eq!(
            normalized["installed"]["project_id"],
            serde_json::Value::String("tessera".to_string())
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn google_workspace_oauth_client_normalization_removes_utf8_bom() {
        let path = std::env::temp_dir().join(format!(
            "tessera-client-secret-bom-{}.json",
            std::process::id()
        ));
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(
            serde_json::json!({
                "installed": {
                    "client_id": "client-id",
                    "project_id": "tessera",
                    "client_secret": "client-secret",
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
                    "redirect_uris": ["http://localhost"]
                }
            })
            .to_string()
            .as_bytes(),
        );
        std::fs::write(&path, bytes).expect("write temp client");

        normalize_google_workspace_oauth_client_file(&path).expect("normalize");
        let normalized = std::fs::read(&path).expect("read normalized");
        assert!(!normalized.starts_with(&[0xEF, 0xBB, 0xBF]));
        let normalized: serde_json::Value =
            serde_json::from_slice(&normalized).expect("parse normalized");
        assert_eq!(
            normalized["installed"]["project_id"],
            serde_json::Value::String("tessera".to_string())
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn extracts_google_oauth_url_from_cli_output() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&scope=email";
        assert_eq!(
            super::extract_google_oauth_url(&format!("Open this URL:\n<{url}>")),
            Some(url.to_string())
        );
        assert_eq!(super::extract_google_oauth_url("No URL here"), None);
    }

    #[test]
    fn google_workspace_process_message_skips_keyring_noise() {
        let result = SpawnResult {
            stdout: serde_json::json!({
                "error": {
                    "message": "HTTP request failed: dns error: failed to lookup address information"
                }
            })
            .to_string(),
            stderr: "Using keyring backend: keyring\n".to_string(),
            exit_code: 5,
            signal: None,
            duration_ms: 1,
        };
        assert_eq!(
            super::google_workspace_process_message(&result),
            "Google API could not be reached. Check your internet connection."
        );
    }

    #[test]
    fn google_workspace_auth_requests_workspace_read_write_scopes() {
        let args = google_workspace_auth_args();
        assert_eq!(
            args,
            vec!["auth", "login", "--scopes", GOOGLE_WORKSPACE_AUTH_SCOPES]
        );
        assert!(!args.contains(&"--readonly"));
        assert!(!args.contains(&"--full"));

        let scopes: Vec<&str> = GOOGLE_WORKSPACE_AUTH_SCOPES.split(',').collect();
        assert!(scopes.contains(&"https://www.googleapis.com/auth/gmail.compose"));
        assert!(scopes.contains(&"https://www.googleapis.com/auth/spreadsheets"));
        assert!(scopes.contains(&"https://www.googleapis.com/auth/documents"));
        assert!(scopes.contains(&"https://www.googleapis.com/auth/gmail.readonly"));
    }

    #[test]
    fn google_identity_auth_uses_basic_profile_scopes() {
        assert_eq!(
            google_identity_auth_args(),
            vec!["auth", "login", "--scopes", "openid,email,profile"]
        );
    }

    #[test]
    fn google_authenticated_user_prefers_account_email_from_login_output() {
        let dir = tempfile::tempdir().expect("tempdir");
        let result = SpawnResult {
            stdout: serde_json::json!({
                "status": "success",
                "account": "Alex@Example.com"
            })
            .to_string(),
            stderr: String::new(),
            exit_code: 0,
            signal: None,
            duration_ms: 1,
        };
        let same_account_different_case = SpawnResult {
            stdout: serde_json::json!({
                "status": "success",
                "user": "alex@example.com"
            })
            .to_string(),
            stderr: String::new(),
            exit_code: 0,
            signal: None,
            duration_ms: 1,
        };

        let user = super::google_authenticated_user_from_outputs(dir.path(), &[&result])
            .expect("user from account");
        let same_user = super::google_authenticated_user_from_outputs(
            dir.path(),
            &[&same_account_different_case],
        )
        .expect("user from lower-case account");

        assert_eq!(user.email, Some("Alex@Example.com".to_string()));
        assert_eq!(user.user_key, same_user.user_key);
        assert!(user.user_key.starts_with("google-"));
    }

    #[test]
    fn google_authenticated_user_falls_back_to_credential_fingerprint() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("credentials.enc"), b"encrypted-token")
            .expect("write credential fingerprint source");
        let status = SpawnResult {
            stdout: serde_json::json!({ "auth_method": "encrypted" }).to_string(),
            stderr: String::new(),
            exit_code: 0,
            signal: None,
            duration_ms: 1,
        };

        let user = super::google_authenticated_user_from_outputs(dir.path(), &[&status])
            .expect("user from credential fingerprint");

        assert_eq!(user.email, None);
        assert!(user.user_key.starts_with("google-"));
    }

    #[test]
    fn runtime_or_build_env_prefers_non_empty_runtime_values() {
        assert_eq!(
            super::runtime_or_build_env("TESSERA_TEST_MISSING_ENV", Some(" build-value ")),
            Some("build-value".to_string())
        );
    }

    #[test]
    fn optional_capability_env_sources_include_pdf_dependencies() {
        let names: Vec<&str> = super::optional_capability_env_sources()
            .iter()
            .map(|(name, _value)| *name)
            .collect();

        assert!(names.contains(&"TESSERA_PDF_RENDER_URL"));
        assert!(names.contains(&"TESSERA_PDF_RENDER_ARCHIVE_ENTRY"));
        assert!(names.contains(&"TESSERA_PDF_TRANSFORM_URL"));
        assert!(names.contains(&"TESSERA_PDF_TRANSFORM_ARCHIVE_ENTRY"));
        assert!(names.contains(&"TESSERA_PYTHON_RUNNER_URL"));
        assert!(names.contains(&"TESSERA_PYTHON_RUNNER_ARCHIVE_ENTRY"));
    }

    #[test]
    fn first_useful_line_prefers_stderr_then_stdout() {
        let result = SpawnResult {
            stdout: "\nstdout detail\n".to_string(),
            stderr: "\nstderr detail\n".to_string(),
            exit_code: 2,
            signal: None,
            duration_ms: 1,
        };
        assert_eq!(first_useful_process_line(&result), "stderr detail");

        let result = SpawnResult {
            stdout: "\nstdout detail\n".to_string(),
            stderr: "\n".to_string(),
            exit_code: 2,
            signal: None,
            duration_ms: 1,
        };
        assert_eq!(first_useful_process_line(&result), "stdout detail");
    }

    #[test]
    fn google_workspace_auth_message_uses_useful_process_line() {
        let result = SpawnResult {
            stdout: "Open browser to continue\n".to_string(),
            stderr: "".to_string(),
            exit_code: 0,
            signal: None,
            duration_ms: 10,
        };
        assert_eq!(
            first_useful_process_line(&result),
            "Open browser to continue"
        );
    }
}
