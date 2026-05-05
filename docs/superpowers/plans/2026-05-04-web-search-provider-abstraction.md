# Web Search Provider Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tessera's Brave-only `web-search search` path with a shared multi-provider search abstraction that supports preferred-provider routing, explicit opt-in keyless fallback, and exact-query caching without changing the shell command shape.

**Architecture:** Keep the CLI thin and move provider registry, dispatch, normalization, and cache behavior into `packages/core`. Add new search-specific contracts instead of overloading the existing cross-integration enums, then extend desktop settings so users can choose `auto` or a preferred search provider, store provider credentials, and explicitly enable a keyless fallback. Ship the first slice with `brave-search`, `tavily`, and an explicitly enabled `duckduckgo` keyless fallback.

**Tech Stack:** Bun, TypeScript, Zod, Tauri 2 Rust, OS keychain integration, existing shell runtime

---

## Commit Rule

Every commit in this repository must use:

- a conventional subject line
- a Lore body with native trailers from `AGENTS.md`

Use `git commit -F - <<'EOF' ... EOF` for each commit step below rather than a
single-line `git commit -m`.

---

## File Structure

### Shared contracts

- Modify: `packages/contracts/src/index.ts`
  - Keep `IntegrationProviderSchema` for top-level integrations like Brave Search and Google Calendar.
  - Add `SearchProviderSchema`, `SearchCapabilitySchema`, `SearchModeSchema`, `SearchResultSchema`, `WebSearchResultSchema`, and search settings schemas.
- Modify: `packages/contracts/src/integration-settings.test.ts`
  - Add search settings and normalized web-search payload coverage.

### Shared core search runtime

- Create: `packages/core/src/web-search.ts`
  - Own provider registry, eligibility rules, credential lookup interface, exact-query cache, and result normalization.
- Create: `packages/core/src/web-search.test.ts`
  - Cover dispatch order, fallback behavior, provider errors, and cache hits.
- Modify: `packages/core/src/index.ts`
  - Export the new web-search runtime.

### CLI shell path

- Modify: `apps/cli/src/shell.ts`
  - Replace Brave-specific search code with a thin call into `packages/core/src/web-search.ts`.
  - Add credential resolution for Tavily and keyless fallback settings.
- Modify: `apps/cli/src/shell.test.ts`
  - Assert the new normalized payload, preferred-provider behavior, and explicit fallback rules.
- Modify: `apps/cli/src/index.ts`
  - Keep the command listing stable.

### Shell runtime parser

- Modify: `packages/core/src/shell-runtime.ts`
  - Parse `web-search` stdout with the new generic schema instead of the Brave-only one.
- Modify: `packages/core/src/shell-runtime.test.ts`
  - Update parsed payload assertions and add generic diagnostics coverage.

### Desktop integration settings

- Modify: `apps/desktop/src-tauri/src/integration_settings.rs`
  - Add search-specific settings and provider enums while keeping existing top-level integration settings behavior intact.
- Modify: `apps/desktop/src-tauri/src/lib.rs`
  - Route search connection tests by selected search provider.

### Desktop UI

- Modify: `apps/desktop/ui/src/lib/integrationSettings.ts`
  - Export search provider labels, descriptions, and capability badges.
- Modify: `apps/desktop/ui/src/lib/integrationSettings.test.ts`
  - Cover search provider helper behavior.
- Modify: `apps/desktop/ui/src/components/SettingsView.tsx`
  - Replace the Brave-only copy in the Integrations tab with a search-provider configuration panel.

## Task 1: Extend shared contracts for search providers

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/integration-settings.test.ts`

- [ ] **Step 1: Write the failing contract tests**

Add these tests to `packages/contracts/src/integration-settings.test.ts`:

```ts
test("parses search settings with auto mode and explicit keyless fallback", () => {
  const parsed = IntegrationSettingsReadSchema.parse({
    providers: {
      braveSearch: { provider: "brave-search", hasCredential: true },
      googleCalendar: { provider: "google-calendar", hasCredential: false },
    },
    search: {
      mode: "auto",
      allowKeylessFallback: true,
      providers: {
        braveSearch: { provider: "brave-search", hasCredential: true },
        tavily: { provider: "tavily", hasCredential: false },
        duckduckgo: { provider: "duckduckgo", hasCredential: false },
      },
    },
  });

  expect(parsed.search.mode).toBe("auto");
  expect(parsed.search.allowKeylessFallback).toBe(true);
  expect(parsed.search.providers.tavily.provider).toBe("tavily");
});

test("parses normalized web-search payloads with diagnostics", () => {
  const parsed = WebSearchResultSchema.parse({
    query: "tessera",
    provider: "brave-search",
    capability: "search",
    cached: false,
    latencyMs: 42,
    results: [
      {
        title: "Tessera",
        url: "https://example.com",
        snippet: "Agent workspace",
        source: "example.com",
        position: 1,
      },
    ],
  });

  expect(parsed.provider).toBe("brave-search");
  expect(parsed.results[0]?.position).toBe(1);
});
```

- [ ] **Step 2: Run the contract tests to verify they fail**

Run: `bun test packages/contracts/src/integration-settings.test.ts`

Expected: FAIL with missing `search`, `SearchProviderSchema`, or `WebSearchResultSchema` errors.

- [ ] **Step 3: Add the minimal shared schemas**

Update `packages/contracts/src/index.ts` with search-specific contracts:

```ts
export const SearchProviderSchema = z.enum(["brave-search", "tavily", "duckduckgo"]);
export const SearchCapabilitySchema = z.enum(["search"]);
export const SearchModeSchema = z.union([z.literal("auto"), SearchProviderSchema]);

const SearchProviderSettingsSchema = z.object({
  provider: SearchProviderSchema,
  hasCredential: z.boolean().default(false),
});

export const WebSearchResultSchema = z.object({
  query: z.string().min(1),
  provider: SearchProviderSchema,
  capability: SearchCapabilitySchema,
  cached: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  results: z.array(
    z.object({
      title: z.string().min(1),
      url: z.string().url(),
      snippet: z.string().optional(),
      source: z.string().optional(),
      position: z.number().int().positive(),
    })
  ),
});

export const IntegrationSettingsReadSchema = z.object({
  providers: z.object({
    braveSearch: BraveSearchIntegrationSettingsSchema,
    googleCalendar: GoogleCalendarIntegrationSettingsSchema,
  }),
  search: z.object({
    mode: SearchModeSchema,
    allowKeylessFallback: z.boolean().default(false),
    providers: z.object({
      braveSearch: SearchProviderSettingsSchema.extend({ provider: z.literal("brave-search") }),
      tavily: SearchProviderSettingsSchema.extend({ provider: z.literal("tavily") }),
      duckduckgo: SearchProviderSettingsSchema.extend({ provider: z.literal("duckduckgo") }),
    }),
  }),
});
```

- [ ] **Step 4: Run the contract tests to verify they pass**

Run: `bun test packages/contracts/src/integration-settings.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/integration-settings.test.ts
git commit -F - <<'EOF'
feat(contracts): define multi-provider web search schema

Introduce search-specific contracts so multi-provider web search can evolve
without overloading the existing top-level integration enums.

Constraint: Existing gcal and integration settings contracts must remain valid
Confidence: high
Scope-risk: narrow
Directive: Keep search providers separate from generic integration providers
Tested: bun test packages/contracts/src/integration-settings.test.ts
Not-tested: Downstream consumer compilation
EOF
```

## Task 2: Build the shared core search dispatcher test-first

**Files:**
- Create: `packages/core/src/web-search.ts`
- Create: `packages/core/src/web-search.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing dispatcher tests**

Create `packages/core/src/web-search.test.ts` with these cases:

```ts
test("uses the preferred provider when it is configured", async () => {
  const result = await executeWebSearch(
    { query: "tessera", mode: "brave-search", allowKeylessFallback: false },
    {
      now: () => 1_000,
      fetchImpl: async () => new Response("", { status: 200 }),
      getCredential: async (provider) => (provider === "brave-search" ? "brave-test" : null),
      adapters: {
        "brave-search": async () => [{ title: "Tessera", url: "https://example.com" }],
        tavily: async () => [],
        duckduckgo: async () => [],
      },
    }
  );

  expect(result.provider).toBe("brave-search");
  expect(result.cached).toBe(false);
});

test("uses keyless fallback only when explicitly enabled", async () => {
  await expect(
    executeWebSearch(
      { query: "tessera", mode: "auto", allowKeylessFallback: false },
      {
        now: () => 1_000,
        fetchImpl: async () => new Response("", { status: 500 }),
        getCredential: async () => null,
        adapters: {
          "brave-search": async () => [],
          tavily: async () => [],
          duckduckgo: async () => [],
        },
      }
    )
  ).rejects.toThrow("No eligible search provider configured");
});

test("does not silently fail over from an explicit provider", async () => {
  await expect(
    executeWebSearch(
      { query: "tessera", mode: "tavily", allowKeylessFallback: true },
      {
        now: () => 1_000,
        fetchImpl: async () => new Response("", { status: 500 }),
        getCredential: async (provider) => (provider === "tavily" ? "tavily-test" : null),
        adapters: {
          "brave-search": async () => [],
          tavily: async () => {
            throw new Error("Tavily request failed");
          },
          duckduckgo: async () => [],
        },
      }
    )
  ).rejects.toThrow("Tavily request failed");
});
```

- [ ] **Step 2: Run the dispatcher tests to verify they fail**

Run: `bun test packages/core/src/web-search.test.ts`

Expected: FAIL because `executeWebSearch` and the search runtime do not exist yet.

- [ ] **Step 3: Implement the registry, dispatcher, and cache**

Create `packages/core/src/web-search.ts` with a single focused module:

```ts
type SearchProvider = "brave-search" | "tavily" | "duckduckgo";

const SEARCH_TTL_MS = 5 * 60 * 1000;
const CACHE = new Map<string, { expiresAt: number; value: WebSearchResult }>();

export async function executeWebSearch(
  request: { query: string; mode: "auto" | SearchProvider; allowKeylessFallback: boolean },
  context: SearchExecutionContext
): Promise<WebSearchResult> {
  const provider = await resolveProvider(request, context);
  const cacheKey = `${provider}::search::${request.query.trim().toLowerCase()}`;
  const cached = CACHE.get(cacheKey);
  if (cached && cached.expiresAt > context.now()) {
    return { ...cached.value, cached: true };
  }

  const startedAt = context.now();
  const results = await PROVIDERS[provider].search(request.query, context);
  const value: WebSearchResult = {
    query: request.query,
    provider,
    capability: "search",
    cached: false,
    latencyMs: context.now() - startedAt,
    results: results.map((item, index) => ({ ...item, position: index + 1 })),
  };
  CACHE.set(cacheKey, { expiresAt: context.now() + SEARCH_TTL_MS, value });
  return value;
}
```

- [ ] **Step 4: Export the shared runtime and rerun tests**

Update `packages/core/src/index.ts`:

```ts
export { executeWebSearch } from "./web-search.js";
```

Run: `bun test packages/core/src/web-search.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/web-search.ts packages/core/src/web-search.test.ts packages/core/src/index.ts
git commit -F - <<'EOF'
feat(core): add shared web search dispatcher

Move provider routing, normalization, and exact-query caching into shared
core logic so the CLI remains a thin transport layer.

Constraint: Preferred-provider failures must not silently fail over
Confidence: medium
Scope-risk: moderate
Directive: Add new search capabilities through the shared registry, not ad hoc CLI branches
Tested: bun test packages/core/src/web-search.test.ts
Not-tested: Live provider API behavior
EOF
```

## Task 3: Move the CLI onto the shared search runtime

**Files:**
- Modify: `apps/cli/src/shell.ts`
- Modify: `apps/cli/src/shell.test.ts`
- Modify: `apps/cli/src/index.ts`

- [ ] **Step 1: Write the failing CLI tests for the generic payload**

Update `apps/cli/src/shell.test.ts`:

```ts
test("returns the generic normalized web-search payload", async () => {
  const result = await executeCliCommand(["web-search", "search", "tessera"], {
    fetchImpl: async () =>
      new Response(JSON.stringify({ results: [{ title: "Tessera", url: "https://example.com" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    getBraveApiKey: async () => "brave-test",
    getTavilyApiKey: async () => null,
  });

  expect(JSON.parse(result.stdout)).toMatchObject({
    query: "tessera",
    provider: "brave-search",
    capability: "search",
    cached: false,
  });
});
```

- [ ] **Step 2: Run the CLI tests to verify they fail**

Run: `bun test apps/cli/src/shell.test.ts`

Expected: FAIL because `runWebSearch` still returns the Brave-only shape.

- [ ] **Step 3: Replace the Brave-specific search implementation**

Refactor `apps/cli/src/shell.ts`:

```ts
import { executeWebSearch } from "@tessera/core";

async function runWebSearch(args: string[], options: ExecuteCliCommandOptions) {
  const query = args.join(" ").trim();
  if (!query) throw new CliCommandError("Usage: web-search search <query>");

  const searchSettings = await (options.getSearchSettings?.() ?? getSearchSettingsFromSystem());

  return executeWebSearch(
    {
      query,
      mode: searchSettings.mode,
      allowKeylessFallback: searchSettings.allowKeylessFallback,
    },
    {
      now: () => Date.now(),
      fetchImpl: options.fetchImpl ?? fetch,
      getCredential: async (provider) => {
        if (provider === "brave-search") return options.getBraveApiKey?.() ?? getBraveApiKeyFromSystem();
        if (provider === "tavily") return options.getTavilyApiKey?.() ?? getTavilyApiKeyFromSystem();
        return null;
      },
    }
  );
}
```

- [ ] **Step 4: Run the CLI tests to verify they pass**

Run: `bun test apps/cli/src/shell.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/shell.ts apps/cli/src/shell.test.ts apps/cli/src/index.ts
git commit -F - <<'EOF'
feat(cli): route web search through shared provider runtime

Replace the Brave-specific search implementation with a thin call into the
shared dispatcher so provider logic stops diverging across entrypoints.

Constraint: Keep the `web-search search <query>` command stable
Confidence: medium
Scope-risk: moderate
Directive: Do not reintroduce provider-specific branching inside the CLI command handler
Tested: bun test apps/cli/src/shell.test.ts
Not-tested: Desktop-managed search settings reads
EOF
```

## Task 4: Update shell-runtime parsing to the generic search schema

**Files:**
- Modify: `packages/core/src/shell-runtime.ts`
- Modify: `packages/core/src/shell-runtime.test.ts`

- [ ] **Step 1: Write the failing parser test**

Update `packages/core/src/shell-runtime.test.ts`:

```ts
test("parses generic web-search payloads from workspace cli stdout", async () => {
  const executor = createSpawnShellExecutor({
    async runWorkspaceCli() {
      return {
        stdout: JSON.stringify({
          query: "tessera",
          provider: "brave-search",
          capability: "search",
          cached: false,
          latencyMs: 12,
          results: [{ title: "Tessera", url: "https://example.com", position: 1 }],
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 12,
      };
    },
  });

  const result = await executor.executeShell({ command: "web-search", subcommand: "search", args: ["tessera"] });
  expect(result.parsed).toMatchObject({ provider: "brave-search", capability: "search" });
});
```

- [ ] **Step 2: Run the shell-runtime tests to verify they fail**

Run: `bun test packages/core/src/shell-runtime.test.ts`

Expected: FAIL with schema mismatch because the parser still expects the Brave-only contract.

- [ ] **Step 3: Swap in the generic schema**

Update `packages/core/src/shell-runtime.ts`:

```ts
import { WebSearchResultSchema } from "@tessera/contracts";

if (call.command === "web-search") {
  return WebSearchResultSchema.parse(json);
}
```

- [ ] **Step 4: Run the shell-runtime tests to verify they pass**

Run: `bun test packages/core/src/shell-runtime.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/shell-runtime.ts packages/core/src/shell-runtime.test.ts
git commit -F - <<'EOF'
feat(core): parse generic web search shell results

Update shell-runtime validation to accept the new provider-agnostic search
payload instead of the legacy Brave-only shape.

Constraint: Shell runtime errors must stay stable for agent consumers
Confidence: high
Scope-risk: narrow
Directive: Validate the generic search schema at this boundary before exposing parsed payloads
Tested: bun test packages/core/src/shell-runtime.test.ts
Not-tested: Other shell command parsers
EOF
```

## Task 5: Extend desktop settings and connection tests for search routing

**Files:**
- Modify: `apps/desktop/src-tauri/src/integration_settings.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing settings and connection-path tests**

Add or extend Rust-side tests around serialized settings and connection test routing:

```rust
#[test]
fn default_settings_include_search_preferences() {
    let settings = default_settings_file();
    assert_eq!(settings.search.mode, SearchMode::Auto);
    assert!(!settings.search.allow_keyless_fallback);
}

#[test]
fn search_provider_labels_cover_tavily_and_duckduckgo() {
    assert_eq!(SearchProvider::Tavily.label(), "Tavily");
    assert_eq!(SearchProvider::DuckDuckGo.label(), "DuckDuckGo");
}
```

- [ ] **Step 2: Run the desktop Rust tests to verify they fail**

Run: `bun test` is not sufficient here. Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml integration_settings`

Expected: FAIL because the search settings structs and providers do not exist yet.

- [ ] **Step 3: Add search settings and provider-aware connection routing**

Update `apps/desktop/src-tauri/src/integration_settings.rs` and `apps/desktop/src-tauri/src/lib.rs`:

```rust
#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SearchProvider {
    BraveSearch,
    Tavily,
    DuckDuckGo,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSettings {
    pub mode: SearchMode,
    pub allow_keyless_fallback: bool,
    pub providers: SearchProviders,
}
```

And route connection tests with explicit search provider commands:

```rust
let command_args = match provider {
    SearchProvider::BraveSearch => vec!["web-search", "search", "tessera"],
    SearchProvider::Tavily => vec!["web-search", "search", "tessera"],
    SearchProvider::DuckDuckGo => vec!["web-search", "search", "tessera"],
};
```

- [ ] **Step 4: Run the Rust tests to verify they pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml integration_settings`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/integration_settings.rs apps/desktop/src-tauri/src/lib.rs
git commit -F - <<'EOF'
feat(desktop): persist search provider preferences

Teach the desktop backend to store search-provider mode, per-provider
credential status, and explicit keyless fallback preference.

Constraint: Existing non-search integrations must keep working unchanged
Confidence: medium
Scope-risk: moderate
Directive: Keep search settings additive rather than rewriting top-level integration storage
Tested: cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml integration_settings
Not-tested: Real OS keychain interactions across all providers
EOF
```

## Task 6: Update the desktop Integrations UI for search providers

**Files:**
- Modify: `apps/desktop/ui/src/lib/integrationSettings.ts`
- Modify: `apps/desktop/ui/src/lib/integrationSettings.test.ts`
- Modify: `apps/desktop/ui/src/components/SettingsView.tsx`

- [ ] **Step 1: Write the failing UI helper tests**

Add tests to `apps/desktop/ui/src/lib/integrationSettings.test.ts`:

```ts
test("labels search providers and exports the list", () => {
  expect(searchProviderLabel("brave-search")).toBe("Brave Search");
  expect(searchProviderLabel("tavily")).toBe("Tavily");
  expect(SEARCH_PROVIDERS).toEqual(["brave-search", "tavily", "duckduckgo"]);
});
```

- [ ] **Step 2: Run the UI helper tests to verify they fail**

Run: `bun test apps/desktop/ui/src/lib/integrationSettings.test.ts`

Expected: FAIL because the search helper exports do not exist yet.

- [ ] **Step 3: Replace the Brave-only panel with search settings**

Update `apps/desktop/ui/src/lib/integrationSettings.ts` and `apps/desktop/ui/src/components/SettingsView.tsx`:

```ts
export const SEARCH_PROVIDERS: SearchProvider[] = ["brave-search", "tavily", "duckduckgo"];

export function searchProviderLabel(provider: SearchProvider): string {
  switch (provider) {
    case "brave-search":
      return "Brave Search";
    case "tavily":
      return "Tavily";
    case "duckduckgo":
      return "DuckDuckGo";
  }
}
```

And in `SettingsView.tsx`, render:

```tsx
<Select value={searchMode} onValueChange={setSearchMode}>
  <option value="auto">Auto select</option>
  <option value="brave-search">Brave Search</option>
  <option value="tavily">Tavily</option>
</Select>

<label className="flex items-center gap-2">
  <input
    type="checkbox"
    checked={allowKeylessFallback}
    onChange={(event) => setAllowKeylessFallback(event.target.checked)}
  />
  <span>Allow keyless fallback (DuckDuckGo)</span>
</label>
```

- [ ] **Step 4: Run the UI tests to verify they pass**

Run: `bun test apps/desktop/ui/src/lib/integrationSettings.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/ui/src/lib/integrationSettings.ts apps/desktop/ui/src/lib/integrationSettings.test.ts apps/desktop/ui/src/components/SettingsView.tsx
git commit -F - <<'EOF'
feat(ui): add search provider settings panel

Replace the Brave-only integration copy with a search-provider configuration
panel that exposes mode selection, credentials, and explicit keyless fallback.

Constraint: Preserve the current Integrations tab information density
Confidence: medium
Scope-risk: moderate
Directive: Keep provider management simple; avoid turning this into a full admin console
Tested: bun test apps/desktop/ui/src/lib/integrationSettings.test.ts
Not-tested: Manual visual QA in the running desktop app
EOF
```

## Task 7: Run end-to-end verification

**Files:**
- No code changes expected

- [ ] **Step 1: Run focused tests for the changed units**

Run:

```bash
bun test packages/contracts/src/integration-settings.test.ts
bun test packages/core/src/web-search.test.ts
bun test packages/core/src/shell-runtime.test.ts
bun test apps/cli/src/shell.test.ts
bun test apps/desktop/ui/src/lib/integrationSettings.test.ts
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml integration_settings
```

Expected: PASS on all commands

- [ ] **Step 2: Run the repo-wide quality check**

Run: `bun run check`

Expected: PASS

- [ ] **Step 3: Manual smoke test the desktop flow**

Run: `bun run --filter './apps/desktop' dev`

Expected: The Integrations tab shows search provider settings, connection tests succeed for configured providers, and `web-search search tessera` returns normalized JSON with `provider`, `capability`, `cached`, and `latencyMs`.

- [ ] **Step 4: Final commit if verification required follow-up fixes**

```bash
git add -A
git commit -F - <<'EOF'
chore(search): finalize provider abstraction verification fixes

Capture any final cleanup required after focused tests, type checks, and
manual smoke testing of the multi-provider search flow.

Constraint: Verification-only changes should stay small and reversible
Confidence: medium
Scope-risk: narrow
Directive: Separate follow-up product changes from verification fixes
Tested: bun run check and focused test suite
Not-tested: Long-lived cache eviction behavior over real wall-clock time
EOF
```

## Self-Review

- Spec coverage: the plan covers contracts, shared dispatch, CLI migration, runtime parsing, desktop settings, UI, fallback policy, and cache behavior.
- Placeholder scan: no `TODO`, `TBD`, or "handle this later" language remains.
- Type consistency: the plan consistently uses `SearchProvider`, `SearchMode`, `WebSearchResultSchema`, and `executeWebSearch`.
