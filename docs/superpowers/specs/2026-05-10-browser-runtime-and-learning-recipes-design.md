# Browser Runtime And Learning Recipes Design

## Summary

Tessera needs a real browser runtime behind the existing `browser` tool contract.
The runtime should help business users inspect public web pages, capture evidence,
and eventually repeat common web workflows without giving agents unrestricted
access to the user's normal browser session.

The first shipped slice is intentionally narrow:

- hybrid execution model, with headless background browsing first and supervised
  system-browser browsing later
- isolated Tessera-managed browser profile by default
- production browser executor backed by Playwright
- read-only research and inspection actions first
- a future local Chrome extension connector for supervised authenticated work
- reviewable browser recipe proposals generated from successful sessions
- no authenticated SaaS automation or form submission in the first slice

The design borrows the progressive-learning idea from Browser Harness, but does
not adopt Browser Harness directly. Tessera should learn reusable browser
recipes as reviewable business artifacts, not as hidden agent-written code.

## Goals

- Implement a real `BrowserExecutor` for the current `browser` tool surface.
- Give agents reliable read-only browser abilities for pages that plain fetch
  cannot inspect well.
- Keep browser state isolated from the user's everyday browser profile.
- Preserve user trust by making learned automation explicit, reviewable, and
  versioned.
- Shape the runtime so supervised authenticated workflows can be added later
  without replacing the core executor.
- Keep the first slice testable in CI with local pages and deterministic browser
  actions.

## Non-Goals

- Reusing the user's existing Chrome, Edge, or Safari profile.
- Logging into third-party business systems automatically.
- Submitting forms, uploading files, purchasing, sending messages, or changing
  external systems.
- Building a full browser recipe management UI in the first implementation.
- Requiring Browserbase cloud browsers, captcha solving, proxies, or remote
  browser infrastructure.
- Allowing agents to write executable helper code during browser runs.

## Product Decisions

### Hybrid Execution

Tessera should use a hybrid execution model:

- headless background browsing for low-risk read-only inspection
- local system-browser browsing for future login, form fill, and
  business-system actions

The first implementation should only ship the headless read-only side. The
interfaces should still carry enough session and page identity to support a
system-browser connector later.

### Isolated Browser Identity

Tessera should launch with an isolated browser profile stored under Tessera app
data. It must not attach to the user's normal browser profile by default. This
avoids silently exposing the user's personal cookies, history, extensions, and
business sessions to agents.

Future authenticated workflows can use either explicit per-domain connect flows
inside Tessera's isolated browser identity or a user-installed system browser
extension. The system-browser path must be opt-in because it uses the user's
real logged-in work context.

### Runtime Substrate

Playwright should be the execution substrate for the first production runtime.
It provides a mature cross-platform automation API for navigation, page text,
DOM inspection, screenshots, selectors, and local test servers.

Stagehand is a good future smart layer for resilient `observe`, `extract`, and
approved `act` behavior. It should not be required for the first runtime slice.

Browser Harness is useful inspiration for progressive learning, especially its
domain-skill model, but it should not be adopted directly because it is Python
and CDP oriented, favors attaching to a real user browser, and encourages the
agent to edit helpers during execution.

Claude in Chrome is a useful product reference for the supervised path. It uses
a Chrome extension side panel that can read, click, navigate, manage tabs, take
screenshots, and connect to desktop or CLI workflows. It also exposes explicit
permissions, workflow recording, scheduled tasks, and admin controls. Tessera
should borrow the local extension connector pattern, not the dependency on a
remote browser service.

### Progressive Learning

Progressive learning should produce draft browser recipes for review. Tessera
may automatically record successful observations and navigation traces, and may
propose reusable recipes. It must not silently promote those recipes into
trusted automation.

Recipes are product artifacts, closer to guided playbooks than to arbitrary
agent memory.

## Architecture

### 1. Browser Executor Boundary

The existing `BrowserExecutor` interface remains the integration boundary:

- `executeBrowser(input: BrowserActionInput): Promise<BrowserToolResult>`

The implementation should live in the sidecar/core boundary, where it can be
injected into task execution without importing browser automation into the
desktop UI.

### 2. Playwright Browser Runtime

The runtime owns:

- browser launch and shutdown
- isolated profile path resolution
- page registry
- default session creation
- navigation waits and timeouts
- text extraction
- screenshot capture
- basic page metadata
- action history used by recipe proposals

The first runtime should support these actions:

- `open`: open a URL in a managed page and return `sessionId`, `pageId`, `url`,
  summary, and metadata
- `see`: return visible text, title, URL, and lightweight page metadata
- `snap`: save a screenshot to a controlled artifact path and return the path
- `back`: navigate backward in the page history
- `reload`: reload the page
- `close`: close a managed page or session

`click`, `type`, `select`, and `eval` remain in the contract, but should be
feature-gated or approval-gated until supervised mode and stronger audit flows
exist. If these actions are not enabled, the runtime should return a clear
policy error instead of silently ignoring the request.

### 3. Browser Session Store

The runtime should keep an in-memory session store for active pages:

- `sessionId`
- `pageId`
- current URL
- title
- created and updated timestamps
- action history
- latest observation summary
- screenshot artifact paths

Persistent browser profile data belongs under app data. Session metadata may be
persisted later, but the first slice can keep active sessions in memory and write
only artifacts and draft recipe proposals.

### 4. Artifact Storage

Screenshots should be written to a controlled Tessera artifact directory, not to
arbitrary paths supplied by the model. Returned paths must be local artifact
paths suitable for task display.

The runtime should avoid storing full page HTML by default. Store extracted
visible text summaries and screenshots only when needed for the user-facing task
or recipe proposal.

### 5. Recipe Proposal Engine

After successful browser sessions, Tessera should be able to create a draft
recipe proposal. A recipe proposal should include:

- recipe id
- domain scope
- human-readable goal
- source task id or session id
- required permissions
- action sequence
- URLs or URL patterns
- selectors when available
- fallback text labels or accessible names
- expected page states
- captured outputs
- screenshot artifact references
- creation timestamp
- last verified timestamp, if any
- status

Recipes should be data-first. The first implementation should avoid executable
JavaScript or arbitrary code inside recipes.

### 6. System Browser Connector

The supervised lane should be a local browser extension connector, similar in
shape to Claude in Chrome:

- user installs a Tessera browser extension
- extension runs in the user's system Chrome profile
- extension shows an obvious active state while Tessera can see or act
- extension communicates with the Tessera sidecar over an authenticated local
  channel, such as native messaging or a localhost loopback connection
- user grants per-session or per-domain access before Tessera can inspect pages
- high-risk actions require a plan preview or per-action approval
- Tessera records browser actions as recipe candidates after successful runs

This connector is not part of the first browser runtime slice. It is the right
long-term mechanism for business workflows that need the user's real SaaS login
state, browser extensions, SSO, device trust, or CAPTCHA/manual-login handoff.

The system-browser connector must never become the default silent browser
runtime. Background read-only browsing should continue to use the isolated
Playwright runtime.

## Recipe Lifecycle

### Draft

Generated from a successful browser session. Draft recipes can be inspected,
edited later, and used for preview runs, but should not execute mutating actions
automatically.

### Reviewed

A user or admin has reviewed the recipe. Reviewed recipes may support read-only
repeat workflows such as finding account pages, extracting public profile
information, or navigating public documentation.

### Approved For Action

Required before recipes can include mutating steps such as typing into forms,
clicking submit, uploading files, sending messages, or changing SaaS records.
Even then, per-run approval may still be required depending on risk.

### Stale

A recipe becomes stale when selectors fail, expected page states are missing, the
domain changes substantially, or the recipe has not been verified recently. A
stale recipe should trigger live browser inspection and propose an update rather
than silently patching itself.

## Permissions And Safety

The current permission model is directionally correct:

- read-like browser actions such as `open`, `see`, `snap`, `back`, `reload`, and
  `close` can be allowed by default
- `click`, `type`, and `select` require approval or a promoted recipe
- `eval` always requires approval
- destructive or externally mutating actions remain denied or blocked until
  explicit supervised flows exist

The runtime must also enforce:

- HTTP and HTTPS URL validation for `open`
- default navigation timeout
- maximum extracted text length
- controlled screenshot paths
- clear errors for unsupported actions
- no arbitrary filesystem writes from browser actions
- no use of the user's default browser profile

The system-browser connector must add stronger controls:

- explicit installation and pairing with Tessera
- visible active indicator while a page is exposed to Tessera
- domain allowlist or per-session grant
- tab grouping or other visible separation for Tessera-controlled tabs
- plan approval before multi-step action
- mandatory pause on login, CAPTCHA, payment, password, or sensitive account
  changes
- admin allowlist and blocklist support for team deployments
- local audit trail of inspected domains, actions, and recipe proposals

## Data Flow

For `browser.open`:

1. Tool call reaches the browser executor.
2. Runtime validates the URL and resolves or creates a session.
3. Playwright opens the page using the isolated profile.
4. Runtime waits for a stable load state with a bounded timeout.
5. Runtime records page metadata and action history.
6. Runtime returns `BrowserToolResult` with `sessionId`, `pageId`, URL, summary,
   and metadata.

For `browser.see`:

1. Runtime resolves the page by `pageId`, or uses the active page.
2. Runtime extracts title, URL, visible text, selected headings, links, and form
   labels when available.
3. Runtime truncates content to a safe maximum.
4. Runtime records the observation.
5. Runtime returns the observation in `content` and structured metadata.

For recipe proposal:

1. Runtime receives a successful session close or task completion signal.
2. Proposal engine checks whether the action history is useful enough to save.
3. It builds a draft recipe scoped to the domain and task goal.
4. The draft is stored for future review.
5. The task can show a "recipe proposed" artifact or inbox item later.

For future system browser connector use:

1. User installs and pairs the Tessera browser extension with the local sidecar.
2. User grants Tessera access to the current tab, tab group, or domain.
3. Extension streams page observations, screenshots, console diagnostics, and
   approved actions to the sidecar.
4. Sidecar routes the observations through the same `BrowserExecutor` and
   recipe proposal boundaries.
5. Tessera pauses for user action on login, CAPTCHA, payment, or high-risk
   account changes.

## Component Responsibilities

### `packages/contracts`

- Keep browser action/result contracts stable.
- Add recipe proposal schemas when implementation begins.
- Add status enums for recipe lifecycle.
- Add connector capability fields later without changing the basic browser tool
  action names.

### `packages/core`

- Define browser runtime interfaces that remain independent of Playwright.
- Own recipe proposal data model and validation.
- Keep permission decisions separate from browser mechanics.

`packages/core` must not take a Playwright dependency in the first slice. The
runtime implementation belongs in `apps/sidecar` so browser packaging and app
data paths stay close to the desktop process boundary.

### `apps/sidecar`

- Instantiate the production browser executor.
- Resolve app-data paths for browser profile and artifacts.
- Inject the executor into task runs.
- Shut down browser resources when the sidecar exits.
- Own the Playwright dependency and browser installation assumptions.
- Later, expose a local authenticated connector endpoint for the system browser
  extension.

### `apps/desktop/ui`

- No full browser recipe management UI in the first slice.
- Display browser artifacts already returned through task artifacts.
- Later, add review surfaces for draft recipes.
- Later, add pairing and permission surfaces for the system browser connector.

### Browser Extension

- Not part of the first slice.
- Pair with the sidecar through a local authenticated channel.
- Run only after explicit user install and browser permission grants.
- Provide visible status, tab separation, and user controls.
- Support recording supervised workflows into draft browser recipes.

## Error Handling

Errors should be short and actionable:

- invalid URL
- browser runtime unavailable
- browser connector not paired
- connector permission denied
- page not found
- navigation timed out
- unsupported browser action
- action requires supervised mode
- screenshot failed
- content extraction failed

The runtime should include structured diagnostics in `BrowserToolResult.metadata`
when useful, but should not expose low-level Playwright stack traces to business
users.

## Testing Strategy

### Unit Tests

- action validation
- session store behavior
- result shaping
- recipe proposal construction
- permission behavior for gated actions

### Integration Tests

- local static HTTP server page open
- visible text extraction
- screenshot creation in controlled artifact directory
- back and reload behavior
- close behavior
- unsupported action error

### Manual QA

- desktop task asks agent to inspect a public page
- task receives visible browser output
- task receives screenshot artifact
- no user browser cookies are visible
- browser resources shut down after sidecar exit
- later: extension connector can be paired, visibly activated, denied, and
  disconnected without affecting the isolated runtime

## Implementation Planning Decisions

- Add Playwright to `apps/sidecar`, not `packages/core`.
- Enable the runtime in development and test builds first. Packaged desktop
  builds should gate browser execution behind a clear "browser runtime
  unavailable" error until browser binary packaging is solved.
- Use app-data subdirectories named `browser-profile`, `browser-artifacts`, and
  `browser-recipes`.
- Recipe proposals should create task artifacts in the first implementation.
  Inbox review can be added when the recipe review UI exists.
- Do not plan remote browser infrastructure for desktop workflows. If a user
  needs authenticated SaaS access, prefer the future local system browser
  connector over Browserbase-style hosted browser sessions.
- Do not implement the system browser connector in the first slice. Treat it as
  a second milestone after the isolated runtime and recipe proposal model are
  working.
