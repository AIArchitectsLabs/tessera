# Tessera

> An open-source Agent Workspace for business professionals.

Tessera is a desktop application for turning repeatable business work into
guided, reviewable AI-assisted workflows. It runs a native Tauri shell, a local
Bun sidecar, and a React workspace UI so business users can import playbooks,
run tasks, review outputs, and keep work grounded in local workspace context.

> **Status:** Active local-first development. The desktop shell, sidecar,
> playbook runtime foundation, task views, settings, and public authoring docs
> are in place. Tessera is not packaged for general distribution yet.

---

## Try It Locally

Tessera is not available as a packaged installer yet, but developers can run the
desktop app directly from source:

```bash
git clone https://github.com/AIArchitectsLabs/tessera.git
cd tessera
bun install
bun run dev
```

`bun run dev` starts Tauri in development mode. On first run it builds the local
sidecar and CLI binaries, starts the React/Vite dev server, and opens the
Tessera desktop window.

You will need:

- [Rust](https://rustup.rs) stable
- [Bun](https://bun.sh) 1.1 or newer
- Platform build tools:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Linux:** `libwebkit2gtk`, `libssl-dev`, `libayatana-appindicator3-dev`
  - **Windows:** Microsoft C++ Build Tools

If the desktop window does not open, run `bun install` again after installing
the missing prerequisite, then retry `bun run dev`.

---

## Overview

Tessera is built around the idea that AI agents should feel like capable
colleagues, not chat windows. The core product surface is a workspace for
business playbooks: structured packages that define intake schemas, deterministic
scripts, prompts, review gates, and final artifacts for a repeatable business
process.

The current app includes:

- A Tauri desktop shell with a React/Vite UI.
- A local Bun sidecar for task execution, playbook import, graph runtime
  orchestration, optional capabilities, memory, browser helpers, and workspace
  tools.
- A dashboard, inbox, task detail view, file explorer, playbook catalog, and
  settings surfaces for model and integration configuration.
- Built-in graph playbook examples for sales, operations, and customer-success
  workflows.
- Public Mintlify docs for playbook authors under `docs/public`.

Tessera is designed to keep execution local-first. External playbook
repositories can author and validate package shape, but Tessera remains the
runtime that imports, executes, reviews, stores, and materializes playbook runs.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop shell | [Tauri 2](https://tauri.app) (Rust) |
| Sidecar runtime | [Bun](https://bun.sh) HTTP/WebSocket service |
| Frontend | React + Vite + TypeScript |
| Shared contracts | Zod schemas + TypeScript types |
| Package manager | Bun workspaces (monorepo) |
| Lint / format | [Biome](https://biomejs.dev) |
| Docs | [Mintlify](https://mintlify.com) |

## Repo Structure

```
tessera/
├── apps/
│   ├── desktop/            # Tauri shell
│   │   └── ui/             # React + Vite desktop UI
│   ├── sidecar/            # Bun service: task runtime, playbooks, MCP host
│   └── cli/                # Headless CLI for scripting and automation
├── docs/
│   └── public/             # Public Mintlify playbook-authoring docs
├── packages/
│   ├── contracts/          # Shared IPC/API types and Zod schemas
│   ├── core/               # Runtime logic shared by sidecar and CLI
│   └── plugin-sdk/         # SDK for building plugins and MCP servers
└── plugins/                # First-party plugins
```

## Common Commands

```bash
bun run dev                                  # launch the desktop app in dev mode
bun run --filter './apps/desktop/ui' dev     # run only the React UI dev server
bun run check                                # Biome check + workspace typecheck
bun run test                                 # run workspace tests
bun run build                                # build all workspace packages
bun run build:sidecar                        # compile the Bun sidecar binary
bun run docs:check                           # audit, style-check, and validate docs
bun run docs:validate                        # validate Mintlify docs
```

To preview the public docs locally:

```bash
cd docs/public
bunx mint@4.2.569 dev
```

## Beta Packaging

Large optional runtimes are installed on demand instead of bundled by default.
See [docs/beta-packaging.md](./docs/beta-packaging.md) for the Google Workspace
and browser automation beta story.

## Contributing

Tessera is open source and welcomes contributions. Before diving in:

1. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, workflow, and pull request expectations.
2. Read [CLAUDE.md](./CLAUDE.md) — it covers architecture, package boundaries,
   security requirements, and coding standards that all contributors (human and AI)
   are expected to follow.
3. Open an issue before starting large changes so we can discuss the approach.
4. Run `bun run check` before submitting a pull request.

## Security

Tessera runs a local HTTP/WebSocket server for frontend–sidecar communication.
By default it binds to a Unix domain socket (macOS/Linux) or named pipe (Windows)
with a per-session bearer token — no exposed TCP port, no remote access.

If you discover a security vulnerability, please report it privately via
[GitHub Security Advisories](https://github.com/AIArchitectsLabs/tessera/security/advisories)
rather than opening a public issue.

## License

[Apache 2.0](./LICENSE)
