use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use url::Url;

pub const KEYCHAIN_SERVICE: &str = "Tessera";
pub const SETTINGS_FILE: &str = "model-settings.json";

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

fn keyring_entry(provider: ModelProvider) -> Result<Entry> {
    Entry::new(KEYCHAIN_SERVICE, provider.account()).context("Could not open keychain entry")
}

pub fn get_credential(provider: ModelProvider) -> Result<Option<String>> {
    match keyring_entry(provider)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error).context("Could not read model credential"),
    }
}

fn set_credential(provider: ModelProvider, api_key: &str) -> Result<()> {
    keyring_entry(provider)?
        .set_password(api_key)
        .context("Could not store model credential")
}

pub fn delete_credential(provider: ModelProvider) -> Result<()> {
    match keyring_entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("Could not delete model credential"),
    }
}

fn redact(settings: SettingsFile) -> Result<ModelSettingsRead> {
    let mut providers = BTreeMap::new();

    for (provider, config) in settings.providers {
        let config = normalize_provider_config(config)?;
        providers.insert(
            provider,
            ProviderSettings {
                provider,
                model: config.model,
                base_url: config.base_url,
                has_credential: get_credential(provider)?.is_some(),
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

    if let Some(credential) = request.credential {
        let api_key = credential.api_key.trim();
        if !api_key.is_empty() {
            set_credential(request.provider.provider, api_key)?;
        }
    }

    save_settings_file(&path, &settings)?;
    read(app)
}

pub fn delete(app: &AppHandle, request: ModelCredentialDeleteRequest) -> Result<ModelSettingsRead> {
    delete_credential(request.provider)?;
    read(app)
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
    }
}
