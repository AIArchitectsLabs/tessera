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
    GoogleWorkspace,
}

impl IntegrationProvider {
    pub fn account(self) -> &'static str {
        match self {
            Self::BraveSearch => "integration.brave-search",
            Self::GoogleWorkspace => "integration.google-workspace",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::BraveSearch => "Brave Search",
            Self::GoogleWorkspace => "Google Workspace",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SearchProvider {
    BraveSearch,
    Tavily,
    DuckDuckGo,
}

impl SearchProvider {
    pub fn account(self) -> &'static str {
        match self {
            Self::BraveSearch => "integration.brave-search",
            Self::Tavily => "integration.tavily",
            Self::DuckDuckGo => "integration.duckduckgo",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::BraveSearch => "Brave Search",
            Self::Tavily => "Tavily",
            Self::DuckDuckGo => "DuckDuckGo",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SearchMode {
    Auto,
    BraveSearch,
    Tavily,
    DuckDuckGo,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub provider: IntegrationProvider,
    #[serde(default)]
    pub connected: bool,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub provider: IntegrationProvider,
    pub has_credential: bool,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProviderSettings {
    pub provider: SearchProvider,
    pub has_credential: bool,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsProviders {
    #[serde(default = "default_brave_search_provider_config")]
    pub brave_search: ProviderConfig,
    #[serde(default = "default_google_workspace_provider_config")]
    pub google_workspace: ProviderConfig,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSettings {
    #[serde(default = "default_search_mode")]
    pub mode: SearchMode,
    #[serde(default)]
    pub allow_keyless_fallback: bool,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    pub providers: SettingsProviders,
    #[serde(default = "default_search_settings")]
    pub search: SearchSettings,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadProviders {
    pub brave_search: ProviderSettings,
    pub google_workspace: ProviderSettings,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationSettingsRead {
    pub providers: ReadProviders,
    pub search: SearchSettingsRead,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSettingsRead {
    pub mode: SearchMode,
    pub allow_keyless_fallback: bool,
    pub providers: SearchProvidersRead,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProvidersRead {
    pub brave_search: SearchProviderSettings,
    pub tavily: SearchProviderSettings,
    pub duckduckgo: SearchProviderSettings,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInput {
    pub api_key: String,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum IntegrationRequestTarget {
    Integration(IntegrationProvider),
    Search(SearchProvider),
}

fn validate_request_target(
    provider: Option<IntegrationProvider>,
    search_provider: Option<SearchProvider>,
) -> Result<IntegrationRequestTarget> {
    match (provider, search_provider) {
        (Some(provider), None) => Ok(IntegrationRequestTarget::Integration(provider)),
        (None, Some(search_provider)) => Ok(IntegrationRequestTarget::Search(search_provider)),
        (Some(_), Some(_)) => {
            bail!("provider and searchProvider cannot be combined in the same request")
        }
        (None, None) => bail!("Either provider or searchProvider is required"),
    }
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationSettingsSaveRequest {
    pub provider: Option<IntegrationProvider>,
    #[serde(default)]
    pub search_provider: Option<SearchProvider>,
    pub has_existing_credential: bool,
    pub credential: Option<CredentialInput>,
    #[serde(default)]
    pub search: Option<SearchSettings>,
}

impl IntegrationSettingsSaveRequest {
    pub fn target(&self) -> Result<IntegrationRequestTarget> {
        validate_request_target(self.provider, self.search_provider)
    }
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationCredentialDeleteRequest {
    pub provider: Option<IntegrationProvider>,
    #[serde(default)]
    pub search_provider: Option<SearchProvider>,
}

impl IntegrationCredentialDeleteRequest {
    pub fn target(&self) -> Result<IntegrationRequestTarget> {
        validate_request_target(self.provider, self.search_provider)
    }
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationConnectionTestRequest {
    pub provider: Option<IntegrationProvider>,
    #[serde(default)]
    pub search_provider: Option<SearchProvider>,
    pub credential: Option<CredentialInput>,
}

impl IntegrationConnectionTestRequest {
    pub fn target(&self) -> Result<IntegrationRequestTarget> {
        validate_request_target(self.provider, self.search_provider)
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationConnectionTestResult {
    pub ok: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<IntegrationProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_provider: Option<SearchProvider>,
}

pub fn missing_credential_result(provider: IntegrationProvider) -> IntegrationConnectionTestResult {
    IntegrationConnectionTestResult {
        ok: false,
        message: format!(
            "Add an API key in Settings > Integrations before using {}.",
            provider.label()
        ),
        provider: Some(provider),
        search_provider: None,
    }
}

pub fn missing_search_credential_result(
    provider: SearchProvider,
) -> IntegrationConnectionTestResult {
    IntegrationConnectionTestResult {
        ok: false,
        message: match provider {
            SearchProvider::DuckDuckGo => "DuckDuckGo does not require an API key.".to_string(),
            _ => format!(
                "Add an API key in Settings > Integrations before using {}.",
                provider.label()
            ),
        },
        provider: None,
        search_provider: Some(provider),
    }
}

pub fn default_settings_file() -> SettingsFile {
    SettingsFile {
        providers: SettingsProviders {
            brave_search: default_brave_search_provider_config(),
            google_workspace: default_google_workspace_provider_config(),
        },
        search: default_search_settings(),
    }
}

fn is_google_workspace_provider(provider: IntegrationProvider) -> bool {
    matches!(provider, IntegrationProvider::GoogleWorkspace)
}

fn default_brave_search_provider_config() -> ProviderConfig {
    ProviderConfig {
        provider: IntegrationProvider::BraveSearch,
        connected: false,
    }
}

fn default_google_workspace_provider_config() -> ProviderConfig {
    ProviderConfig {
        provider: IntegrationProvider::GoogleWorkspace,
        connected: false,
    }
}

fn default_search_mode() -> SearchMode {
    SearchMode::Auto
}

fn default_search_settings() -> SearchSettings {
    SearchSettings {
        mode: default_search_mode(),
        allow_keyless_fallback: false,
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

    let text = serde_json::to_string_pretty(settings)
        .context("Could not serialize integration settings")?;
    fs::write(path, text).context("Could not write integration settings")
}

#[cfg(not(target_os = "macos"))]
fn keyring_entry(provider: IntegrationProvider) -> Result<Entry> {
    Entry::new(KEYCHAIN_SERVICE, provider.account()).context("Could not open keychain entry")
}

#[cfg(not(target_os = "macos"))]
fn search_keyring_entry(provider: SearchProvider) -> Result<Entry> {
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

pub fn get_search_credential(provider: SearchProvider) -> Result<Option<String>> {
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        return get_macos_search_credential(provider);
    }

    #[cfg(not(target_os = "macos"))]
    match search_keyring_entry(provider)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error).context("Could not read search credential"),
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

fn set_search_credential(provider: SearchProvider, api_key: &str) -> Result<()> {
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        return set_macos_search_credential(provider, api_key);
    }

    #[cfg(not(target_os = "macos"))]
    search_keyring_entry(provider)?
        .set_password(api_key)
        .context("Could not store search credential")
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

pub fn delete_search_credential(provider: SearchProvider) -> Result<()> {
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        return delete_macos_search_credential(provider);
    }

    #[cfg(not(target_os = "macos"))]
    match search_keyring_entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("Could not delete search credential"),
    }
}

#[cfg(target_os = "macos")]
fn get_macos_search_credential(provider: SearchProvider) -> Result<Option<String>> {
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
        "Could not read search credential: {}",
        security_stderr(&output)
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
fn set_macos_search_credential(provider: SearchProvider, api_key: &str) -> Result<()> {
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
        "Could not store search credential: {}",
        security_stderr(&output)
    );
}

#[cfg(target_os = "macos")]
fn delete_macos_search_credential(provider: SearchProvider) -> Result<()> {
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
        "Could not delete search credential: {}",
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
    redact_with_settings(_settings)
}

fn redact_with_settings(settings: SettingsFile) -> Result<IntegrationSettingsRead> {
    Ok(IntegrationSettingsRead {
        providers: ReadProviders {
            brave_search: ProviderSettings {
                provider: IntegrationProvider::BraveSearch,
                has_credential: get_credential(IntegrationProvider::BraveSearch)?.is_some(),
            },
            google_workspace: ProviderSettings {
                provider: IntegrationProvider::GoogleWorkspace,
                has_credential: settings.providers.google_workspace.connected,
            },
        },
        search: SearchSettingsRead {
            mode: settings.search.mode,
            allow_keyless_fallback: settings.search.allow_keyless_fallback,
            providers: SearchProvidersRead {
                brave_search: SearchProviderSettings {
                    provider: SearchProvider::BraveSearch,
                    has_credential: get_search_credential(SearchProvider::BraveSearch)?.is_some(),
                },
                tavily: SearchProviderSettings {
                    provider: SearchProvider::Tavily,
                    has_credential: get_search_credential(SearchProvider::Tavily)?.is_some(),
                },
                duckduckgo: SearchProviderSettings {
                    provider: SearchProvider::DuckDuckGo,
                    has_credential: get_search_credential(SearchProvider::DuckDuckGo)?.is_some(),
                },
            },
        },
    })
}

pub fn read(app: &AppHandle) -> Result<IntegrationSettingsRead> {
    let path = settings_path(app)?;
    let settings = load_settings_file(&path)?;
    redact(settings)
}

fn save_at_path(
    path: &Path,
    request: IntegrationSettingsSaveRequest,
) -> Result<IntegrationSettingsRead> {
    let mut settings = load_settings_file(&path)?;
    match request.target()? {
        IntegrationRequestTarget::Integration(provider) => {
            if let Some(credential) = request.credential.as_ref() {
                if is_google_workspace_provider(provider) {
                    bail!("Google Workspace uses CLI auth and does not store an API key");
                }
                let api_key = credential.api_key.trim();
                if api_key.is_empty() {
                    bail!("API key cannot be empty");
                }
                set_credential(provider, api_key)?;
            }
        }
        IntegrationRequestTarget::Search(search_provider) => {
            if let Some(credential) = request.credential.as_ref() {
                let api_key = credential.api_key.trim();
                if api_key.is_empty() {
                    bail!("API key cannot be empty");
                }
                if search_provider == SearchProvider::DuckDuckGo {
                    bail!("DuckDuckGo does not use an API key");
                }
                set_search_credential(search_provider, api_key)?;
            }
        }
    }

    if let Some(search) = request.search.as_ref() {
        settings.search.mode = search.mode;
        settings.search.allow_keyless_fallback = search.allow_keyless_fallback;
    }

    save_settings_file(&path, &settings)?;
    redact_with_settings(settings)
}

pub fn save(
    app: &AppHandle,
    request: IntegrationSettingsSaveRequest,
) -> Result<IntegrationSettingsRead> {
    let path = settings_path(app)?;
    save_at_path(&path, request)
}

fn delete_at_path(
    path: &Path,
    request: IntegrationCredentialDeleteRequest,
) -> Result<IntegrationSettingsRead> {
    let settings = load_settings_file(&path)?;
    match request.target()? {
        IntegrationRequestTarget::Integration(provider) => {
            if !is_google_workspace_provider(provider) {
                delete_credential(provider)?;
            }
        }
        IntegrationRequestTarget::Search(search_provider) => {
            if search_provider != SearchProvider::DuckDuckGo {
                delete_search_credential(search_provider)?;
            }
        }
    }
    save_settings_file(&path, &settings)?;
    redact_with_settings(settings)
}

pub fn delete(
    app: &AppHandle,
    request: IntegrationCredentialDeleteRequest,
) -> Result<IntegrationSettingsRead> {
    let path = settings_path(app)?;
    delete_at_path(&path, request)
}

fn set_google_workspace_connected_at_path(
    path: &Path,
    connected: bool,
) -> Result<IntegrationSettingsRead> {
    let mut settings = load_settings_file(path)?;
    settings.providers.google_workspace.connected = connected;
    save_settings_file(path, &settings)?;
    redact_with_settings(settings)
}

pub fn set_google_workspace_connected(
    app: &AppHandle,
    connected: bool,
) -> Result<IntegrationSettingsRead> {
    let path = settings_path(app)?;
    set_google_workspace_connected_at_path(&path, connected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_include_search_defaults() {
        let settings = default_settings_file();

        assert_eq!(settings.search.mode, SearchMode::Auto);
        assert!(!settings.search.allow_keyless_fallback);
        assert_eq!(
            SearchProvider::BraveSearch.account(),
            "integration.brave-search"
        );
        assert_eq!(SearchProvider::Tavily.account(), "integration.tavily");
        assert_eq!(SearchProvider::DuckDuckGo.label(), "DuckDuckGo");
    }

    #[test]
    fn load_settings_file_defaults_missing_search_section() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(SETTINGS_FILE);

        fs::write(
            &path,
            r#"{
              "providers": {
                "braveSearch": { "provider": "brave-search" },
                "googleWorkspace": { "provider": "google-workspace" }
              }
            }"#,
        )
        .expect("write settings");

        let settings = load_settings_file(&path).expect("load settings");

        assert_eq!(settings.search.mode, SearchMode::Auto);
        assert!(!settings.search.allow_keyless_fallback);
        assert!(!settings.providers.google_workspace.connected);
    }

    #[test]
    fn google_workspace_connected_state_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(SETTINGS_FILE);

        let first = set_google_workspace_connected_at_path(&path, true).expect("connect");
        assert!(first.providers.google_workspace.has_credential);
        assert_eq!(
            first.providers.google_workspace.provider,
            IntegrationProvider::GoogleWorkspace
        );

        let settings = load_settings_file(&path).expect("load settings");
        assert!(settings.providers.google_workspace.connected);

        let second = set_google_workspace_connected_at_path(&path, false).expect("disconnect");
        assert!(!second.providers.google_workspace.has_credential);
    }

    #[test]
    fn missing_google_workspace_connected_state_defaults_to_false() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(SETTINGS_FILE);
        fs::write(
            &path,
            r#"{
              "providers": {
                "braveSearch": { "provider": "brave-search" },
                "googleWorkspace": { "provider": "google-workspace" }
              }
            }"#,
        )
        .expect("write settings");

        let redacted = redact(load_settings_file(&path).expect("load")).expect("redact");
        assert!(!redacted.providers.google_workspace.has_credential);
    }

    #[test]
    fn save_and_load_round_trip_preserves_search_preferences() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(SETTINGS_FILE);
        let mut settings = default_settings_file();
        settings.search.mode = SearchMode::Tavily;
        settings.search.allow_keyless_fallback = true;

        save_settings_file(&path, &settings).expect("save settings");
        let loaded = load_settings_file(&path).expect("load settings");

        assert_eq!(loaded.search.mode, SearchMode::Tavily);
        assert!(loaded.search.allow_keyless_fallback);
    }

    #[test]
    fn save_persists_search_preferences_through_public_save_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(SETTINGS_FILE);
        save_at_path(
            &path,
            IntegrationSettingsSaveRequest {
                provider: Some(IntegrationProvider::BraveSearch),
                search_provider: None,
                has_existing_credential: false,
                credential: None,
                search: Some(SearchSettings {
                    mode: SearchMode::DuckDuckGo,
                    allow_keyless_fallback: true,
                }),
            },
        )
        .expect("save settings");
        let result = load_settings_file(&path).expect("load settings");

        assert_eq!(result.search.mode, SearchMode::DuckDuckGo);
        assert!(result.search.allow_keyless_fallback);
    }

    #[test]
    fn save_accepts_tavily_search_provider_requests_through_public_save_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(SETTINGS_FILE);
        let result = save_at_path(
            &path,
            IntegrationSettingsSaveRequest {
                provider: None,
                search_provider: Some(SearchProvider::Tavily),
                has_existing_credential: false,
                credential: None,
                search: Some(SearchSettings {
                    mode: SearchMode::Tavily,
                    allow_keyless_fallback: true,
                }),
            },
        )
        .expect("save settings");

        assert_eq!(result.search.mode, SearchMode::Tavily);
        assert!(result.search.allow_keyless_fallback);
        assert_eq!(
            result.search.providers.tavily.provider,
            SearchProvider::Tavily
        );
    }

    #[test]
    fn delete_accepts_tavily_search_provider_requests_through_public_delete_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(SETTINGS_FILE);
        let result = delete_at_path(
            &path,
            IntegrationCredentialDeleteRequest {
                provider: None,
                search_provider: Some(SearchProvider::Tavily),
            },
        )
        .expect("delete search credential");

        assert_eq!(
            result.search.providers.tavily.provider,
            SearchProvider::Tavily
        );
    }

    #[test]
    fn request_targets_reject_mixed_provider_combinations() {
        let request = IntegrationSettingsSaveRequest {
            provider: Some(IntegrationProvider::GoogleWorkspace),
            search_provider: Some(SearchProvider::Tavily),
            has_existing_credential: false,
            credential: None,
            search: None,
        };
        assert!(request.target().is_err());

        let request = IntegrationCredentialDeleteRequest {
            provider: Some(IntegrationProvider::GoogleWorkspace),
            search_provider: Some(SearchProvider::Tavily),
        };
        assert!(request.target().is_err());

        let request = IntegrationConnectionTestRequest {
            provider: Some(IntegrationProvider::GoogleWorkspace),
            search_provider: Some(SearchProvider::Tavily),
            credential: None,
        };
        assert!(request.target().is_err());
    }

    #[test]
    fn missing_search_credential_results_include_search_provider() {
        let result = missing_search_credential_result(SearchProvider::Tavily);

        assert!(!result.ok);
        assert_eq!(result.search_provider, Some(SearchProvider::Tavily));
        assert_eq!(result.provider, None);
    }
}
