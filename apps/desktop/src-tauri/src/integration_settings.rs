use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{bail, Context, Result};
#[cfg(not(target_os = "macos"))]
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::model_settings::KEYCHAIN_SERVICE;

pub const SETTINGS_FILE: &str = "integration-settings.json";
static KEYCHAIN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn keychain_lock() -> &'static Mutex<()> {
    KEYCHAIN_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntegrationProvider {
    BraveSearch,
}

impl IntegrationProvider {
    pub fn account(self) -> &'static str {
        match self {
            Self::BraveSearch => "integration.brave-search",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::BraveSearch => "Brave Search",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub provider: IntegrationProvider,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub provider: IntegrationProvider,
    pub has_credential: bool,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsProviders {
    pub brave_search: ProviderConfig,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    pub providers: SettingsProviders,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadProviders {
    pub brave_search: ProviderSettings,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationSettingsRead {
    pub providers: ReadProviders,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInput {
    pub api_key: String,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationSettingsSaveRequest {
    pub provider: IntegrationProvider,
    pub has_existing_credential: bool,
    pub credential: Option<CredentialInput>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationCredentialDeleteRequest {
    pub provider: IntegrationProvider,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationConnectionTestRequest {
    pub provider: IntegrationProvider,
    pub credential: Option<CredentialInput>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationConnectionTestResult {
    pub ok: bool,
    pub message: String,
}

pub fn missing_credential_result(provider: IntegrationProvider) -> IntegrationConnectionTestResult {
    IntegrationConnectionTestResult {
        ok: false,
        message: format!(
            "Add an API key in Settings > Integrations before using {}.",
            provider.label()
        ),
    }
}

pub fn default_settings_file() -> SettingsFile {
    SettingsFile {
        providers: SettingsProviders {
            brave_search: ProviderConfig {
                provider: IntegrationProvider::BraveSearch,
            },
        },
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .context("Could not resolve app config dir")?
        .join(SETTINGS_FILE))
}

fn load_settings_file(path: &Path) -> Result<SettingsFile> {
    if !path.exists() {
        return Ok(default_settings_file());
    }

    let text = fs::read_to_string(path).context("Could not read integration settings")?;
    serde_json::from_str(&text).context("Could not parse integration settings")
}

fn save_settings_file(path: &Path, settings: &SettingsFile) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("Could not create integration settings directory")?;
    }

    let text =
        serde_json::to_string_pretty(settings).context("Could not serialize integration settings")?;
    fs::write(path, text).context("Could not write integration settings")
}

#[cfg(not(target_os = "macos"))]
fn keyring_entry(provider: IntegrationProvider) -> Result<Entry> {
    Entry::new(KEYCHAIN_SERVICE, provider.account()).context("Could not open keychain entry")
}

pub fn get_credential(provider: IntegrationProvider) -> Result<Option<String>> {
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        return get_macos_credential(provider);
    }

    #[cfg(not(target_os = "macos"))]
    match keyring_entry(provider)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error).context("Could not read integration credential"),
    }
}

fn set_credential(provider: IntegrationProvider, api_key: &str) -> Result<()> {
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        return set_macos_credential(provider, api_key);
    }

    #[cfg(not(target_os = "macos"))]
    keyring_entry(provider)?
        .set_password(api_key)
        .context("Could not store integration credential")
}

pub fn delete_credential(provider: IntegrationProvider) -> Result<()> {
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        return delete_macos_credential(provider);
    }

    #[cfg(not(target_os = "macos"))]
    match keyring_entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("Could not delete integration credential"),
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
fn get_macos_credential(provider: IntegrationProvider) -> Result<Option<String>> {
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

    bail!(
        "Could not read integration credential: {}",
        security_stderr(&output)
    );
}

#[cfg(target_os = "macos")]
fn set_macos_credential(provider: IntegrationProvider, api_key: &str) -> Result<()> {
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

    bail!(
        "Could not store integration credential: {}",
        security_stderr(&output)
    );
}

#[cfg(target_os = "macos")]
fn delete_macos_credential(provider: IntegrationProvider) -> Result<()> {
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

    bail!(
        "Could not delete integration credential: {}",
        security_stderr(&output)
    );
}

fn redact(_settings: SettingsFile) -> Result<IntegrationSettingsRead> {
    Ok(IntegrationSettingsRead {
        providers: ReadProviders {
            brave_search: ProviderSettings {
                provider: IntegrationProvider::BraveSearch,
                has_credential: get_credential(IntegrationProvider::BraveSearch)?.is_some(),
            },
        },
    })
}

pub fn read(app: &AppHandle) -> Result<IntegrationSettingsRead> {
    let path = settings_path(app)?;
    let settings = load_settings_file(&path)?;
    redact(settings)
}

pub fn save(app: &AppHandle, request: IntegrationSettingsSaveRequest) -> Result<IntegrationSettingsRead> {
    let path = settings_path(app)?;
    let settings = load_settings_file(&path)?;

    if let Some(credential) = request.credential {
        let api_key = credential.api_key.trim();
        if api_key.is_empty() {
            bail!("API key cannot be empty");
        }
        set_credential(request.provider, api_key)?;
    }

    save_settings_file(&path, &settings)?;
    read(app)
}

pub fn delete(
    app: &AppHandle,
    request: IntegrationCredentialDeleteRequest,
) -> Result<IntegrationSettingsRead> {
    let path = settings_path(app)?;
    let settings = load_settings_file(&path)?;
    delete_credential(request.provider)?;
    save_settings_file(&path, &settings)?;
    read(app)
}
