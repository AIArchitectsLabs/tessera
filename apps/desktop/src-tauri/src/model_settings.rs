use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{bail, Context, Result};
#[cfg(not(target_os = "macos"))]
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use url::Url;

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
    Anthropic,
    Openrouter,
    Local,
}

impl ModelProvider {
    pub fn account(self) -> &'static str {
        match self {
            Self::Openai => "model.openai",
            Self::Anthropic => "model.anthropic",
            Self::Openrouter => "model.openrouter",
            Self::Local => "model.local",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Openrouter => "openrouter",
            Self::Local => "local",
        }
    }

    fn default_model(self) -> &'static str {
        match self {
            Self::Openai => "gpt-5.4",
            Self::Anthropic => "claude-sonnet-4-6",
            Self::Openrouter => "openai/gpt-5.4",
            Self::Local => "llama3.2",
        }
    }
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

pub fn missing_credential_result(provider: ModelProvider) -> ModelConnectionTestResult {
    ModelConnectionTestResult {
        ok: false,
        message: match provider {
            ModelProvider::Local => {
                "Local provider does not require an API key by default".to_string()
            }
            ModelProvider::Openai | ModelProvider::Anthropic | ModelProvider::Openrouter => {
                "Add an API key in Settings > Model before running this provider".to_string()
            }
        },
    }
}

pub fn default_settings_file() -> SettingsFile {
    let mut providers = BTreeMap::new();

    for provider in [
        ModelProvider::Openai,
        ModelProvider::Anthropic,
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

fn settings_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .context("Could not resolve app config dir")?
        .join(SETTINGS_FILE))
}

pub fn load_settings_file(path: &Path) -> Result<SettingsFile> {
    if !path.exists() {
        return Ok(default_settings_file());
    }

    let text = fs::read_to_string(path).context("Could not read model settings")?;
    serde_json::from_str(&text).context("Could not parse model settings")
}

pub fn save_settings_file(path: &Path, settings: &SettingsFile) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("Could not create model settings directory")?;
    }

    let text =
        serde_json::to_string_pretty(settings).context("Could not serialize model settings")?;
    fs::write(path, text).context("Could not write model settings")
}

#[cfg(not(target_os = "macos"))]
fn keyring_entry(provider: ModelProvider) -> Result<Entry> {
    Entry::new(KEYCHAIN_SERVICE, provider.account()).context("Could not open keychain entry")
}

pub fn get_credential(provider: ModelProvider) -> Result<Option<String>> {
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        return get_macos_credential(provider);
    }

    #[cfg(not(target_os = "macos"))]
    match keyring_entry(provider)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error).context("Could not read model credential"),
    }
}

fn set_credential(provider: ModelProvider, api_key: &str) -> Result<()> {
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        return set_macos_credential(provider, api_key);
    }

    #[cfg(not(target_os = "macos"))]
    keyring_entry(provider)?
        .set_password(api_key)
        .context("Could not store model credential")
}

pub fn delete_credential(provider: ModelProvider) -> Result<()> {
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        return delete_macos_credential(provider);
    }

    #[cfg(not(target_os = "macos"))]
    match keyring_entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("Could not delete model credential"),
    }
}

#[cfg(target_os = "macos")]
fn run_security(args: &[&str]) -> Result<std::process::Output> {
    std::process::Command::new("security")
        .args(args)
        .output()
        .with_context(|| format!("Could not run security command: security {}", args.join(" ")))
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
fn get_macos_credential(provider: ModelProvider) -> Result<Option<String>> {
    let output = run_security(&[
        "find-generic-password",
        "-a",
        provider.account(),
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

    bail!("Could not read model credential: {}", security_stderr(&output));
}

#[cfg(target_os = "macos")]
fn set_macos_credential(provider: ModelProvider, api_key: &str) -> Result<()> {
    let output = run_security(&[
        "add-generic-password",
        "-a",
        provider.account(),
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
        api_key,
        "-U",
    ])?;

    if output.status.success() {
        return Ok(());
    }

    bail!("Could not store model credential: {}", security_stderr(&output));
}

#[cfg(target_os = "macos")]
fn delete_macos_credential(provider: ModelProvider) -> Result<()> {
    let output = run_security(&[
        "delete-generic-password",
        "-a",
        provider.account(),
        "-s",
        KEYCHAIN_SERVICE,
    ])?;

    if output.status.success() || security_item_missing(&output) {
        return Ok(());
    }

    bail!("Could not delete model credential: {}", security_stderr(&output));
}

fn redact(settings: SettingsFile) -> Result<ModelSettingsRead> {
    redact_with_known_credentials(settings, BTreeMap::new())
}

fn redact_with_known_credentials(
    settings: SettingsFile,
    known_credentials: BTreeMap<ModelProvider, bool>,
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
                    None => get_credential(provider)?.is_some(),
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

pub fn read(app: &AppHandle) -> Result<ModelSettingsRead> {
    redact(load_settings_file(&settings_path(app)?)?)
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

pub fn save(app: &AppHandle, request: ModelSettingsSaveRequest) -> Result<ModelSettingsRead> {
    let path = settings_path(app)?;
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
            set_credential(request.provider.provider, api_key)?;
        }
    }

    save_settings_file(&path, &settings)?;
    redact_with_known_credentials(settings, known_credentials)
}

pub fn delete(app: &AppHandle, request: ModelCredentialDeleteRequest) -> Result<ModelSettingsRead> {
    let path = settings_path(app)?;
    let settings = load_settings_file(&path)?;
    delete_credential(request.provider)?;
    let mut known_credentials = BTreeMap::new();
    known_credentials.insert(request.provider, false);
    redact_with_known_credentials(settings, known_credentials)
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
            assert_eq!(ModelProvider::Anthropic.account(), "model.anthropic");
            assert_eq!(ModelProvider::Openrouter.account(), "model.openrouter");
            assert_eq!(ModelProvider::Local.account(), "model.local");
        }

        #[test]
        fn default_settings_are_global_and_openai_first() {
            let settings = default_settings_file();

            assert_eq!(settings.selected_provider, ModelProvider::Openai);
            assert_eq!(settings.providers.len(), 4);
            assert_eq!(
                settings
                    .providers
                    .get(&ModelProvider::Local)
                    .and_then(|provider| provider.base_url.as_deref()),
                Some("http://127.0.0.1:11434/v1")
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

            let read = redact(settings).expect("redact");

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
            let result = missing_credential_result(ModelProvider::Openai);

            assert!(!result.ok);
            assert!(result.message.contains("Settings > Model"));
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
            known_credentials.insert(ModelProvider::Anthropic, false);
            known_credentials.insert(ModelProvider::Openrouter, false);
            known_credentials.insert(ModelProvider::Local, false);

            let read = redact_with_known_credentials(settings, known_credentials).expect("redact");

            assert_eq!(
                read.providers
                    .get(&ModelProvider::Openai)
                    .map(|provider| provider.has_credential),
                Some(true)
            );
        }
    }
}
