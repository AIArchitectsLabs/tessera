# Web Search Provider Abstraction Design

## Summary

Tessera's current `web-search search` path is Brave-only. This design evolves that
surface into a shared capability-based abstraction that supports multiple search
providers through one stable contract.

The first shipped slice remains intentionally narrow:

- one user-facing shell command: `web-search search <query>`
- one shipped capability: `search`
- shared provider resolution in `packages/core`
- optional keyless fallback only when explicitly enabled by the user
- exact-query TTL caching

This design deliberately avoids a heavyweight plugin framework in v1. The goal is
to establish a durable registry and dispatch boundary that can later grow into
additional capabilities like `extract`, `answer`, and `highlights`.

## Goals

- Preserve a single stable `web-search` abstraction for agents and CLI callers.
- Support multiple providers without changing the shell tool schema.
- Centralize provider selection and normalization in shared core logic.
- Allow richer providers to expose optional metadata without breaking callers.
- Improve day-one usability with an opt-in keyless fallback path.
- Prevent repeated identical queries from burning provider quota.

## Non-Goals

- Building a general plugin system for search backends.
- Shipping non-search capabilities in the first implementation.
- Designing provider-specific ranking controls or advanced tuning UI.
- Introducing silent cross-provider failover when an explicitly selected provider fails.

## Product Decisions

### Normalized response model

The abstraction uses a hybrid model:

- stable core fields for all providers
- optional provider extras for richer backends

The normalized response shape should include:

- `query`
- `provider`
- `capability`
- `cached`
- `latencyMs`
- `results[]`

Each result should include:

- `title`
- `url`
- `snippet`
- `source`
- `position`

Optional extras may include:

- `highlights`
- `answer`
- `citations`
- `rawMeta`

The stable core must be sufficient for all existing `web-search` consumption. The
optional extras exist so stronger providers do not get flattened into the lowest
common denominator.

### Fallback policy

The product uses a mixed fallback model:

- configured credentialed providers are preferred
- keyless providers are allowed only when the user explicitly enables fallback

This keeps zero-setup search available without silently changing the user's
privacy or trust posture.

### Provider selection

Provider resolution lives in shared core logic, not the CLI or UI. The CLI should
remain a thin adapter over shared dispatch.

### Caching

The first slice uses exact-query TTL caching only. Cache keys should include:

- provider id
- capability
- normalized query text
- any request options that affect search results

This keeps the first implementation predictable and low-risk while capturing most
of the quota-saving benefit.

## Architecture

The abstraction is split into three layers.

### 1. Provider registry

A typed registry declares the available providers and their metadata. Each entry
should define:

- provider id
- required credential type, if any
- supported capabilities
- whether keyless use is allowed
- auto-selection priority

Example initial provider set:

- `brave`
- `firecrawl`
- `tavily`
- `exa`
- `parallel`
- optional keyless fallback entries such as `duckduckgo` or `searxng`

The registry is a product boundary, not a plugin runtime. Providers are known and
shipped by Tessera.

### 2. Dispatcher

The dispatcher resolves a request to one provider in `packages/core`. Resolution
order:

1. explicitly selected provider, if usable
2. first configured provider that supports the requested capability
3. explicit user-enabled keyless fallback
4. otherwise fail with a clear configuration error

If the user explicitly selected a provider and it fails, the dispatcher should not
silently fall through to another provider unless a future setting explicitly opts
into that behavior.

### 3. Normalization boundary

Each provider adapter translates native API responses into the normalized Tessera
shape. Provider-specific metadata may be attached in optional fields, but the
normalized core should always be complete enough for shell and agent consumers.

## Component Responsibilities

### `packages/contracts`

- define search provider ids
- define capability enums
- define normalized search response schemas
- define integration settings shapes needed across process boundaries

### `packages/core`

- own the provider registry
- own provider capability metadata
- own dispatch and eligibility logic
- own fallback policy
- own adapter normalization
- own exact-query TTL cache

### `apps/cli`

- keep `web-search search <query>` thin
- build a `search` request
- call shared core dispatch
- print normalized JSON

### `apps/desktop/src-tauri`

- persist integration settings for multiple search providers
- persist preferred-provider or auto-selection mode
- persist keyless fallback enablement
- expose credential presence and connection test behavior

### `apps/desktop/ui`

Evolve the integration surface from a Brave-only panel into a search-provider
panel where users can:

- choose preferred provider or auto mode
- save credentials per provider
- enable or disable keyless fallback
- test provider connection
- view simple capability badges

The first slice should avoid a complex provider-management console. The UI should
optimize for clarity over configurability.

## Data Flow

For `web-search search "query"`:

1. CLI parses the query and creates a shared `search` request.
2. Core checks the exact-query TTL cache for the resolved provider path.
3. On cache miss, the dispatcher asks the registry for providers that support `search`.
4. Resolver applies preferred-provider, configured-provider, then user-enabled keyless fallback policy.
5. Selected provider adapter executes the native request.
6. Adapter normalizes the native payload into the Tessera result shape.
7. Core writes the normalized result into cache.
8. CLI prints normalized JSON.
9. Shell runtime validates the parsed payload against shared contracts.

The normalized result should include lightweight diagnostics for debuggability:

- `provider`
- `capability`
- `cached`
- `latencyMs`

## Error Handling

The abstraction should fail in provider-neutral language first, with provider
detail attached in diagnostics where useful.

Recommended error classes:

- `no_provider_available`
- `provider_not_configured`
- `provider_request_failed`
- `normalization_failed`
- `unsupported_capability`

Behavioral rules:

- CLI surfaces concise human-readable errors on stderr.
- Internal layers may preserve structured error details.
- "Test connection" should stay provider-specific and actionable.
- Explicit provider selection should not silently degrade into another provider.

## Testing Strategy

### Contract tests

- provider ids
- capability enums
- normalized schema evolution
- integration settings schema changes

### Dispatcher tests

- preferred-provider routing
- auto-select routing
- keyless fallback enablement
- unsupported capability rejection
- exact-query cache hits
- explicit provider failure does not silently fail over

### Adapter tests

- native fixture to normalized output mapping per provider

### CLI and runtime tests

- stable `web-search search` output shape
- shell runtime parsing for normalized responses

## Rollout Shape

The first implementation should ship only the `search` capability end to end,
even if the internal registry and contract model allow later capabilities.

Suggested implementation order:

1. extend contracts for multi-provider search metadata
2. move provider dispatch into shared core
3. adapt CLI to call shared dispatch
4. extend integration settings for provider choice and fallback policy
5. add exact-query TTL cache
6. add one new non-Brave provider behind the normalized adapter path

This sequence reduces risk by separating structural change from provider count.

## Risks

- Overdesigning for future capabilities before the first multi-provider slice lands
- Leaking provider-specific semantics into normalized core fields
- Creating surprising behavior through silent fallback
- Expanding UI complexity faster than the underlying product value

## Open Questions Deferred From This Slice

- Which provider should be the first non-Brave backend after the abstraction lands
- Whether future capabilities should share one command namespace or branch into separate tools
- Whether provider-level health scoring should influence auto-selection
- Whether stale-while-revalidate caching is worth the added policy complexity

## Recommendation

Implement the capability-registry architecture now, but ship only the `search`
capability in the first slice. Keep the CLI thin, keep provider resolution in
shared core, keep fallback explicit, and keep caching simple.
