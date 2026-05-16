use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
#[cfg(all(not(target_os = "macos"), not(windows)))]
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use url::Url;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND, FILETIME};
#[cfg(windows)]
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS,
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

pub const KEYCHAIN_SERVICE: &str = "Tessera";
pub const SETTINGS_FILE: &str = "model-settings.json";
static KEYCHAIN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn keychain_lock() -> &'static Mutex<()> {
    KEYCHAIN_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelProvider {
    Openai,
    #[serde(rename = "openai-codex")]
    OpenaiCodex,
    Anthropic,
    Google,
    Openrouter,
    Local,
}

impl ModelProvider {
    pub fn account(self) -> &'static str {
        match self {
            Self::Openai => "model.openai",
            Self::OpenaiCodex => "model.openai-codex",
            Self::Anthropic => "model.anthropic",
            Self::Google => "model.google",
            Self::Openrouter => "model.openrouter",
            Self::Local => "model.local",
        }
    }

    fn account_for_user(self, user_key: Option<&str>) -> String {
        match user_key {
            Some(user_key) => format!("user.{user_key}.{}", self.account()),
            None => self.account().to_string(),
        }
    }

    fn default_model(self) -> &'static str {
        match self {
            Self::Openai => "gpt-5.4",
            Self::OpenaiCodex => "gpt-5.4",
            Self::Anthropic => "claude-sonnet-4-6",
            Self::Google => "gemini-2.5-flash",
            Self::Openrouter => "openai/gpt-5.4",
            Self::Local => "llama3.2",
        }
    }
}

pub fn validate_user_key(user_key: &str) -> Result<&str> {
    if !user_key.is_empty()
        && user_key.len() <= 160
        && user_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Ok(user_key);
    }
    bail!("Invalid user key")
}

fn scoped_user_key(user_key: Option<&str>) -> Result<Option<&str>> {
    user_key.map(validate_user_key).transpose()
}

pub fn user_config_dir(app: &AppHandle, user_key: Option<&str>) -> Result<PathBuf> {
    let app_config_dir = app
        .path()
        .app_config_dir()
        .context("Could not resolve app config dir")?;
    Ok(match scoped_user_key(user_key)? {
        Some(user_key) => app_config_dir.join("users").join(user_key),
        None => app_config_dir,
    })
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub provider: ModelProvider,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub provider: ModelProvider,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    pub has_credential: bool,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    pub selected_provider: ModelProvider,
    pub providers: BTreeMap<ModelProvider, ProviderConfig>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettingsRead {
    pub selected_provider: ModelProvider,
    pub providers: BTreeMap<ModelProvider, ProviderSettings>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInput {
    pub api_key: String,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelConnectionTestRequest {
    pub provider: ProviderConfig,
    pub credential: Option<CredentialInput>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConnectionTestResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettingsSaveRequest {
    pub selected_provider: ModelProvider,
    pub provider: ProviderConfig,
    pub has_existing_credential: bool,
    pub credential: Option<CredentialInput>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelCredentialDeleteRequest {
    pub provider: ModelProvider,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexOAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexOAuthCredential {
    pub tokens: CodexOAuthTokens,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_refresh: Option<String>,
    pub auth_mode: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexOAuthStatus {
    pub logged_in: bool,
    pub reauth_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

pub fn missing_credential_result(provider: ModelProvider) -> ModelConnectionTestResult {
    ModelConnectionTestResult {
        ok: false,
        message: match provider {
            ModelProvider::Local => {
                "Local provider does not require an API key by default".to_string()
            }
            ModelProvider::Openai
            | ModelProvider::Anthropic
            | ModelProvider::Google
            | ModelProvider::Openrouter => {
                "Add an API key in Settings > Model before running this provider".to_string()
            }
            ModelProvider::OpenaiCodex => {
                "Sign in with ChatGPT in Settings > Model before running OpenAI Codex".to_string()
            }
        },
    }
}

pub fn encode_codex_oauth_credential(credential: &CodexOAuthCredential) -> Result<String> {
    serde_json::to_string(credential).context("Could not serialize Codex OAuth credential")
}

pub fn decode_codex_oauth_credential(value: &str) -> Result<CodexOAuthCredential> {
    let credential: CodexOAuthCredential =
        serde_json::from_str(value).context("Could not parse Codex OAuth credential")?;
    if credential.tokens.access_token.trim().is_empty()
        || credential.tokens.refresh_token.trim().is_empty()
    {
        bail!("Codex OAuth credential is missing tokens");
    }
    Ok(credential)
}

pub fn codex_access_token_is_expiring(access_token: &str, skew_seconds: u64) -> bool {
    let Some(claims) = decode_jwt_payload(access_token) else {
        return true;
    };
    let Some(exp) = claims.get("exp").and_then(|value| value.as_u64()) else {
        return true;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(u64::MAX);
    exp <= now.saturating_add(skew_seconds)
}

pub fn codex_chatgpt_account_id(access_token: &str) -> Option<String> {
    let claims = decode_jwt_payload(access_token)?;
    claims
        .get("https://api.openai.com/auth")
        .and_then(|value| value.get("chatgpt_account_id"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
}

pub fn get_codex_oauth_credential_for_user(
    user_key: Option<&str>,
) -> Result<Option<CodexOAuthCredential>> {
    get_credential_for_user(ModelProvider::OpenaiCodex, user_key).and_then(|value| {
        value
            .as_deref()
            .map(decode_codex_oauth_credential)
            .transpose()
    })
}

pub fn set_codex_oauth_credential_for_user(
    user_key: Option<&str>,
    credential: &CodexOAuthCredential,
) -> Result<()> {
    let encoded = encode_codex_oauth_credential(credential)?;
    set_credential_for_user(ModelProvider::OpenaiCodex, user_key, &encoded)
}

pub fn codex_oauth_status_from_credential(
    credential: Option<&CodexOAuthCredential>,
) -> CodexOAuthStatus {
    let Some(credential) = credential else {
        return CodexOAuthStatus {
            logged_in: false,
            reauth_required: false,
            account_id: None,
            base_url: None,
        };
    };
    let reauth_required = codex_access_token_is_expiring(&credential.tokens.access_token, 0)
        || credential.tokens.refresh_token.trim().is_empty();
    CodexOAuthStatus {
        logged_in: !reauth_required,
        reauth_required,
        account_id: codex_chatgpt_account_id(&credential.tokens.access_token),
        base_url: credential.base_url.clone(),
    }
}

pub fn codex_oauth_status_for_user(user_key: Option<&str>) -> Result<CodexOAuthStatus> {
    let credential = get_codex_oauth_credential_for_user(user_key)?;
    Ok(codex_oauth_status_from_credential(credential.as_ref()))
}

pub fn codex_oauth_runtime_credential(credential: &CodexOAuthCredential) -> serde_json::Value {
    let mut value = serde_json::json!({
        "authType": "codex-oauth",
        "accessToken": credential.tokens.access_token,
        "baseUrl": credential
            .base_url
            .as_deref()
            .unwrap_or("https://chatgpt.com/backend-api/codex")
    });
    if let Some(account_id) = codex_chatgpt_account_id(&credential.tokens.access_token) {
        value["accountId"] = serde_json::json!(account_id);
    }
    value
}

fn decode_jwt_payload(access_token: &str) -> Option<serde_json::Value> {
    let payload = access_token.split('.').nth(1)?;
    let bytes = base64url_decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn base64url_decode(input: &str) -> Result<Vec<u8>> {
    let mut buffer = 0u32;
    let mut bits = 0u8;
    let mut output = Vec::new();

    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            b'=' => continue,
            _ => bail!("Invalid base64url character"),
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }

    Ok(output)
}

pub fn default_settings_file() -> SettingsFile {
    let mut providers = BTreeMap::new();

    for provider in [
        ModelProvider::Openai,
        ModelProvider::OpenaiCodex,
        ModelProvider::Anthropic,
        ModelProvider::Google,
        ModelProvider::Openrouter,
        ModelProvider::Local,
    ] {
        providers.insert(
            provider,
            ProviderConfig {
                provider,
                model: provider.default_model().to_string(),
                base_url: (provider == ModelProvider::Local)
                    .then(|| "http://127.0.0.1:11434/v1".to_string()),
            },
        );
    }

    SettingsFile {
        selected_provider: ModelProvider::Openai,
        providers,
    }
}

pub fn settings_path_for_user(app: &AppHandle, user_key: Option<&str>) -> Result<PathBuf> {
    Ok(user_config_dir(app, user_key)?.join(SETTINGS_FILE))
}

pub fn load_settings_file(path: &Path) -> Result<SettingsFile> {
    if !path.exists() {
        return Ok(default_settings_file());
    }

    let text = fs::read_to_string(path).context("Could not read model settings")?;
    let text = text.trim_start_matches('\u{feff}');
    let settings: SettingsFile =
        serde_json::from_str(text).context("Could not parse model settings")?;
    Ok(normalize_settings_file(settings))
}

fn normalize_settings_file(mut settings: SettingsFile) -> SettingsFile {
    let defaults = default_settings_file();
    if let Some(config) = settings.providers.get_mut(&ModelProvider::Google) {
        if config.model == "gemini-2.5-pro" {
            config.model = ModelProvider::Google.default_model().to_string();
        }
    }
    for (provider, config) in defaults.providers {
        settings.providers.entry(provider).or_insert(config);
    }
    if !settings.providers.contains_key(&settings.selected_provider) {
        settings.selected_provider = defaults.selected_provider;
    }
    settings
}

pub fn save_settings_file(path: &Path, settings: &SettingsFile) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("Could not create model settings directory")?;
    }

    let text =
        serde_json::to_string_pretty(settings).context("Could not serialize model settings")?;
    fs::write(path, text).context("Could not write model settings")
}

#[cfg(all(not(target_os = "macos"), not(windows)))]
fn keyring_entry(provider: ModelProvider, user_key: Option<&str>) -> Result<Entry> {
    let account = provider.account_for_user(scoped_user_key(user_key)?);
    Entry::new(KEYCHAIN_SERVICE, &account).context("Could not open keychain entry")
}

pub fn get_credential_for_user(
    provider: ModelProvider,
    user_key: Option<&str>,
) -> Result<Option<String>> {
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        return get_macos_credential(&provider.account_for_user(scoped_user_key(user_key)?));
    }

    #[cfg(windows)]
    {
        return get_windows_credential(&provider.account_for_user(scoped_user_key(user_key)?));
    }

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    match keyring_entry(provider, user_key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error).context("Could not read model credential"),
    }
}

fn set_credential_for_user(
    provider: ModelProvider,
    user_key: Option<&str>,
    api_key: &str,
) -> Result<()> {
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        return set_macos_credential(
            &provider.account_for_user(scoped_user_key(user_key)?),
            api_key,
        );
    }

    #[cfg(windows)]
    {
        return set_windows_credential(
            &provider.account_for_user(scoped_user_key(user_key)?),
            api_key,
        );
    }

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    keyring_entry(provider, user_key)?
        .set_password(api_key)
        .context("Could not store model credential")
}

pub fn delete_credential_for_user(provider: ModelProvider, user_key: Option<&str>) -> Result<()> {
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        return delete_macos_credential(&provider.account_for_user(scoped_user_key(user_key)?));
    }

    #[cfg(windows)]
    {
        return delete_windows_credential(&provider.account_for_user(scoped_user_key(user_key)?));
    }

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    match keyring_entry(provider, user_key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("Could not delete model credential"),
    }
}

#[cfg(windows)]
fn to_wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn to_wide_no_null(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

#[cfg(windows)]
fn windows_credential_target(account: &str) -> String {
    format!("{account}.{KEYCHAIN_SERVICE}")
}

#[cfg(windows)]
fn windows_error_context(action: &str) -> String {
    format!("{action}: Windows error code {}", unsafe { GetLastError() })
}

#[cfg(windows)]
fn get_windows_credential(account: &str) -> Result<Option<String>> {
    get_windows_credential_for_target(&windows_credential_target(account))
}

#[cfg(windows)]
fn get_windows_credential_for_target(target: &str) -> Result<Option<String>> {
    let target = to_wide_null(target);
    let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
    let read = unsafe {
        CredReadW(
            target.as_ptr(),
            CRED_TYPE_GENERIC,
            0,
            &mut credential as *mut _,
        )
    };

    if read == 0 {
        let error = unsafe { GetLastError() };
        if error == ERROR_NOT_FOUND {
            return Ok(None);
        }
        bail!(
            "{}",
            windows_error_context("Could not read model credential")
        );
    }

    let credential_ref = unsafe { &*credential };
    let blob = unsafe {
        std::slice::from_raw_parts(
            credential_ref.CredentialBlob as *const u8,
            credential_ref.CredentialBlobSize as usize,
        )
    };
    if blob.len() % 2 != 0 {
        unsafe { CredFree(credential as *mut _) };
        bail!("Could not read model credential: invalid UTF-16 credential blob");
    }

    let words: Vec<u16> = blob
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    let value = String::from_utf16(&words).context("Could not decode model credential")?;
    unsafe { CredFree(credential as *mut _) };
    Ok(Some(value))
}

#[cfg(windows)]
fn set_windows_credential(account: &str, api_key: &str) -> Result<()> {
    set_windows_credential_for_target(
        &windows_credential_target(account),
        account,
        "Tessera model credential",
        api_key,
    )
}

#[cfg(windows)]
fn set_windows_credential_for_target(
    target: &str,
    username: &str,
    comment: &str,
    api_key: &str,
) -> Result<()> {
    let mut username = to_wide_null(username);
    let mut target = to_wide_null(target);
    let mut comment = to_wide_null(comment);
    let mut secret_words = to_wide_no_null(api_key);
    let mut secret = Vec::with_capacity(secret_words.len() * 2);
    for word in &secret_words {
        secret.extend_from_slice(&word.to_le_bytes());
    }

    let mut credential = CREDENTIALW {
        Flags: CRED_FLAGS::default(),
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        Comment: comment.as_mut_ptr(),
        LastWritten: FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        },
        CredentialBlobSize: secret.len() as u32,
        CredentialBlob: secret.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: std::ptr::null_mut(),
        UserName: username.as_mut_ptr(),
    };

    let written = unsafe { CredWriteW(&mut credential as *mut _, 0) };
    secret.fill(0);
    secret_words.fill(0);
    if written == 0 {
        bail!(
            "{}",
            windows_error_context("Could not store model credential")
        );
    }

    Ok(())
}

#[cfg(windows)]
fn delete_windows_credential(account: &str) -> Result<()> {
    delete_windows_credential_for_target(&windows_credential_target(account))
}

#[cfg(windows)]
fn delete_windows_credential_for_target(target: &str) -> Result<()> {
    let target = to_wide_null(target);
    let deleted = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
    if deleted != 0 {
        return Ok(());
    }

    let error = unsafe { GetLastError() };
    if error == ERROR_NOT_FOUND {
        return Ok(());
    }

    bail!(
        "{}",
        windows_error_context("Could not delete model credential")
    );
}

#[cfg(target_os = "macos")]
fn run_security(args: &[&str]) -> Result<std::process::Output> {
    std::process::Command::new("security")
        .args(args)
        .output()
        .with_context(|| {
            format!(
                "Could not run security command: security {}",
                args.join(" ")
            )
        })
}

#[cfg(target_os = "macos")]
fn security_stderr(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

#[cfg(target_os = "macos")]
fn security_item_missing(output: &std::process::Output) -> bool {
    security_stderr(output).contains("could not be found")
}

#[cfg(target_os = "macos")]
fn get_macos_credential(account: &str) -> Result<Option<String>> {
    let output = run_security(&[
        "find-generic-password",
        "-a",
        account,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
    ])?;

    if output.status.success() {
        let value = String::from_utf8(output.stdout).context("Keychain returned non-UTF8 data")?;
        return Ok(Some(value.trim_end_matches(['\r', '\n']).to_string()));
    }

    if security_item_missing(&output) {
        return Ok(None);
    }

    bail!(
        "Could not read model credential: {}",
        security_stderr(&output)
    );
}

#[cfg(target_os = "macos")]
fn set_macos_credential(account: &str, api_key: &str) -> Result<()> {
    let output = run_security(&[
        "add-generic-password",
        "-a",
        account,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
        api_key,
        "-U",
    ])?;

    if output.status.success() {
        return Ok(());
    }

    bail!(
        "Could not store model credential: {}",
        security_stderr(&output)
    );
}

#[cfg(target_os = "macos")]
fn delete_macos_credential(account: &str) -> Result<()> {
    let output = run_security(&[
        "delete-generic-password",
        "-a",
        account,
        "-s",
        KEYCHAIN_SERVICE,
    ])?;

    if output.status.success() || security_item_missing(&output) {
        return Ok(());
    }

    bail!(
        "Could not delete model credential: {}",
        security_stderr(&output)
    );
}

fn redact_with_known_credentials_for_user(
    settings: SettingsFile,
    known_credentials: BTreeMap<ModelProvider, bool>,
    user_key: Option<&str>,
) -> Result<ModelSettingsRead> {
    let mut providers = BTreeMap::new();

    for (provider, config) in settings.providers {
        let config = normalize_provider_config(config)?;
        providers.insert(
            provider,
            ProviderSettings {
                provider,
                model: config.model,
                base_url: config.base_url,
                has_credential: match known_credentials.get(&provider) {
                    Some(value) => *value,
                    None => get_credential_for_user(provider, user_key)?.is_some(),
                },
            },
        );
    }

    Ok(ModelSettingsRead {
        selected_provider: settings.selected_provider,
        providers,
    })
}

fn normalize_provider_config(mut config: ProviderConfig) -> Result<ProviderConfig> {
    if config.provider != ModelProvider::Local {
        config.base_url = None;
        return Ok(config);
    }

    let base_url = config
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("http://127.0.0.1:11434/v1");
    let parsed = Url::parse(base_url).context("Local provider base URL must be a valid URL")?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        bail!("Local provider base URL must use http or https");
    }

    config.base_url = Some(parsed.to_string());
    Ok(config)
}

pub fn validate_provider_config(config: &ProviderConfig) -> Result<ProviderConfig> {
    normalize_provider_config(config.clone())
}

pub fn selected_provider_config(settings: &SettingsFile) -> Result<ProviderConfig> {
    settings
        .providers
        .get(&settings.selected_provider)
        .cloned()
        .map(normalize_provider_config)
        .transpose()?
        .ok_or_else(|| anyhow::anyhow!("Selected model provider is missing from settings"))
}

pub fn read_for_user(app: &AppHandle, user_key: Option<&str>) -> Result<ModelSettingsRead> {
    redact_with_known_credentials_for_user(
        load_settings_file(&settings_path_for_user(app, user_key)?)?,
        BTreeMap::new(),
        user_key,
    )
}

pub fn validate_save_request(request: &ModelSettingsSaveRequest) -> Result<()> {
    if request.selected_provider != request.provider.provider {
        bail!(
            "Selected provider {:?} does not match provider payload {:?}",
            request.selected_provider,
            request.provider.provider
        );
    }

    Ok(())
}

fn apply_save_request(
    mut settings: SettingsFile,
    request: &ModelSettingsSaveRequest,
) -> Result<SettingsFile> {
    let provider = validate_provider_config(&request.provider)?;
    settings.selected_provider = request.selected_provider;
    settings.providers.insert(provider.provider, provider);
    Ok(settings)
}

pub fn save_for_user(
    app: &AppHandle,
    user_key: Option<&str>,
    request: ModelSettingsSaveRequest,
) -> Result<ModelSettingsRead> {
    let path = settings_path_for_user(app, user_key)?;
    validate_save_request(&request)?;
    let settings = apply_save_request(load_settings_file(&path)?, &request)?;
    let mut known_credentials = BTreeMap::new();
    known_credentials.insert(
        request.provider.provider,
        request
            .credential
            .as_ref()
            .map(|credential| !credential.api_key.trim().is_empty())
            .unwrap_or(request.has_existing_credential),
    );

    if let Some(credential) = request.credential {
        let api_key = credential.api_key.trim();
        if !api_key.is_empty() {
            set_credential_for_user(request.provider.provider, user_key, api_key)?;
        }
    }

    save_settings_file(&path, &settings)?;
    redact_with_known_credentials_for_user(settings, known_credentials, user_key)
}

pub fn delete_for_user(
    app: &AppHandle,
    user_key: Option<&str>,
    request: ModelCredentialDeleteRequest,
) -> Result<ModelSettingsRead> {
    let path = settings_path_for_user(app, user_key)?;
    let settings = load_settings_file(&path)?;
    delete_credential_for_user(request.provider, user_key)?;
    let mut known_credentials = BTreeMap::new();
    known_credentials.insert(request.provider, false);
    redact_with_known_credentials_for_user(settings, known_credentials, user_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    mod model_settings {
        use super::*;

        #[test]
        fn provider_accounts_are_stable() {
            assert_eq!(KEYCHAIN_SERVICE, "Tessera");
            assert_eq!(ModelProvider::Openai.account(), "model.openai");
            assert_eq!(ModelProvider::OpenaiCodex.account(), "model.openai-codex");
            assert_eq!(ModelProvider::Anthropic.account(), "model.anthropic");
            assert_eq!(ModelProvider::Google.account(), "model.google");
            assert_eq!(ModelProvider::Openrouter.account(), "model.openrouter");
            assert_eq!(ModelProvider::Local.account(), "model.local");
        }

        #[test]
        fn default_settings_are_global_and_openai_first() {
            let settings = default_settings_file();

            assert_eq!(settings.selected_provider, ModelProvider::Openai);
            assert_eq!(settings.providers.len(), 6);
            assert_eq!(
                settings
                    .providers
                    .get(&ModelProvider::OpenaiCodex)
                    .map(|provider| provider.model.as_str()),
                Some("gpt-5.4")
            );
            assert_eq!(
                settings
                    .providers
                    .get(&ModelProvider::Local)
                    .and_then(|provider| provider.base_url.as_deref()),
                Some("http://127.0.0.1:11434/v1")
            );
        }

        #[test]
        fn load_settings_file_backfills_new_providers_for_existing_settings() {
            let dir = tempfile::tempdir().expect("tempdir");
            let path = dir.path().join(SETTINGS_FILE);
            fs::write(
                &path,
                r#"{
                  "selectedProvider": "openai",
                  "providers": {
                    "openai": { "provider": "openai", "model": "gpt-5.4" },
                    "anthropic": { "provider": "anthropic", "model": "claude-sonnet-4-6" },
                    "openrouter": { "provider": "openrouter", "model": "openai/gpt-5.4" },
                    "local": {
                      "provider": "local",
                      "model": "llama3.2",
                      "baseUrl": "http://127.0.0.1:11434/v1"
                    }
                  }
                }"#,
            )
            .expect("write old settings");

            let settings = load_settings_file(&path).expect("load");

            assert_eq!(
                settings.providers.get(&ModelProvider::Google),
                Some(&ProviderConfig {
                    provider: ModelProvider::Google,
                    model: "gemini-2.5-flash".to_string(),
                    base_url: None,
                })
            );
        }

        #[test]
        fn load_settings_file_migrates_legacy_google_pro_default_to_flash() {
            let dir = tempfile::tempdir().expect("tempdir");
            let path = dir.path().join(SETTINGS_FILE);
            fs::write(
                &path,
                r#"{
                  "selectedProvider": "google",
                  "providers": {
                    "openai": { "provider": "openai", "model": "gpt-5.4" },
                    "openai-codex": { "provider": "openai-codex", "model": "gpt-5.4" },
                    "anthropic": { "provider": "anthropic", "model": "claude-sonnet-4-6" },
                    "google": { "provider": "google", "model": "gemini-2.5-pro" },
                    "openrouter": { "provider": "openrouter", "model": "openai/gpt-5.4" },
                    "local": {
                      "provider": "local",
                      "model": "llama3.2",
                      "baseUrl": "http://127.0.0.1:11434/v1"
                    }
                  }
                }"#,
            )
            .expect("write legacy settings");

            let settings = load_settings_file(&path).expect("load");

            assert_eq!(
                settings
                    .providers
                    .get(&ModelProvider::Google)
                    .map(|provider| provider.model.as_str()),
                Some("gemini-2.5-flash")
            );
        }

        #[test]
        fn load_settings_file_accepts_utf8_bom() {
            let dir = tempfile::tempdir().expect("tempdir");
            let path = dir.path().join(SETTINGS_FILE);
            fs::write(
                &path,
                concat!(
                    "\u{feff}",
                    r#"{
                      "selectedProvider": "google",
                      "providers": {
                        "google": { "provider": "google", "model": "gemini-2.5-flash" }
                      }
                    }"#
                ),
            )
            .expect("write bom settings");

            let settings = load_settings_file(&path).expect("load");

            assert_eq!(settings.selected_provider, ModelProvider::Google);
            assert_eq!(
                settings
                    .providers
                    .get(&ModelProvider::Google)
                    .map(|provider| provider.model.as_str()),
                Some("gemini-2.5-flash")
            );
        }

        #[test]
        fn file_round_trip_preserves_non_secret_settings() {
            let dir = tempfile::tempdir().expect("tempdir");
            let path = dir.path().join(SETTINGS_FILE);
            let settings = default_settings_file();

            save_settings_file(&path, &settings).expect("save");
            let loaded = load_settings_file(&path).expect("load");

            assert_eq!(loaded, settings);
        }

        #[test]
        fn load_settings_file_backfills_providers_added_after_existing_installs() {
            let dir = tempfile::tempdir().expect("tempdir");
            let path = dir.path().join(SETTINGS_FILE);
            let legacy = serde_json::json!({
                "selectedProvider": "openai",
                "providers": {
                    "openai": {
                        "provider": "openai",
                        "model": "gpt-4.1"
                    },
                    "anthropic": {
                        "provider": "anthropic",
                        "model": "claude-sonnet-4-6"
                    },
                    "openrouter": {
                        "provider": "openrouter",
                        "model": "openai/gpt-5.4"
                    },
                    "local": {
                        "provider": "local",
                        "model": "llama3.2",
                        "baseUrl": "http://127.0.0.1:11434/v1"
                    }
                }
            });
            fs::write(
                &path,
                serde_json::to_string_pretty(&legacy).expect("legacy json"),
            )
            .expect("write legacy settings");

            let loaded = load_settings_file(&path).expect("load");

            assert_eq!(loaded.selected_provider, ModelProvider::Openai);
            assert_eq!(
                loaded
                    .providers
                    .get(&ModelProvider::Openai)
                    .map(|provider| provider.model.as_str()),
                Some("gpt-4.1")
            );
            assert_eq!(
                loaded
                    .providers
                    .get(&ModelProvider::OpenaiCodex)
                    .map(|provider| provider.model.as_str()),
                Some("gpt-5.4")
            );
        }

        #[test]
        fn validate_save_request_rejects_mismatched_selected_provider() {
            let request = ModelSettingsSaveRequest {
                selected_provider: ModelProvider::Openai,
                provider: ProviderConfig {
                    provider: ModelProvider::Anthropic,
                    model: "claude-sonnet-4-6".to_string(),
                    base_url: None,
                },
                has_existing_credential: false,
                credential: None,
            };

            let error = validate_save_request(&request).expect_err("mismatch should fail");

            assert!(error
                .to_string()
                .contains("Selected provider Openai does not match provider payload Anthropic"));
        }

        #[test]
        fn apply_save_request_updates_selected_provider_and_target_provider() {
            let request = ModelSettingsSaveRequest {
                selected_provider: ModelProvider::Local,
                provider: ProviderConfig {
                    provider: ModelProvider::Local,
                    model: "llama3.3".to_string(),
                    base_url: Some("http://localhost:9000/v1".to_string()),
                },
                has_existing_credential: false,
                credential: None,
            };

            let updated = apply_save_request(default_settings_file(), &request).expect("apply");

            assert_eq!(updated.selected_provider, ModelProvider::Local);
            assert_eq!(
                updated.providers.get(&ModelProvider::Local),
                Some(&request.provider)
            );
        }

        #[test]
        fn redact_backfills_missing_local_base_url() {
            let mut settings = default_settings_file();
            settings
                .providers
                .get_mut(&ModelProvider::Local)
                .expect("local provider")
                .base_url = None;

            let read =
                redact_with_known_credentials_for_user(settings, BTreeMap::new(), None)
                    .expect("redact");

            assert_eq!(
                read.providers
                    .get(&ModelProvider::Local)
                    .and_then(|provider| provider.base_url.as_deref()),
                Some("http://127.0.0.1:11434/v1")
            );
        }

        #[test]
        fn validate_provider_config_rejects_invalid_local_base_url() {
            let config = ProviderConfig {
                provider: ModelProvider::Local,
                model: "llama3.2".to_string(),
                base_url: Some("not a url".to_string()),
            };

            let error = validate_provider_config(&config).expect_err("invalid URL should fail");

            assert!(error.to_string().contains("valid URL"));
        }

        #[test]
        fn validate_provider_config_requires_http_local_base_url() {
            let config = ProviderConfig {
                provider: ModelProvider::Local,
                model: "llama3.2".to_string(),
                base_url: Some("file:///tmp/model".to_string()),
            };

            let error = validate_provider_config(&config).expect_err("file URL should fail");

            assert!(error.to_string().contains("http or https"));
        }

        #[test]
        fn missing_cloud_credential_message_points_to_settings() {
            let result = missing_credential_result(ModelProvider::OpenaiCodex);

            assert!(!result.ok);
            assert!(result.message.contains("Sign in with ChatGPT"));
        }

        #[test]
        fn selected_provider_config_returns_selected_provider() {
            let settings = default_settings_file();
            let provider = selected_provider_config(&settings).expect("selected provider");

            assert_eq!(provider.provider, ModelProvider::Openai);
        }

        #[test]
        fn redact_with_known_credentials_uses_overrides_without_keychain_reads() {
            let settings = default_settings_file();
            let mut known_credentials = BTreeMap::new();
            known_credentials.insert(ModelProvider::Openai, true);
            known_credentials.insert(ModelProvider::OpenaiCodex, false);
            known_credentials.insert(ModelProvider::Anthropic, false);
            known_credentials.insert(ModelProvider::Google, false);
            known_credentials.insert(ModelProvider::Openrouter, false);
            known_credentials.insert(ModelProvider::Local, false);

            let read =
                redact_with_known_credentials_for_user(settings, known_credentials, None)
                    .expect("redact");

            assert_eq!(
                read.providers
                    .get(&ModelProvider::Openai)
                    .map(|provider| provider.has_credential),
                Some(true)
            );
        }

        #[test]
        fn codex_oauth_credential_round_trips_as_keychain_json() {
            let credential = CodexOAuthCredential {
                tokens: CodexOAuthTokens {
                    access_token: unsigned_jwt_with_payload(
                        r#"{"exp":4102444800,"https://api.openai.com/auth":{"chatgpt_account_id":"acct_test"}}"#,
                    ),
                    refresh_token: "refresh-test".to_string(),
                },
                base_url: Some("https://chatgpt.com/backend-api/codex".to_string()),
                last_refresh: Some("2026-05-12T00:00:00Z".to_string()),
                auth_mode: "chatgpt".to_string(),
            };

            let encoded = encode_codex_oauth_credential(&credential).expect("encode");
            let decoded = decode_codex_oauth_credential(&encoded).expect("decode");

            assert_eq!(decoded, credential);
            assert_eq!(
                codex_chatgpt_account_id(&decoded.tokens.access_token),
                Some("acct_test".to_string())
            );
            assert!(!codex_access_token_is_expiring(
                &decoded.tokens.access_token,
                120
            ));
        }

        #[test]
        fn codex_access_token_expiry_treats_malformed_or_expiring_tokens_as_expiring() {
            let expired = unsigned_jwt_with_payload(r#"{"exp":1}"#);
            let malformed = "not-a-jwt";

            assert!(codex_access_token_is_expiring(&expired, 120));
            assert!(codex_access_token_is_expiring(malformed, 120));
        }

        #[test]
        fn codex_status_redacts_tokens_and_reports_account() {
            let credential = CodexOAuthCredential {
                tokens: CodexOAuthTokens {
                    access_token: unsigned_jwt_with_payload(
                        r#"{"exp":4102444800,"https://api.openai.com/auth":{"chatgpt_account_id":"acct_test"}}"#,
                    ),
                    refresh_token: "refresh-test".to_string(),
                },
                base_url: Some("https://chatgpt.com/backend-api/codex".to_string()),
                last_refresh: None,
                auth_mode: "chatgpt".to_string(),
            };

            let status = codex_oauth_status_from_credential(Some(&credential));

            assert!(status.logged_in);
            assert!(!status.reauth_required);
            assert_eq!(status.account_id, Some("acct_test".to_string()));
            assert_eq!(
                status.base_url,
                Some("https://chatgpt.com/backend-api/codex".to_string())
            );
        }

        #[test]
        fn codex_runtime_credential_uses_oauth_shape_without_refresh_token() {
            let credential = CodexOAuthCredential {
                tokens: CodexOAuthTokens {
                    access_token: unsigned_jwt_with_payload(
                        r#"{"exp":4102444800,"https://api.openai.com/auth":{"chatgpt_account_id":"acct_test"}}"#,
                    ),
                    refresh_token: "refresh-test".to_string(),
                },
                base_url: Some("https://chatgpt.com/backend-api/codex".to_string()),
                last_refresh: None,
                auth_mode: "chatgpt".to_string(),
            };

            let runtime = codex_oauth_runtime_credential(&credential);

            assert_eq!(runtime["authType"], "codex-oauth");
            assert_eq!(runtime["accessToken"], credential.tokens.access_token);
            assert_eq!(runtime["accountId"], "acct_test");
            assert!(runtime.get("refreshToken").is_none());
        }

        fn unsigned_jwt_with_payload(payload: &str) -> String {
            format!("header.{}.", base64url_no_pad(payload.as_bytes()))
        }

        fn base64url_no_pad(input: &[u8]) -> String {
            const TABLE: &[u8; 64] =
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let mut out = String::new();
            let mut index = 0;
            while index < input.len() {
                let a = input[index];
                let b = input.get(index + 1).copied();
                let c = input.get(index + 2).copied();

                out.push(TABLE[(a >> 2) as usize] as char);
                out.push(
                    TABLE[(((a & 0b0000_0011) << 4) | (b.unwrap_or(0) >> 4)) as usize] as char,
                );
                if let Some(b) = b {
                    out.push(
                        TABLE[(((b & 0b0000_1111) << 2) | (c.unwrap_or(0) >> 6)) as usize] as char,
                    );
                }
                if let Some(c) = c {
                    out.push(TABLE[(c & 0b0011_1111) as usize] as char);
                }

                index += 3;
            }
            out
        }

        #[test]
        #[ignore]
        #[cfg(windows)]
        fn windows_credential_round_trips_through_credential_manager() {
            let target = format!(
                "tessera.test.{}.{}",
                std::process::id(),
                std::thread::current().name().unwrap_or("model-settings")
            );
            delete_windows_credential_for_target(&target).expect("clear old test credential");
            set_windows_credential_for_target(
                &target,
                "model.test",
                "Tessera test model credential",
                "secret-test",
            )
            .expect("store test credential");

            let credential =
                get_windows_credential_for_target(&target).expect("read test credential");

            assert_eq!(credential.as_deref(), Some("secret-test"));
            delete_windows_credential_for_target(&target).expect("cleanup test credential");
        }
    }
}
