# Tessera

> An open-source Agent Workspace for business professionals.

Tessera is a desktop application that brings AI agents into your day-to-day work.
It runs locally on your machine — your data stays yours.

> **Status:** Early development. Not yet functional.

---

## Overview

Tessera is built around the idea that AI agents should feel like capable colleagues,
not chat windows. It provides a structured workspace where you can create, configure,
and run agents for research, writing, data work, and automation — all from a fast,
native desktop app.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop shell | [Tauri 2](https://tauri.app) (Rust) |
| Agent runtime | [Bun](https://bun.sh) sidecar process |
| Frontend | React + Vite + TypeScript |
| Package manager | Bun workspaces (monorepo) |
| Lint / format | [Biome](https://biomejs.dev) |

## Repo Structure

```
tessera/
├── apps/
│   ├── desktop/        # Tauri shell + React UI
│   ├── sidecar/        # Bun agent runtime + MCP host
│   └── cli/            # Headless CLI for scripting and automation
├── packages/
│   ├── contracts/      # Shared IPC types and Zod schemas
│   ├── core/           # Agent and MCP runtime logic
│   └── plugin-sdk/     # SDK for building plugins and MCP servers
└── plugins/            # First-party plugins
```

## Prerequisites

- [Rust](https://rustup.rs) (stable)
- [Bun](https://bun.sh) ≥ 1.1
- Platform build tools:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Linux:** `libwebkit2gtk`, `libssl-dev`, `libayatana-appindicator3-dev`
  - **Windows:** Microsoft C++ Build Tools

## Getting Started

```bash
git clone https://github.com/your-org/tessera.git
cd tessera
bun install
bun run dev
```

## Contributing

Tessera is open source and welcomes contributions. Before diving in:

1. Read [CLAUDE.md](./CLAUDE.md) — it covers architecture, package boundaries,
   security requirements, and coding standards that all contributors (human and AI)
   are expected to follow.
2. Open an issue before starting large changes so we can discuss the approach.
3. Run `bun run check` before submitting a pull request.

## Security

Tessera runs a local HTTP/WebSocket server for frontend–sidecar communication.
By default it binds to a Unix domain socket (macOS/Linux) or named pipe (Windows)
with a per-session bearer token — no exposed TCP port, no remote access.

If you discover a security vulnerability, please report it privately via
[GitHub Security Advisories](https://github.com/your-org/tessera/security/advisories)
rather than opening a public issue.

## License

[Apache 2.0](./LICENSE)
