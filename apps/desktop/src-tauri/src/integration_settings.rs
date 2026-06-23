use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{bail, Context, Result};
#[cfg(not(target_os = "macos"))]
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::model_settings::{user_config_dir, validate_user_key, KEYCHAIN_SERVICE};

pub const SETTINGS_FILE: &str = "integration-settings.json";
static KEYCHAIN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static RUNTIME_CREDENTIALS: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();
static RUNTIME_SEARCH_CREDENTIALS: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();

fn keychain_lock() -> &'static Mutex<()> {
    KEYCHAIN_LOCK.get_or_init(|| Mutex::new(()))
}

fn runtime_credentials() -> &'static Mutex<BTreeMap<String, String>> {
    RUNTIME_CREDENTIALS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn runtime_search_credentials() -> &'static Mutex<BTreeMap<String, String>> {
    RUNTIME_SEARCH_CREDENTIALS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntegrationProvider {
    BraveSearch,
    GoogleWorkspace,
    Hubspot,
}

impl IntegrationProvider {
    pub fn account(self) -> &'static str {
        match self {
            Self::BraveSearch => "integration.brave-search",
            Self::GoogleWorkspace => "integration.google-workspace",
            Self::Hubspot => "integration.hubspot",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::BraveSearch => "Brave Search",
            Self::GoogleWorkspace => "Google Workspace",
            Self::Hubspot => "HubSpot",
        }
    }

    fn account_for_user(self, user_key: Option<&str>) -> String {
        match user_key {
            Some(user_key) => format!("user.{user_key}.{}", self.account()),
            None => self.account().to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SearchProvider {
    BraveSearch,
    Tavily,
    #[serde(rename = "duckduckgo", alias = "duck-duck-go")]
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

    fn account_for_user(self, user_key: Option<&str>) -> String {
        match user_key {
            Some(user_key) => format!("user.{user_key}.{}", self.account()),
            None => self.account().to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SearchMode {
    Auto,
    BraveSearch,
    Tavily,
    #[serde(rename = "duckduckgo", alias = "duck-duck-go")]
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
    #[serde(default = "default_hubspot_provider_config")]
    pub hubspot: ProviderConfig,
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
    pub hubspot: ProviderSettings,
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
pub struct AuthenticatedUser {
    pub user_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<AuthenticatedUser>,
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
        user: None,
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
        user: None,
    }
}

pub fn default_settings_file() -> SettingsFile {
    SettingsFile {
        providers: SettingsProviders {
            brave_search: default_brave_search_provider_config(),
            google_workspace: default_google_workspace_provider_config(),
            hubspot: default_hubspot_provider_config(),
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

fn default_hubspot_provider_config() -> ProviderConfig {
    ProviderConfig {
        provider: IntegrationProvider::Hubspot,
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

fn scoped_user_key(user_key: Option<&str>) -> Result<Option<&str>> {
    user_key.map(validate_user_key).transpose()
}

pub fn settings_path_for_user(app: &AppHandle, user_key: Option<&str>) -> Result<PathBuf> {
    Ok(user_config_dir(app, user_key)?.join(SETTINGS_FILE))
}

fn load_settings_file(path: &Path) -> Result<SettingsFile> {
    if !path.exists() {
        return Ok(default_settings_file());
    }

    let text = fs::read_to_string(path).context("Could not read integration settings")?;
    let mut value: Value =
        serde_json::from_str(&text).context("Could not parse integration settings")?;
    normalize_settings_json(&mut value);
    serde_json::from_value(value).context("Could not parse integration settings")
}

fn normalize_settings_json(value: &mut Value) {
    let Some(root) = value.as_object_mut() else {
        return;
    };

    let providers = root
        .entry("providers")
        .or_insert_with(|| json!({}))
        .as_object_mut();
    if let Some(providers) = providers {
        normalize_provider_config(providers, "braveSearch", "brave-search");
        normalize_provider_config(providers, "googleWorkspace", "google-workspace");
        normalize_provider_config(providers, "hubspot", "hubspot");
    }

    let search = root
        .entry("search")
        .or_insert_with(|| json!({}))
        .as_object_mut();
    if let Some(search) = search {
        let mode = search.entry("mode").or_insert_with(|| json!("auto"));
        normalize_search_mode(mode);
        search
            .entry("allowKeylessFallback")
            .or_insert_with(|| json!(false));

        let search_providers = search
            .entry("providers")
            .or_insert_with(|| json!({}))
            .as_object_mut();
        if let Some(search_providers) = search_providers {
            normalize_search_provider_config(search_providers, "braveSearch", "brave-search");
            normalize_search_provider_config(search_providers, "tavily", "tavily");
            normalize_search_provider_config(search_providers, "duckduckgo", "duckduckgo");
        }
    }
}

fn normalize_provider_config(
    providers: &mut serde_json::Map<String, Value>,
    key: &str,
    provider: &str,
) {
    let value = providers
        .entry(key.to_string())
        .or_insert_with(|| json!({}));
    if !value.is_object() {
        *value = json!({});
    }
    if let Some(object) = value.as_object_mut() {
        object.insert("provider".to_string(), json!(provider));
        object.entry("connected").or_insert_with(|| json!(false));
    }
}

fn normalize_search_provider_config(
    providers: &mut serde_json::Map<String, Value>,
    key: &str,
    provider: &str,
) {
    let value = providers
        .entry(key.to_string())
        .or_insert_with(|| json!({}));
    if !value.is_object() {
        *value = json!({});
    }
    if let Some(object) = value.as_object_mut() {
        object.insert("provider".to_string(), json!(provider));
    }
}

fn normalize_search_mode(value: &mut Value) {
    let normalized = match value.as_str() {
        Some("auto") => "auto",
        Some("brave-search") => "brave-search",
        Some("tavily") => "tavily",
        Some("duckduckgo" | "duck-duck-go") => "duckduckgo",
        _ => "auto",
    };
    *value = json!(normalized);
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
fn keyring_entry(provider: IntegrationProvider, user_key: Option<&str>) -> Result<Entry> {
    let account = provider.account_for_user(scoped_user_key(user_key)?);
    Entry::new(KEYCHAIN_SERVICE, &account).context("Could not open keychain entry")
}

#[cfg(not(target_os = "macos"))]
fn search_keyring_entry(provider: SearchProvider, user_key: Option<&str>) -> Result<Entry> {
    let account = provider.account_for_user(scoped_user_key(user_key)?);
    Entry::new(KEYCHAIN_SERVICE, &account).context("Could not open keychain entry")
}

pub fn get_credential_for_user(
    provider: IntegrationProvider,
    user_key: Option<&str>,
) -> Result<Option<String>> {
    let account = provider.account_for_user(scoped_user_key(user_key)?);
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        if let Some(value) = get_macos_credential(&account)? {
            return Ok(Some(value));
        }
        return Ok(runtime_credentials()
            .lock()
            .expect("runtime integration credential cache poisoned")
            .get(&account)
            .cloned());
    }

    #[cfg(not(target_os = "macos"))]
    {
        match keyring_entry(provider, user_key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(runtime_credentials()
                .lock()
                .expect("runtime integration credential cache poisoned")
                .get(&account)
                .cloned()),
            Err(error) => Err(error).context("Could not read integration credential"),
        }
    }
}

pub fn get_credential_for_user_with_global_fallback(
    provider: IntegrationProvider,
    user_key: Option<&str>,
) -> Result<Option<String>> {
    let credential = get_credential_for_user(provider, user_key)?;
    if credential.is_some() || user_key.is_none() {
        return Ok(credential);
    }
    get_credential_for_user(provider, None)
}

pub fn get_search_credential_for_user(
    provider: SearchProvider,
    user_key: Option<&str>,
) -> Result<Option<String>> {
    let account = provider.account_for_user(scoped_user_key(user_key)?);
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        if let Some(value) = get_macos_search_credential(&account)? {
            return Ok(Some(value));
        }
        return Ok(runtime_search_credentials()
            .lock()
            .expect("runtime search credential cache poisoned")
            .get(&account)
            .cloned());
    }

    #[cfg(not(target_os = "macos"))]
    {
        match search_keyring_entry(provider, user_key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(runtime_search_credentials()
                .lock()
                .expect("runtime search credential cache poisoned")
                .get(&account)
                .cloned()),
            Err(error) => Err(error).context("Could not read search credential"),
        }
    }
}

fn set_credential_for_user(
    provider: IntegrationProvider,
    user_key: Option<&str>,
    api_key: &str,
) -> Result<()> {
    let account = provider.account_for_user(scoped_user_key(user_key)?);
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        set_macos_credential(&account, api_key)?;
        runtime_credentials()
            .lock()
            .expect("runtime integration credential cache poisoned")
            .insert(account, api_key.to_string());
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        keyring_entry(provider, user_key)?
            .set_password(api_key)
            .context("Could not store integration credential")?;
        runtime_credentials()
            .lock()
            .expect("runtime integration credential cache poisoned")
            .insert(account, api_key.to_string());
        Ok(())
    }
}

fn set_search_credential_for_user(
    provider: SearchProvider,
    user_key: Option<&str>,
    api_key: &str,
) -> Result<()> {
    let account = provider.account_for_user(scoped_user_key(user_key)?);
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    #[cfg(target_os = "macos")]
    {
        set_macos_search_credential(&account, api_key)?;
        runtime_search_credentials()
            .lock()
            .expect("runtime search credential cache poisoned")
            .insert(account, api_key.to_string());
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        search_keyring_entry(provider, user_key)?
            .set_password(api_key)
            .context("Could not store search credential")?;
        runtime_search_credentials()
            .lock()
            .expect("runtime search credential cache poisoned")
            .insert(account, api_key.to_string());
        Ok(())
    }
}

pub fn delete_credential_for_user(
    provider: IntegrationProvider,
    user_key: Option<&str>,
) -> Result<()> {
    let account = provider.account_for_user(scoped_user_key(user_key)?);
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    runtime_credentials()
        .lock()
        .expect("runtime integration credential cache poisoned")
        .remove(&account);
    #[cfg(target_os = "macos")]
    {
        return delete_macos_credential(&account);
    }

    #[cfg(not(target_os = "macos"))]
    match keyring_entry(provider, user_key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("Could not delete integration credential"),
    }
}

pub fn delete_search_credential_for_user(
    provider: SearchProvider,
    user_key: Option<&str>,
) -> Result<()> {
    let account = provider.account_for_user(scoped_user_key(user_key)?);
    let _guard = keychain_lock().lock().expect("keychain lock poisoned");
    runtime_search_credentials()
        .lock()
        .expect("runtime search credential cache poisoned")
        .remove(&account);
    #[cfg(target_os = "macos")]
    {
        return delete_macos_search_credential(&account);
    }

    #[cfg(not(target_os = "macos"))]
    match search_keyring_entry(provider, user_key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("Could not delete search credential"),
    }
}

#[cfg(target_os = "macos")]
fn get_macos_search_credential(account: &str) -> Result<Option<String>> {
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
        "Could not read integration credential: {}",
        security_stderr(&output)
    );
}

#[cfg(target_os = "macos")]
fn set_macos_search_credential(account: &str, api_key: &str) -> Result<()> {
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
        "Could not store search credential: {}",
        security_stderr(&output)
    );
}

#[cfg(target_os = "macos")]
fn delete_macos_search_credential(account: &str) -> Result<()> {
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
        "Could not delete search credential: {}",
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
        "Could not store integration credential: {}",
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
        "Could not delete integration credential: {}",
        security_stderr(&output)
    );
}

fn redact_with_settings_for_user(
    settings: SettingsFile,
    user_key: Option<&str>,
) -> Result<IntegrationSettingsRead> {
    Ok(IntegrationSettingsRead {
        providers: ReadProviders {
            brave_search: ProviderSettings {
                provider: IntegrationProvider::BraveSearch,
                has_credential: get_credential_for_user(
                    IntegrationProvider::BraveSearch,
                    user_key,
                )?
                .is_some(),
            },
            google_workspace: ProviderSettings {
                provider: IntegrationProvider::GoogleWorkspace,
                has_credential: settings.providers.google_workspace.connected,
            },
            hubspot: ProviderSettings {
                provider: IntegrationProvider::Hubspot,
                has_credential: get_credential_for_user(IntegrationProvider::Hubspot, user_key)?
                    .is_some(),
            },
        },
        search: SearchSettingsRead {
            mode: settings.search.mode,
            allow_keyless_fallback: settings.search.allow_keyless_fallback,
            providers: SearchProvidersRead {
                brave_search: SearchProviderSettings {
                    provider: SearchProvider::BraveSearch,
                    has_credential: get_search_credential_for_user(
                        SearchProvider::BraveSearch,
                        user_key,
                    )?
                    .is_some(),
                },
                tavily: SearchProviderSettings {
                    provider: SearchProvider::Tavily,
                    has_credential: get_search_credential_for_user(
                        SearchProvider::Tavily,
                        user_key,
                    )?
                    .is_some(),
                },
                duckduckgo: SearchProviderSettings {
                    provider: SearchProvider::DuckDuckGo,
                    has_credential: get_search_credential_for_user(
                        SearchProvider::DuckDuckGo,
                        user_key,
                    )?
                    .is_some(),
                },
            },
        },
    })
}

fn settings_with_legacy_google_workspace_connection(
    mut settings: SettingsFile,
    legacy_settings: Option<&SettingsFile>,
    user_key: Option<&str>,
) -> SettingsFile {
    if user_key.is_some()
        && !settings.providers.google_workspace.connected
        && legacy_settings
            .map(|settings| settings.providers.google_workspace.connected)
            .unwrap_or(false)
    {
        settings.providers.google_workspace.connected = true;
    }
    settings
}

pub fn read_for_user(app: &AppHandle, user_key: Option<&str>) -> Result<IntegrationSettingsRead> {
    let path = settings_path_for_user(app, user_key)?;
    let settings = load_settings_file(&path)?;
    let legacy_settings = if user_key.is_some() {
        let legacy_path = settings_path_for_user(app, None)?;
        load_settings_file(&legacy_path).ok()
    } else {
        None
    };
    let settings = settings_with_legacy_google_workspace_connection(
        settings,
        legacy_settings.as_ref(),
        user_key,
    );
    redact_with_settings_for_user(settings, user_key)
}

fn save_at_path_for_user(
    path: &Path,
    request: IntegrationSettingsSaveRequest,
    user_key: Option<&str>,
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
                set_credential_for_user(provider, user_key, api_key)?;
                if user_key.is_some() {
                    set_credential_for_user(provider, None, api_key)?;
                }
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
                set_search_credential_for_user(search_provider, user_key, api_key)?;
                if user_key.is_some() {
                    set_search_credential_for_user(search_provider, None, api_key)?;
                }
            }
        }
    }

    if let Some(search) = request.search.as_ref() {
        settings.search.mode = search.mode;
        settings.search.allow_keyless_fallback = search.allow_keyless_fallback;
    }

    save_settings_file(&path, &settings)?;
    redact_with_settings_for_user(settings, user_key)
}

pub fn save_for_user(
    app: &AppHandle,
    user_key: Option<&str>,
    request: IntegrationSettingsSaveRequest,
) -> Result<IntegrationSettingsRead> {
    let path = settings_path_for_user(app, user_key)?;
    save_at_path_for_user(&path, request, user_key)
}

fn delete_at_path_for_user(
    path: &Path,
    request: IntegrationCredentialDeleteRequest,
    user_key: Option<&str>,
) -> Result<IntegrationSettingsRead> {
    let settings = load_settings_file(&path)?;
    match request.target()? {
        IntegrationRequestTarget::Integration(provider) => {
            if !is_google_workspace_provider(provider) {
                delete_credential_for_user(provider, user_key)?;
            }
        }
        IntegrationRequestTarget::Search(search_provider) => {
            if search_provider != SearchProvider::DuckDuckGo {
                delete_search_credential_for_user(search_provider, user_key)?;
            }
        }
    }
    save_settings_file(&path, &settings)?;
    redact_with_settings_for_user(settings, user_key)
}

pub fn delete_for_user(
    app: &AppHandle,
    user_key: Option<&str>,
    request: IntegrationCredentialDeleteRequest,
) -> Result<IntegrationSettingsRead> {
    let path = settings_path_for_user(app, user_key)?;
    delete_at_path_for_user(&path, request, user_key)
}

fn set_google_workspace_connected_at_path_for_user(
    path: &Path,
    connected: bool,
    user_key: Option<&str>,
) -> Result<IntegrationSettingsRead> {
    let settings = save_google_workspace_connected_at_path(path, connected)?;
    redact_with_settings_for_user(settings, user_key)
}

fn save_google_workspace_connected_at_path(path: &Path, connected: bool) -> Result<SettingsFile> {
    let mut settings = load_settings_file(path)?;
    settings.providers.google_workspace.connected = connected;
    save_settings_file(path, &settings)?;
    Ok(settings)
}

pub fn set_google_workspace_connected_for_user(
    app: &AppHandle,
    user_key: Option<&str>,
    connected: bool,
) -> Result<IntegrationSettingsRead> {
    let path = settings_path_for_user(app, user_key)?;
    let result = set_google_workspace_connected_at_path_for_user(&path, connected, user_key)?;
    if user_key.is_some() {
        let legacy_path = settings_path_for_user(app, None)?;
        save_google_workspace_connected_at_path(&legacy_path, connected)?;
    }
    Ok(result)
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
                  "googleWorkspace": { "provider": "google-workspace" },
                  "hubspot": { "provider": "hubspot" }
                }
              }"#,
        )
        .expect("write settings");

        let settings = load_settings_file(&path).expect("load settings");

        assert_eq!(settings.search.mode, SearchMode::Auto);
        assert!(!settings.search.allow_keyless_fallback);
        assert!(!settings.providers.google_workspace.connected);
        assert_eq!(
            settings.providers.hubspot.provider,
            IntegrationProvider::Hubspot
        );
    }

    #[test]
    fn load_settings_file_repairs_legacy_provider_values() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(SETTINGS_FILE);

        fs::write(
            &path,
            r#"{
                "providers": {
                  "braveSearch": { "provider": "duckduckgo" },
                  "googleWorkspace": { "provider": "google-workspace", "connected": true }
                },
                "search": {
                  "mode": "duck-duck-go",
                  "allowKeylessFallback": true,
                  "providers": {
                    "braveSearch": { "provider": "brave-search" },
                    "tavily": { "provider": "tavily" },
                    "duckduckgo": { "provider": "duck-duck-go" }
                  }
                }
              }"#,
        )
        .expect("write settings");

        let settings = load_settings_file(&path).expect("load settings");

        assert_eq!(
            settings.providers.brave_search.provider,
            IntegrationProvider::BraveSearch
        );
        assert_eq!(
            settings.providers.hubspot.provider,
            IntegrationProvider::Hubspot
        );
        assert!(settings.providers.google_workspace.connected);
        assert_eq!(settings.search.mode, SearchMode::DuckDuckGo);
    }

    #[test]
    fn google_workspace_connected_state_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(SETTINGS_FILE);

        let first =
            set_google_workspace_connected_at_path_for_user(&path, true, None).expect("connect");
        assert!(first.providers.google_workspace.has_credential);
        assert_eq!(
            first.providers.google_workspace.provider,
            IntegrationProvider::GoogleWorkspace
        );

        let settings = load_settings_file(&path).expect("load settings");
        assert!(settings.providers.google_workspace.connected);

        let second = set_google_workspace_connected_at_path_for_user(&path, false, None)
            .expect("disconnect");
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
                  "googleWorkspace": { "provider": "google-workspace" },
                  "hubspot": { "provider": "hubspot" }
                }
              }"#,
        )
        .expect("write settings");

        let redacted =
            redact_with_settings_for_user(load_settings_file(&path).expect("load"), None)
                .expect("redact");
        assert!(!redacted.providers.google_workspace.has_credential);
    }

    #[test]
    fn user_settings_inherit_legacy_google_workspace_connection() {
        let user_settings = default_settings_file();
        let mut legacy_settings = default_settings_file();
        legacy_settings.providers.google_workspace.connected = true;

        let migrated = settings_with_legacy_google_workspace_connection(
            user_settings,
            Some(&legacy_settings),
            Some("user.test"),
        );

        assert!(migrated.providers.google_workspace.connected);
    }

    #[test]
    fn global_settings_do_not_inherit_legacy_google_workspace_connection() {
        let user_settings = default_settings_file();
        let mut legacy_settings = default_settings_file();
        legacy_settings.providers.google_workspace.connected = true;

        let migrated = settings_with_legacy_google_workspace_connection(
            user_settings,
            Some(&legacy_settings),
            None,
        );

        assert!(!migrated.providers.google_workspace.connected);
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
        save_at_path_for_user(
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
            None,
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
        let result = save_at_path_for_user(
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
            None,
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
        let result = delete_at_path_for_user(
            &path,
            IntegrationCredentialDeleteRequest {
                provider: None,
                search_provider: Some(SearchProvider::Tavily),
            },
            None,
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

    // Serialises tests that mutate the global runtime-credential cache so they cannot
    // interfere with each other when the test runner dispatches them in parallel.
    static CACHE_TEST_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> =
        std::sync::OnceLock::new();
    fn cache_test_lock() -> &'static std::sync::Mutex<()> {
        CACHE_TEST_LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    #[test]
    fn global_fallback_returns_globally_stored_runtime_credential_when_user_scoped_is_absent() {
        let _guard = cache_test_lock().lock().unwrap();

        let global_account = IntegrationProvider::Hubspot.account_for_user(None);
        let user_account = IntegrationProvider::Hubspot.account_for_user(Some("testfallback"));
        let cache = runtime_credentials();

        // Clean slate, then seed only the global account.
        {
            let mut map = cache.lock().expect("runtime integration credential cache poisoned");
            map.remove(&user_account);
            map.insert(global_account.clone(), "test-global-pat".to_string());
        }

        // Calling with a user key that has no user-scoped entry should fall back to global.
        let result = get_credential_for_user_with_global_fallback(
            IntegrationProvider::Hubspot,
            Some("testfallback"),
        );

        // Clean up before asserting so the cache is never left dirty.
        cache
            .lock()
            .expect("runtime integration credential cache poisoned")
            .remove(&global_account);

        assert_eq!(result.expect("lookup should not error"), Some("test-global-pat".to_string()));
    }

    #[test]
    fn global_fallback_returns_none_when_neither_user_nor_global_credential_exists() {
        let _guard = cache_test_lock().lock().unwrap();

        let global_account = IntegrationProvider::Hubspot.account_for_user(None);
        let user_account =
            IntegrationProvider::Hubspot.account_for_user(Some("testfallback-absent"));

        // Ensure neither a user-scoped nor global entry is in the cache.
        {
            let mut map = runtime_credentials()
                .lock()
                .expect("runtime integration credential cache poisoned");
            map.remove(&global_account);
            map.remove(&user_account);
        }

        let result = get_credential_for_user_with_global_fallback(
            IntegrationProvider::Hubspot,
            Some("testfallback-absent"),
        );

        assert_eq!(result.expect("lookup should not error"), None);
    }
}
