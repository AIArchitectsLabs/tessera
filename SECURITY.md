# Security Policy

Tessera is a local-first desktop application that handles workspace files,
credentials, local sidecar communication, and approval-gated tool execution. We
take vulnerability reports seriously.

## Supported Versions

Tessera has not published a stable release yet. Security fixes target the main
branch until the first beta release channel is established.

## Reporting a Vulnerability

Please report vulnerabilities privately through GitHub Security Advisories:

https://github.com/AIArchitectsLabs/tessera/security/advisories

If that channel is unavailable, open a minimal public issue that says you need a
private security contact. Do not include exploit details, secrets, credentials,
private data, or reproduction artifacts in the public issue.

## What to Include

Helpful reports include:

- Affected area, such as desktop shell, sidecar transport, credentials, playbook
  import, workspace file access, or external connectors.
- Steps to reproduce.
- Expected and observed behavior.
- Impact and any known mitigations.
- Environment details, including operating system and Tessera commit if known.

## Security Boundaries

Please pay special attention to:

- Sidecar binding, bearer token, host, origin, and CORS behavior.
- Workspace path containment and symlink handling.
- OS keychain credential storage.
- Playbook package validation and script restrictions.
- Approval-gated writes to local files and external services.
- Logs, memory, docs, fixtures, and tests that could accidentally expose secrets.
