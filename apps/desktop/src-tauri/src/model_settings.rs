use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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

pub fn read(app: &AppHandle) -> Result<ModelSettingsRead> {
    redact(load_settings_file(&settings_path(app)?)?)
}

pub fn save(app: &AppHandle, request: ModelSettingsSaveRequest) -> Result<ModelSettingsRead> {
    let path = settings_path(app)?;
    let mut settings = load_settings_file(&path)?;
    let provider = request.provider.provider;

    settings.selected_provider = request.selected_provider;
    settings.providers.insert(provider, request.provider);
    save_settings_file(&path, &settings)?;

    if let Some(credential) = request.credential {
        let api_key = credential.api_key.trim();
        if !api_key.is_empty() {
            set_credential(provider, api_key)?;
        }
    }

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
    }
}
