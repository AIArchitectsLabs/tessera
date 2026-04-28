# Tessera — Agent Instructions

> **AGENTS.md** delegates here. This is the single source of truth for all agent
> instructions across Claude Code, Codex, Gemini, and similar tools.

## What This Is

Tessera is an open-source Agent Workspace for business professionals. It ships as a
Tauri 2 desktop application with a Bun sidecar (agent runtime + MCP host) and a
React + Vite frontend.

## Stack

| Layer | Technology |
|-------|------------|
| Desktop shell | Tauri 2 (Rust) |
| Sidecar | Bun — HTTP + WebSocket server, agent runtime, MCP host |
| Sidecar binary | `bun build --compile` → single executable shipped as Tauri sidecar |
| Frontend | React + Vite + TypeScript (strict) |
| Shared types | Zod schemas + TS interfaces in `packages/contracts` |
| Lint / format | Biome (single tool — no ESLint, no Prettier) |
| Package manager | Bun workspaces (monorepo) |

## Repo Layout

```
tessera/
├── apps/
│   ├── desktop/            # Tauri shell + React UI
│   │   ├── src-tauri/      # Rust: window, sidecar lifecycle, OS APIs, secret injection
│   │   └── ui/             # React + Vite (imports packages/contracts only)
│   ├── sidecar/            # Bun HTTP+WS service: agent runtime, MCP host
│   └── cli/                # Bun CLI: headless agent runs, scripting
├── packages/
│   ├── contracts/          # Shared IPC types + Zod schemas
│   ├── core/               # Agent/MCP runtime logic — sidecar + CLI only, never UI
│   └── plugin-sdk/         # Public SDK for plugin / MCP server authors
├── plugins/                # First-party plugins (each a bun package)
├── docs/
└── .github/workflows/      # CI: lint, typecheck, test, cross-platform build
```

## Package Boundary Rules

Enforced via TypeScript project references. Do not violate these:

- `apps/desktop/ui` imports **only** from `packages/contracts` — never from `core`, `sidecar`, or `cli`.
- `apps/sidecar` and `apps/cli` may import from `contracts` and `core`.
- `plugins/*` depend on `plugin-sdk` only — never on `core` directly.
- `packages/plugin-sdk` is the only package external authors consume; its public API is semver-tracked.

## Security Defaults (Frontend ↔ Sidecar Transport)

All of the following are non-negotiable and must be enforced in code, not docs:

1. **Bind to `127.0.0.1` only** — never `0.0.0.0`. Assert this at startup.
2. **Default transport: Unix domain socket** (macOS/Linux) or **named pipe** (Windows) via `Bun.serve({ unix: ... })`. TCP only as an explicit dev-mode fallback.
3. **Ephemeral random port** for TCP fallback — injected into the webview via a Tauri command, never written to disk or logs.
4. **Bearer token** ≥256-bit CSPRNG, generated at sidecar boot, injected via Tauri command. Required on every HTTP request and every WS upgrade. Rotates each launch.
5. **`Host` header allowlist** — accept only `127.0.0.1:<port>` / `localhost:<port>`. Defeats DNS rebinding.
6. **`Origin` header allowlist** on WS upgrades — accept only the Tauri webview origin. No browser-tab connections.
7. **CORS closed** — no wildcard origins, no credentialed CORS for non-Tauri origins.
8. **Tauri CSP** locked in `tauri.conf.json` — no inline scripts, no unnecessary remote origins.
9. **Secrets in OS keychain** (Tauri `keyring` plugin) — never in plaintext config files or environment variables baked into the binary.

## Common Commands

```bash
bun install                                  # install all workspace deps
bun run dev                                  # all apps in dev mode (root script)
bun run --filter './apps/desktop' dev        # desktop only
bun run check                                # biome lint + format check + tsc
bun run --filter '*' test                    # all tests
bun run --filter './apps/sidecar' build      # compile sidecar binary
```

## Coding Standards

- TypeScript strict mode everywhere; no `any`, no `@ts-ignore` without a comment explaining why.
- Biome for all lint and format. Run `bun run check` before committing.
- No comments unless the **why** is non-obvious (hidden constraint, workaround, subtle invariant). Never comment what the code does.
- No abstractions beyond what the current task requires. Three similar lines beats a premature helper.
- Validate only at system boundaries (user input, external APIs). Trust internal types.

## Out of Scope (separate brainstorm → plan cycles)

Do not design or implement these without a separate spec:

- Agent runtime internals and model provider integration
- MCP host implementation and plugin loader semantics
- UI design system and panel architecture
- API key management and auth flows for third-party services
- Code signing, update channel, distribution packaging (Homebrew, winget, AppImage)
