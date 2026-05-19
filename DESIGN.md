# Design

## Source of truth
- Status: Draft
- Last refreshed: 2026-05-19
- Primary product surfaces: Desktop Playbooks view, guided playbook run canvas, run details panel.
- Evidence reviewed: `CLAUDE.md`, `docs/superpowers/specs/2026-05-08-guided-playbooks-ux-design.md`, `docs/superpowers/specs/2026-05-11-playbook-run-agent-and-usage-ux-design.md`, `docs/superpowers/specs/2026-05-18-playbook-execution-stabilization-design.md`, `apps/desktop/ui/src/components/PlaybooksView.tsx`, screenshot from 2026-05-19.

## Brand
- Personality: calm, capable, business-grade, quietly intelligent.
- Trust signals: plain-language status, clear next action, visible artifacts, accessible run details.
- Avoid: raw workflow IDs, internal queue terms, noisy logs as the main experience, decorative motion.

## Product goals
- Goals: help business users start, monitor, review, and reuse playbooks without operating a workflow console.
- Non-goals: expose a full graph debugger in the primary canvas or redesign global navigation.
- Success signals: current state is understandable from the main canvas, repeated internal steps are summarized, the latest meaningful update is visible without opening details.

## Personas and jobs
- Primary personas: business professionals running repeatable work such as briefs, status digests, risk reviews, and content preparation.
- User jobs: know what Tessera is doing, know whether action is needed, open the output, return later with confidence.
- Key contexts of use: desktop workspace, long-running playbook execution, occasional human review checkpoints.

## Information architecture
- Primary navigation: global rail plus Playbooks sidebar.
- Core routes/screens: Playbook start, preparing, review, result, optional run details.
- Content hierarchy: business state first, current focus second, latest update third, technical detail behind the details panel.

## Design principles
- Principle 1: the main canvas explains the business run state without requiring a log.
- Principle 2: progress should compress repeated work and show only one active motion cue.
- Tradeoffs: keep advanced evidence available, but make it secondary to outcome and current state.

## Visual language
- Color: warm neutral base with emerald for complete, blue for active work, amber for review or attention.
- Typography: existing Plus Jakarta Sans scale; compact operational headings, no oversized dashboard hero treatment.
- Spacing/layout rhythm: centered guided canvas with restrained cards and dense-but-readable rows.
- Shape/radius/elevation: 8px-ish rounded panels, light borders, minimal shadow.
- Motion: one active spinner at most in the progress canvas; avoid row-by-row animation.
- Imagery/iconography: lucide icons for status and actions only.

## Components
- Existing components to reuse: `Button`, `PlaybookRefreshButton`, `DashboardView`, `WorkspacePicker`.
- New/changed components: guided preparing progress summary, compact workflow rows, latest update panel.
- Variants and states: queued, working, done, review, attention, stopped, skipped.
- Token/component ownership: use existing Tailwind tokens and CSS variables in `apps/desktop/ui/src/index.css`.

## Accessibility
- Target standard: keyboard-accessible controls and readable contrast.
- Keyboard/focus behavior: action buttons remain standard buttons with visible focus rings.
- Contrast/readability: status chips use text and color together.
- Screen-reader semantics: latest update and workflow remain text content, not canvas-only visuals.
- Reduced motion and sensory considerations: keep progress motion minimal.

## Responsive behavior
- Supported breakpoints/devices: desktop-first Tauri shell with narrower responsive layouts.
- Layout adaptations: preparing view stacks latest update beneath progress on narrower widths.
- Touch/hover differences: controls must remain usable without hover-only discovery.

## Interaction states
- Loading: stable skeletons in sidebar, concise preparing state in canvas.
- Empty: ask user to choose a playbook or select a workspace.
- Error: show business-readable attention copy, technical detail in details panel.
- Success: show prepared artifacts and usage when available.
- Disabled: explain missing workspace, setup, or required input.
- Offline/slow network, if applicable: show latest known update and allow return later.

## Content voice
- Tone: direct, reassuring, and non-technical.
- Terminology: Playbook, preparing, review, result, latest update.
- Microcopy rules: avoid raw queue, lease, heartbeat, operation, or node-path vocabulary in the main canvas.

## Implementation constraints
- Framework/styling system: React, TypeScript, Tailwind, shadcn-style local UI primitives.
- Design-token constraints: reuse existing CSS variables and Tailwind utilities.
- Performance constraints: progress rendering must be derived from existing run detail/surface data without extra polling.
- Compatibility constraints: keep run details and graph runtime diagnostics available for dogfooding.
- Test/screenshot expectations: cover progress summarization and latest-update visibility with component tests; verify visually in the desktop UI or browser when possible.

## Open questions
- [ ] Should the sidecar emit a product-ready latest event string for every run state, or should the UI continue deriving it from queue/timeline data?
- [ ] When imported playbooks have many parallel branches, what is the maximum summary depth before the details panel should become the primary inspection path?
