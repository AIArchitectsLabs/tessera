# Global Model Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add global model settings behind the rail user menu, with provider preferences in app config and API keys stored only in the OS keychain.

**Architecture:** The React UI calls Tauri commands for settings reads, saves, deletes, and connection tests. Rust owns app-level persistence and keychain access, and passes credentials to the sidecar only in-memory for connection tests or agent execution. Shared redacted settings types live in `packages/contracts`.

**Tech Stack:** Tauri 2, Rust, `keyring` crate, React 18, TypeScript strict mode, Zod contracts, Bun tests, Biome.

---

## File Structure

- Create `apps/desktop/src-tauri/src/model_settings.rs`: Rust model settings types, JSON app-config persistence, keychain access, and pure helpers.
- Modify `apps/desktop/src-tauri/src/lib.rs`: register model settings commands and call into `model_settings.rs`.
- Modify `apps/desktop/src-tauri/Cargo.toml`: add `keyring = "3.6.3"` for cross-platform OS keychain access.
- Modify `packages/contracts/src/index.ts`: add model settings request/response schemas and an in-memory credential field for `AgentTurnRequestSchema`.
- Modify `packages/contracts/src/task.test.ts` or create `packages/contracts/src/model-settings.test.ts`: verify schema parsing and redaction shape.
- Modify `packages/core/src/model.ts`: allow in-memory credential override before environment-variable fallback.
- Modify `packages/core/src/agent.ts`: pass `request.credential?.apiKey` into `resolveApiKey` and return setup-required errors when needed.
- Modify `packages/core/src/model.test.ts`: verify override credential precedence and fallback.
- Modify `apps/desktop/ui/src/components/RailNav.tsx`: replace the standalone settings rail item with a bottom user menu.
- Create `apps/desktop/ui/src/components/SettingsView.tsx`: app-level settings surface with a `Model` section.
- Create `apps/desktop/ui/src/lib/modelSettings.ts`: UI-facing types, provider labels/placeholders, and small form helpers.
- Create `apps/desktop/ui/src/lib/modelSettings.test.ts`: unit tests for helpers and no-op logout behavior boundary.
- Modify `apps/desktop/ui/src/App.tsx`: open/close Settings, load/save model settings through Tauri commands, and keep Logout no-op.

## Implementation Notes

- Use the direct Rust `keyring` crate rather than exposing a keyring plugin to React. React must never receive secret values.
- `keyring 3.6.3` is the latest stable release found during planning; avoid the 4.0 release candidates for this pass.
- Store non-secret settings in `app_config_dir()/model-settings.json`.
- Store credentials with service `Tessera` and accounts `model.openai`, `model.anthropic`, `model.openrouter`, and `model.local`.
- Keep local provider API key optional.
- Connection tests may call sidecar `/agent/turn` with a short prompt and in-memory credential. Do not save form data during test.

---

### Task 1: Add Shared Model Settings Contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/model-settings.test.ts`

- [ ] **Step 1: Write failing contract tests**

Create `packages/contracts/src/model-settings.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  AgentTurnRequestSchema,
  ModelCredentialDeleteRequestSchema,
  ModelProviderSettingsSchema,
  ModelSettingsReadSchema,
  ModelSettingsSaveRequestSchema,
} from "./index.js";

describe("model settings contracts", () => {
  test("parses redacted settings without API key values", () => {
    const parsed = ModelSettingsReadSchema.parse({
      selectedProvider: "openai",
      providers: {
        openai: { provider: "openai", model: "gpt-5.4", hasCredential: true },
        anthropic: { provider: "anthropic", model: "claude-sonnet-4-6", hasCredential: false },
        openrouter: { provider: "openrouter", model: "openai/gpt-5.4", hasCredential: false },
        local: {
          provider: "local",
          model: "llama3.2",
          baseUrl: "http://127.0.0.1:11434/v1",
          hasCredential: false,
        },
      },
    });

    expect(parsed.providers.openai.hasCredential).toBe(true);
    expect("apiKey" in parsed.providers.openai).toBe(false);
  });

  test("accepts a save request with an optional replacement key", () => {
    const parsed = ModelSettingsSaveRequestSchema.parse({
      selectedProvider: "openai",
      provider: { provider: "openai", model: "gpt-5.4" },
      credential: { apiKey: "sk-test" },
    });

    expect(parsed.credential?.apiKey).toBe("sk-test");
  });

  test("accepts local provider settings without credentials", () => {
    const parsed = ModelProviderSettingsSchema.parse({
      provider: "local",
      model: "llama3.2",
      baseUrl: "http://127.0.0.1:11434/v1",
      hasCredential: false,
    });

    expect(parsed.provider).toBe("local");
  });

  test("accepts credential delete request for one provider", () => {
    const parsed = ModelCredentialDeleteRequestSchema.parse({ provider: "anthropic" });
    expect(parsed.provider).toBe("anthropic");
  });

  test("agent turn credential is separate from provider config", () => {
    const parsed = AgentTurnRequestSchema.parse({
      prompt: "Reply OK",
      provider: { provider: "openai", model: "gpt-5.4" },
      credential: { apiKey: "sk-test" },
    });

    expect(parsed.credential?.apiKey).toBe("sk-test");
    expect("apiKey" in parsed.provider).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/contracts/src/model-settings.test.ts`

Expected: FAIL with missing exports such as `ModelSettingsReadSchema`.

- [ ] **Step 3: Add contract schemas**

In `packages/contracts/src/index.ts`, insert these schemas after `AgentProviderConfigSchema`:

```ts
export const ModelProviderSchema = z.enum(["openai", "anthropic", "openrouter", "local"]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

const OpenAIModelProviderSettingsSchema = z.object({
  provider: z.literal("openai"),
  model: z.string().min(1),
  hasCredential: z.boolean().default(false),
});

const AnthropicModelProviderSettingsSchema = z.object({
  provider: z.literal("anthropic"),
  model: z.string().min(1),
  hasCredential: z.boolean().default(false),
});

const OpenRouterModelProviderSettingsSchema = z.object({
  provider: z.literal("openrouter"),
  model: z.string().min(1),
  hasCredential: z.boolean().default(false),
});

const LocalModelProviderSettingsSchema = z.object({
  provider: z.literal("local"),
  model: z.string().min(1),
  baseUrl: z.string().url(),
  hasCredential: z.boolean().default(false),
});

export const ModelProviderSettingsSchema = z.discriminatedUnion("provider", [
  OpenAIModelProviderSettingsSchema,
  AnthropicModelProviderSettingsSchema,
  OpenRouterModelProviderSettingsSchema,
  LocalModelProviderSettingsSchema,
]);
export type ModelProviderSettings = z.infer<typeof ModelProviderSettingsSchema>;

export const ModelSettingsReadSchema = z.object({
  selectedProvider: ModelProviderSchema,
  providers: z.object({
    openai: OpenAIModelProviderSettingsSchema,
    anthropic: AnthropicModelProviderSettingsSchema,
    openrouter: OpenRouterModelProviderSettingsSchema,
    local: LocalModelProviderSettingsSchema,
  }),
});
export type ModelSettingsRead = z.infer<typeof ModelSettingsReadSchema>;

export const ModelSettingsSaveRequestSchema = z.object({
  selectedProvider: ModelProviderSchema,
  provider: AgentProviderConfigSchema,
  credential: z
    .object({
      apiKey: z.string().min(1),
    })
    .optional(),
});
export type ModelSettingsSaveRequest = z.infer<typeof ModelSettingsSaveRequestSchema>;

export const ModelCredentialDeleteRequestSchema = z.object({
  provider: ModelProviderSchema,
});
export type ModelCredentialDeleteRequest = z.infer<typeof ModelCredentialDeleteRequestSchema>;

export const ModelConnectionTestRequestSchema = z.object({
  provider: AgentProviderConfigSchema,
  credential: z
    .object({
      apiKey: z.string().min(1),
    })
    .optional(),
});
export type ModelConnectionTestRequest = z.infer<typeof ModelConnectionTestRequestSchema>;

export const ModelConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
export type ModelConnectionTestResult = z.infer<typeof ModelConnectionTestResultSchema>;
```

Then update `AgentTurnRequestSchema`:

```ts
export const AgentTurnRequestSchema = z.object({
  prompt: z.string().min(1),
  provider: AgentProviderConfigSchema,
  credential: z
    .object({
      apiKey: z.string().min(1),
    })
    .optional(),
  grants: z.array(PermissionGrantSchema).default([]),
  timeoutMs: z.number().int().positive().max(120_000).default(60_000),
});
```

- [ ] **Step 4: Run contract tests**

Run: `bun test packages/contracts/src/model-settings.test.ts packages/contracts/src/task.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/model-settings.test.ts
git commit -m "Define redacted model settings contracts" \
  -m "Global model settings need shared request and response shapes before desktop and runtime code can depend on them." \
  -m "Constraint: Stored credential values must never be represented in read responses" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: bun test packages/contracts/src/model-settings.test.ts packages/contracts/src/task.test.ts"
```

### Task 2: Add Rust Settings Persistence And Keychain Storage

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/src/model_settings.rs`

- [ ] **Step 1: Add dependency**

Modify `apps/desktop/src-tauri/Cargo.toml`:

```toml
keyring = "3.6.3"
```

- [ ] **Step 2: Write Rust unit tests first**

Create `apps/desktop/src-tauri/src/model_settings.rs` with the tests and enough type definitions for compilation:

```rust
use serde::{Deserialize, Serialize};

const KEYCHAIN_SERVICE: &str = "Tessera";

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_accounts_are_stable() {
        assert_eq!(KEYCHAIN_SERVICE, "Tessera");
        assert_eq!(ModelProvider::Openai.account(), "model.openai");
        assert_eq!(ModelProvider::Anthropic.account(), "model.anthropic");
        assert_eq!(ModelProvider::Openrouter.account(), "model.openrouter");
        assert_eq!(ModelProvider::Local.account(), "model.local");
    }
}
```

- [ ] **Step 3: Run test to verify it passes as a baseline**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml model_settings`

Expected: PASS. This confirms the dependency compiles before adding storage behavior.

- [ ] **Step 4: Implement settings types and persistence**

Replace `apps/desktop/src-tauri/src/model_settings.rs` with:

```rust
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const KEYCHAIN_SERVICE: &str = "Tessera";
const SETTINGS_FILE: &str = "model-settings.json";

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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub provider: ModelProvider,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub provider: ModelProvider,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    pub has_credential: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    pub selected_provider: ModelProvider,
    pub providers: BTreeMap<ModelProvider, ProviderConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettingsRead {
    pub selected_provider: ModelProvider,
    pub providers: BTreeMap<ModelProvider, ProviderSettings>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInput {
    pub api_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettingsSaveRequest {
    pub selected_provider: ModelProvider,
    pub provider: ProviderConfig,
    pub credential: Option<CredentialInput>,
}

#[derive(Debug, Clone, Deserialize)]
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
                base_url: if provider == ModelProvider::Local {
                    Some("http://127.0.0.1:11434/v1".to_string())
                } else {
                    None
                },
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
    let text = serde_json::to_string_pretty(settings).context("Could not serialize model settings")?;
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
    settings.selected_provider = request.selected_provider;
    settings.providers.insert(request.provider.provider, request.provider.clone());
    save_settings_file(&path, &settings)?;
    if let Some(credential) = request.credential {
        set_credential(request.provider.provider, credential.api_key.trim())?;
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
            settings.providers.get(&ModelProvider::Local).and_then(|p| p.base_url.as_deref()),
            Some("http://127.0.0.1:11434/v1")
        );
    }

    #[test]
    fn file_round_trip_preserves_non_secret_settings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("model-settings.json");
        let settings = default_settings_file();
        save_settings_file(&path, &settings).expect("save");
        let loaded = load_settings_file(&path).expect("load");
        assert_eq!(loaded.selected_provider, ModelProvider::Openai);
        assert!(loaded.providers.contains_key(&ModelProvider::Anthropic));
    }
}
```

Add this dev dependency if the test uses `tempfile`:

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 5: Run Rust tests**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml model_settings`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/model_settings.rs
git commit -m "Store model credentials outside app config" \
  -m "Global model settings need durable non-secret preferences while API keys stay in the OS keychain." \
  -m "Constraint: React and app config must only see redacted credential presence" \
  -m "Rejected: Tauri keyring plugin exposed to React | direct Rust commands keep secrets out of the webview API" \
  -m "Confidence: medium" \
  -m "Scope-risk: moderate" \
  -m "Tested: cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml model_settings"
```

### Task 3: Register Tauri Commands And Connection Test

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/model_settings.rs`

- [ ] **Step 1: Add command tests through pure helpers**

Extend `apps/desktop/src-tauri/src/model_settings.rs` with a serializable connection request/result:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConnectionTestRequest {
    pub provider: ProviderConfig,
    pub credential: Option<CredentialInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConnectionTestResult {
    pub ok: bool,
    pub message: String,
}

pub fn missing_credential_result(provider: ModelProvider) -> ModelConnectionTestResult {
    ModelConnectionTestResult {
        ok: false,
        message: match provider {
            ModelProvider::Local => "Local provider does not require an API key by default".to_string(),
            _ => "Add an API key in Settings > Model before running this provider".to_string(),
        },
    }
}
```

Add test:

```rust
#[test]
fn missing_cloud_credential_message_points_to_settings() {
    let result = missing_credential_result(ModelProvider::Openai);
    assert!(!result.ok);
    assert!(result.message.contains("Settings > Model"));
}
```

- [ ] **Step 2: Run test**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml missing_cloud_credential_message_points_to_settings`

Expected: PASS.

- [ ] **Step 3: Register module and commands**

At the top of `apps/desktop/src-tauri/src/lib.rs`, add:

```rust
mod model_settings;
```

Add these Tauri command functions near the existing command section:

```rust
#[tauri::command]
async fn model_settings_get(app: AppHandle) -> Result<model_settings::ModelSettingsRead, String> {
    model_settings::read(&app).map_err(|e| e.to_string())
}

#[tauri::command]
async fn model_settings_save(
    app: AppHandle,
    request: model_settings::ModelSettingsSaveRequest,
) -> Result<model_settings::ModelSettingsRead, String> {
    model_settings::save(&app, request).map_err(|e| e.to_string())
}

#[tauri::command]
async fn model_credential_delete(
    app: AppHandle,
    request: model_settings::ModelCredentialDeleteRequest,
) -> Result<model_settings::ModelSettingsRead, String> {
    model_settings::delete(&app, request).map_err(|e| e.to_string())
}
```

Register the commands in `tauri::generate_handler!`:

```rust
model_credential_delete,
model_settings_get,
model_settings_save,
```

- [ ] **Step 4: Implement connection test command**

Add helper in `apps/desktop/src-tauri/src/lib.rs`:

```rust
fn provider_json(
    provider: &model_settings::ProviderConfig,
    credential: Option<String>,
) -> serde_json::Value {
    let provider_value = match provider.provider {
        model_settings::ModelProvider::Openai => serde_json::json!({
            "provider": "openai",
            "model": provider.model,
        }),
        model_settings::ModelProvider::Anthropic => serde_json::json!({
            "provider": "anthropic",
            "model": provider.model,
        }),
        model_settings::ModelProvider::Openrouter => serde_json::json!({
            "provider": "openrouter",
            "model": provider.model,
        }),
        model_settings::ModelProvider::Local => serde_json::json!({
            "provider": "local",
            "model": provider.model,
            "baseUrl": provider.base_url.as_deref().unwrap_or("http://127.0.0.1:11434/v1"),
        }),
    };

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
```

Add command:

```rust
#[tauri::command]
async fn model_connection_test(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    request: model_settings::ModelConnectionTestRequest,
) -> Result<model_settings::ModelConnectionTestResult, String> {
    let credential = match request.credential {
        Some(input) => Some(input.api_key),
        None => model_settings::get_credential(request.provider.provider).map_err(|e| e.to_string())?,
    };

    if credential.is_none() && request.provider.provider != model_settings::ModelProvider::Local {
        return Ok(model_settings::missing_credential_result(request.provider.provider));
    }

    let body = provider_json(&request.provider, credential).to_string();
    let json = state.post("/agent/turn", &body).await.map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let ok = value.get("status").and_then(|v| v.as_str()) == Some("completed");
    Ok(model_settings::ModelConnectionTestResult {
        ok,
        message: if ok {
            "Connection test succeeded".to_string()
        } else {
            value
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Connection test failed")
                .to_string()
        },
    })
}
```

Register `model_connection_test` in `tauri::generate_handler!`.

- [ ] **Step 5: Run Rust tests**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/model_settings.rs
git commit -m "Expose model settings through redacted Tauri commands" \
  -m "The desktop UI needs settings commands that can save preferences, manage one provider key at a time, and test provider connectivity without exposing stored secrets." \
  -m "Constraint: Connection tests may pass credentials to the sidecar only in-memory" \
  -m "Confidence: medium" \
  -m "Scope-risk: moderate" \
  -m "Tested: cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml"
```

### Task 4: Update Core Agent Credential Resolution

**Files:**
- Modify: `packages/core/src/model.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/model.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/core/src/model.test.ts`:

```ts
import { resolveApiKey } from "./model.js";
```

Add tests:

```ts
test("uses in-memory credential before environment fallback", () => {
  const config = AgentProviderConfigSchema.parse({
    provider: "openai",
    model: "gpt-5.4",
    apiKeyEnv: "OPENAI_API_KEY",
  });

  expect(resolveApiKey(config, "sk-memory")).toBe("sk-memory");
});

test("keeps environment fallback when no in-memory credential exists", () => {
  process.env.TEST_TESSERA_OPENAI_KEY = "sk-env";
  const config = AgentProviderConfigSchema.parse({
    provider: "openai",
    model: "gpt-5.4",
    apiKeyEnv: "TEST_TESSERA_OPENAI_KEY",
  });

  expect(resolveApiKey(config)).toBe("sk-env");
  delete process.env.TEST_TESSERA_OPENAI_KEY;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/model.test.ts`

Expected: FAIL because `resolveApiKey` accepts one argument.

- [ ] **Step 3: Update model credential resolution**

Change `packages/core/src/model.ts`:

```ts
export function resolveApiKey(
  config: AgentProviderConfig,
  credential?: string
): string | undefined {
  if (credential) return credential;

  if (config.provider === "openai") {
    return process.env[config.apiKeyEnv];
  }

  if (config.provider === "anthropic") {
    return process.env[config.apiKeyEnv];
  }

  if (config.provider === "openrouter") {
    return process.env[config.apiKeyEnv];
  }

  if (!config.apiKeyEnv) return undefined;
  return process.env[config.apiKeyEnv];
}
```

Update `packages/core/src/agent.ts`:

```ts
const apiKey = resolveApiKey(request.provider, request.credential?.apiKey);
```

Update the setup-required error:

```ts
error: `${request.provider.provider} is not configured. Add an API key in Settings > Model.`,
```

- [ ] **Step 4: Run core tests**

Run: `bun test packages/core/src/model.test.ts packages/core/src/permission.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/model.ts packages/core/src/agent.ts packages/core/src/model.test.ts
git commit -m "Resolve agent credentials from in-memory settings" \
  -m "Desktop model settings need to supply credentials without writing them to provider config or environment files." \
  -m "Constraint: Environment variables remain a fallback for CLI and development paths" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: bun test packages/core/src/model.test.ts packages/core/src/permission.test.ts"
```

### Task 5: Add UI Model Settings Helpers

**Files:**
- Create: `apps/desktop/ui/src/lib/modelSettings.ts`
- Create: `apps/desktop/ui/src/lib/modelSettings.test.ts`

- [ ] **Step 1: Write failing helper tests**

Create `apps/desktop/ui/src/lib/modelSettings.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  defaultDraftForProvider,
  modelPlaceholderForProvider,
  providerLabel,
  shouldSendCredential,
} from "./modelSettings";

describe("model settings UI helpers", () => {
  test("labels supported providers", () => {
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("anthropic")).toBe("Anthropic");
    expect(providerLabel("openrouter")).toBe("OpenRouter");
    expect(providerLabel("local")).toBe("Local OpenAI-compatible");
  });

  test("returns model placeholders", () => {
    expect(modelPlaceholderForProvider("openai")).toBe("gpt-5.4");
    expect(modelPlaceholderForProvider("local")).toBe("llama3.2");
  });

  test("omits blank credential replacements", () => {
    expect(shouldSendCredential("")).toBe(false);
    expect(shouldSendCredential("   ")).toBe(false);
    expect(shouldSendCredential("sk-test")).toBe(true);
  });

  test("creates local draft with base url", () => {
    expect(defaultDraftForProvider("local")).toEqual({
      provider: "local",
      model: "llama3.2",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/desktop/ui/src/lib/modelSettings.test.ts`

Expected: FAIL because `modelSettings.ts` does not exist.

- [ ] **Step 3: Implement helpers**

Create `apps/desktop/ui/src/lib/modelSettings.ts`:

```ts
import type { AgentProviderConfig, ModelProvider } from "@tessera/contracts";

export const MODEL_PROVIDERS: ModelProvider[] = ["openai", "anthropic", "openrouter", "local"];

export function providerLabel(provider: ModelProvider): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "openrouter":
      return "OpenRouter";
    case "local":
      return "Local OpenAI-compatible";
  }
}

export function modelPlaceholderForProvider(provider: ModelProvider): string {
  switch (provider) {
    case "openai":
      return "gpt-5.4";
    case "anthropic":
      return "claude-sonnet-4-6";
    case "openrouter":
      return "openai/gpt-5.4";
    case "local":
      return "llama3.2";
  }
}

export function defaultDraftForProvider(provider: ModelProvider): AgentProviderConfig {
  if (provider === "local") {
    return {
      provider,
      model: modelPlaceholderForProvider(provider),
      baseUrl: "http://127.0.0.1:11434/v1",
    };
  }
  return {
    provider,
    model: modelPlaceholderForProvider(provider),
  };
}

export function shouldSendCredential(value: string): boolean {
  return value.trim().length > 0;
}
```

- [ ] **Step 4: Run UI helper tests**

Run: `bun test apps/desktop/ui/src/lib/modelSettings.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/ui/src/lib/modelSettings.ts apps/desktop/ui/src/lib/modelSettings.test.ts
git commit -m "Centralize model settings UI helpers" \
  -m "Provider labels, defaults, and credential replacement rules need one small UI boundary before building the settings screen." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: bun test apps/desktop/ui/src/lib/modelSettings.test.ts"
```

### Task 6: Build Settings UI And Rail User Menu

**Files:**
- Modify: `apps/desktop/ui/src/components/RailNav.tsx`
- Create: `apps/desktop/ui/src/components/SettingsView.tsx`
- Modify: `apps/desktop/ui/src/App.tsx`

- [ ] **Step 1: Update RailNav props and menu**

Replace `apps/desktop/ui/src/components/RailNav.tsx` with a rail that takes user-menu callbacks:

```tsx
import { Button } from "@/components/ui/button";
import { Blocks, CheckCircle2, FolderTree, LogOut, MessageSquare, Settings, Sparkles, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type SidebarMode = "files" | "tasks";

interface RailNavProps {
  mode: SidebarMode;
  onLogout: () => void;
  onModeChange: (mode: SidebarMode) => void;
  onOpenSettings: () => void;
}

export function RailNav({ mode, onLogout, onModeChange, onOpenSettings }: RailNavProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemClass = (active: boolean) =>
    active
      ? "rounded-full bg-background text-foreground shadow-sm hover:bg-background"
      : "rounded-full text-muted-foreground hover:text-foreground";

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  return (
    <nav className="relative flex w-16 flex-shrink-0 flex-col items-center gap-6 border-r border-border bg-secondary py-4">
      <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-background text-primary shadow-sm">
        <div className="absolute -left-[18px] top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary" />
        <Blocks size={20} strokeWidth={2.5} />
      </div>
      <div className="flex flex-col gap-4">
        <Button type="button" variant="ghost" size="icon" className={itemClass(mode === "files")} onClick={() => onModeChange("files")} title="Files">
          <FolderTree size={20} />
        </Button>
        <Button type="button" variant="ghost" size="icon" className={itemClass(mode === "tasks")} onClick={() => onModeChange("tasks")} title="Tasks">
          <CheckCircle2 size={20} />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="rounded-full text-muted-foreground hover:text-foreground" title="Messages">
          <MessageSquare size={20} />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="rounded-full text-muted-foreground hover:text-foreground" title="Agents">
          <Sparkles size={20} />
        </Button>
      </div>
      <div className="mt-auto" ref={menuRef}>
        {menuOpen && (
          <div className="absolute bottom-4 left-14 z-20 w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
            <Button type="button" variant="ghost" className="h-8 w-full justify-start rounded-md px-2 text-xs" onClick={() => { setMenuOpen(false); onOpenSettings(); }}>
              <Settings size={14} />
              Settings
            </Button>
            <Button type="button" variant="ghost" className="h-8 w-full justify-start rounded-md px-2 text-xs text-muted-foreground" onClick={() => { setMenuOpen(false); onLogout(); }}>
              <LogOut size={14} />
              Logout
            </Button>
          </div>
        )}
        <Button type="button" variant="ghost" size="icon" className="rounded-full bg-background text-foreground shadow-sm hover:bg-background" title="User menu" onClick={() => setMenuOpen((open) => !open)}>
          <User size={18} />
        </Button>
      </div>
    </nav>
  );
}
```

- [ ] **Step 2: Create SettingsView**

Create `apps/desktop/ui/src/components/SettingsView.tsx` with provider form, save/delete/test buttons, and status messages. Keep it unframed and app-level:

```tsx
import { Button } from "@/components/ui/button";
import {
  MODEL_PROVIDERS,
  defaultDraftForProvider,
  modelPlaceholderForProvider,
  providerLabel,
  shouldSendCredential,
} from "@/lib/modelSettings";
import type {
  AgentProviderConfig,
  ModelConnectionTestResult,
  ModelProvider,
  ModelSettingsRead,
} from "@tessera/contracts";
import { invoke } from "@tauri-apps/api/core";
import { KeyRound, Trash2, Wifi } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface SettingsViewProps {
  onClose: () => void;
}

export function SettingsView({ onClose }: SettingsViewProps) {
  const [settings, setSettings] = useState<ModelSettingsRead | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ModelProvider>("openai");
  const [draft, setDraft] = useState<AgentProviderConfig>(defaultDraftForProvider("openai"));
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadSettings();
  }, []);

  async function loadSettings() {
    setBusy(true);
    setStatus(null);
    try {
      const loaded = await invoke<ModelSettingsRead>("model_settings_get");
      setSettings(loaded);
      setSelectedProvider(loaded.selectedProvider);
      setDraft(providerConfigFromSettings(loaded.providers[loaded.selectedProvider]));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const hasCredential = settings?.providers[selectedProvider]?.hasCredential ?? false;

  function selectProvider(provider: ModelProvider) {
    setSelectedProvider(provider);
    setApiKey("");
    const existing = settings?.providers[provider];
    setDraft(existing ? providerConfigFromSettings(existing) : defaultDraftForProvider(provider));
  }

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      const next = await invoke<ModelSettingsRead>("model_settings_save", {
        request: {
          selectedProvider,
          provider: draft,
          ...(shouldSendCredential(apiKey) ? { credential: { apiKey: apiKey.trim() } } : {}),
        },
      });
      setSettings(next);
      setApiKey("");
      setStatus("Model settings saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeKey() {
    setBusy(true);
    setStatus(null);
    try {
      const next = await invoke<ModelSettingsRead>("model_credential_delete", {
        request: { provider: selectedProvider },
      });
      setSettings(next);
      setApiKey("");
      setStatus("Stored key removed");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setStatus(null);
    try {
      const result = await invoke<ModelConnectionTestResult>("model_connection_test", {
        request: {
          provider: draft,
          ...(shouldSendCredential(apiKey) ? { credential: { apiKey: apiKey.trim() } } : {}),
        },
      });
      setStatus(result.message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const credentialPlaceholder = useMemo(() => {
    if (selectedProvider === "local") return "Optional local provider API key";
    return hasCredential ? "Saved key present" : "Paste API key";
  }, [hasCredential, selectedProvider]);

  return (
    <main className="flex min-w-0 flex-1 bg-background">
      <aside className="w-56 border-r border-border bg-secondary p-4">
        <div className="text-sm font-semibold text-foreground">Settings</div>
        <button type="button" className="mt-4 w-full rounded-md bg-background px-3 py-2 text-left text-sm font-medium text-foreground shadow-sm">
          Model
        </button>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto p-8">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-foreground">Model</h1>
              <p className="mt-1 text-sm text-muted-foreground">Global provider settings for every workspace.</p>
            </div>
            <Button type="button" variant="outline" onClick={onClose}>Close</Button>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3">
            {MODEL_PROVIDERS.map((provider) => (
              <button
                key={provider}
                type="button"
                className={`rounded-lg border p-3 text-left text-sm ${selectedProvider === provider ? "border-primary bg-card text-foreground shadow-sm" : "border-border bg-transparent text-muted-foreground"}`}
                onClick={() => selectProvider(provider)}
              >
                <div className="font-medium">{providerLabel(provider)}</div>
                <div className="mt-1 text-xs">{settings?.providers[provider]?.hasCredential ? "Key saved" : "No key saved"}</div>
              </button>
            ))}
          </div>

          <div className="mt-6 space-y-4">
            <label className="block text-sm font-medium text-foreground">
              Model
              <input className="input mt-2" value={draft.model} placeholder={modelPlaceholderForProvider(selectedProvider)} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
            </label>

            {draft.provider === "local" && (
              <label className="block text-sm font-medium text-foreground">
                Base URL
                <input className="input mt-2" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
              </label>
            )}

            <label className="block text-sm font-medium text-foreground">
              API key
              <input className="input mt-2" type="password" value={apiKey} placeholder={credentialPlaceholder} onChange={(event) => setApiKey(event.target.value)} />
            </label>

            {status && <div className="rounded-md border border-border bg-secondary px-3 py-2 text-sm text-foreground">{status}</div>}

            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={save} disabled={busy || draft.model.trim().length === 0}>
                <KeyRound size={16} />
                Save
              </Button>
              <Button type="button" variant="outline" onClick={testConnection} disabled={busy || draft.model.trim().length === 0}>
                <Wifi size={16} />
                Test connection
              </Button>
              <Button type="button" variant="outline" onClick={removeKey} disabled={busy || !hasCredential}>
                <Trash2 size={16} />
                Remove key
              </Button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function providerConfigFromSettings(settings: ModelSettingsRead["providers"][ModelProvider]): AgentProviderConfig {
  if (settings.provider === "local") {
    return { provider: "local", model: settings.model, baseUrl: settings.baseUrl };
  }
  return { provider: settings.provider, model: settings.model };
}
```

- [ ] **Step 3: Wire SettingsView in App**

Modify `apps/desktop/ui/src/App.tsx`:

```tsx
import { SettingsView } from "@/components/SettingsView";
```

Add state:

```tsx
const [settingsOpen, setSettingsOpen] = useState(false);
```

Add no-op logout:

```tsx
const handleLogout = () => {
  // Login/logout will be designed separately. This intentionally has no side effects.
};
```

Change rail:

```tsx
<RailNav
  mode={sidebarMode}
  onLogout={handleLogout}
  onModeChange={setSidebarMode}
  onOpenSettings={() => setSettingsOpen(true)}
/>
```

Render settings instead of workspace content when open:

```tsx
{settingsOpen ? <SettingsView onClose={() => setSettingsOpen(false)} /> : mainPane}
```

- [ ] **Step 4: Run UI typecheck**

Run: `bun run --filter './apps/desktop/ui' typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/ui/src/App.tsx apps/desktop/ui/src/components/RailNav.tsx apps/desktop/ui/src/components/SettingsView.tsx
git commit -m "Add global model settings UI" \
  -m "Users need a bottom rail account menu that opens app-level model settings while keeping Logout visible but inactive." \
  -m "Constraint: API key fields display only replacement input and redacted saved-key state" \
  -m "Confidence: medium" \
  -m "Scope-risk: moderate" \
  -m "Tested: bun run --filter './apps/desktop/ui' typecheck"
```

### Task 7: Full Verification And Visual QA

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test packages/contracts/src/model-settings.test.ts packages/core/src/model.test.ts apps/desktop/ui/src/lib/modelSettings.test.ts
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: PASS.

- [ ] **Step 2: Run workspace checks**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 3: Start the desktop UI dev server**

Run:

```bash
bun run --filter "./apps/desktop/ui" dev
```

Expected: Vite serves the UI, usually at `http://localhost:5173`.

- [ ] **Step 4: Manual browser QA**

Open the UI and verify:

- Rail shows user icon pinned at the bottom.
- Settings icon is no longer a main rail item.
- User icon opens a popup menu with `Settings` and `Logout`.
- `Logout` closes the menu and has no visible side effects.
- `Settings` opens the app-level Settings surface.
- `Model` section shows all four providers.
- OpenAI is default on a fresh settings file.
- Saving without an API key preserves any existing saved key.
- Saving with a new API key clears the input and changes provider status to `Key saved`.
- Reloading settings never displays the API key value.
- `Remove key` clears only the selected provider key.
- Local provider can be saved with base URL and no API key.
- Test connection without a cloud key reports the setup-required message.

- [ ] **Step 5: Commit verification fixes if needed**

If verification reveals defects, fix them in the smallest relevant file set and commit with a Lore message that names the failed check.

Example:

```bash
git add <fixed-files>
git commit -m "Fix model settings verification failure" \
  -m "Verification exposed a mismatch between the planned settings behavior and the implemented UI/runtime boundary." \
  -m "Constraint: Keep credential values out of React read responses" \
  -m "Confidence: medium" \
  -m "Scope-risk: narrow" \
  -m "Tested: bun run check"
```

---

## Self-Review

Spec coverage:

- Bottom rail user icon and popup menu: Task 6.
- Settings and Logout menu items: Task 6.
- Logout no-op: Task 6 and Task 7 manual QA.
- Global app-level Settings surface: Task 6.
- Four provider model settings: Tasks 1, 2, 5, and 6.
- Secure keychain storage: Task 2.
- Redacted reads: Tasks 1 and 2.
- Remove key: Tasks 2, 3, and 6.
- Connection test: Tasks 3 and 6.
- Runtime credential path: Tasks 1, 3, and 4.

Plan wording scan:

- The plan does not contain intentionally incomplete markers.
- Provider schema definitions are explicit and do not rely on optional Zod helpers.

Type consistency:

- Provider identifiers are `openai`, `anthropic`, `openrouter`, and `local` in TypeScript and lower-case serde output.
- Tauri command names match the spec: `model_settings_get`, `model_settings_save`, `model_credential_delete`, and `model_connection_test`.
- Credential values appear only in save/test request bodies, never in read response types.
