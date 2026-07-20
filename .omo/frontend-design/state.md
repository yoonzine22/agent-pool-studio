# Agent Pool Studio Frontend State

## Current Objective

Build and verify a self-hosted visual agent pool where Codex and Antigravity agents can be created, grouped into teams, connected in a workflow, run, approved, cancelled, and inspected.

## Locked Decisions

- Main base: the MIT-licensed Mission Control fork at `yoonzine22/agent-pool-studio`.
- Product name: Agent Pool Studio until the owner chooses another name.
- Surface: desktop web first; no native wrapper or mobile QA in the MVP.
- Runtime boundary: local process adapters; Codex through the `codex` CLI and Antigravity through the `agy` CLI.
- UI direction: preserve the extracted Void command-deck system in `DESIGN.md`.
- Agent execution remains local and workspace-scoped; the browser never receives provider secrets.

## Source Inputs

- `DESIGN.md`
- `src/app/globals.css`
- `src/components/ui/button.tsx`
- Mission Control agent, pipeline, approval, event, and workspace APIs.
- Hermes Studio crew/workflow concepts reviewed at `JPeetz/Hermes-Studio` under MIT.

## Design Brief

- Primary journey: create runtime-backed agents, assemble a team, assign graph nodes, run the graph, and understand what is happening without reading a terminal.
- Secondary journey: intervene through approval, cancel, retry, or inspect artifacts.
- Tone: concise operational Korean/English labels, explicit errors, no decorative copy.
- Taste: restrained dark command deck, semantic status color, graph as the focal operational object.

## Inclusive Personas

- Keyboard operator: completes every creation, assignment, run, approval, and cancel action without pointer input.
- Screen-reader operator: uses the ordered workflow fallback and textual timeline instead of relying on graph geometry.
- Low-vision operator: uses 200% zoom and increased text size without losing primary actions or introducing page-level horizontal scroll.
- Motion-sensitive operator: receives equivalent status feedback with reduced motion enabled.
- Interrupted operator: returns after an approval pause and can identify the pending decision and affected node immediately.

## Adaptive Preferences

- Respect current theme, reduced motion, browser zoom, keyboard focus, RTL shell support, and Korean/English locale expansion.
- Preserve a text status for every color-coded state.

## Verification Matrix

- TypeScript typecheck and targeted Vitest suites for models, routes, and runners.
- Production build.
- Real Codex smoke execution through the local adapter.
- Antigravity SDK readiness/error-path smoke test and real execution when local credentials are available.
- Desktop browser QA at 1280×720, including keyboard editing, long labels, runtime output, run state, and approval state. Mobile QA is explicitly out of scope.
- React static/runtime and Lighthouse checks against the production build.

## Design Debt Register

- See `DESIGN.md` Section 8. New debt must name affected users, severity, exact location, exit criteria, and owner acknowledgement.

## Evidence Index

- Final changed-area suite: 20 files / 86 tests passed; Studio suite: 73 / 73 passed.
- Full suite: 1,585 / 1,588 passed; the only failures are three unchanged Node 26 `localStorage` environment tests.
- Typecheck, lint, security audit, OpenAPI parity, production build, standalone artifact, real Codex/Antigravity runs, headed desktop Playwright, and independent visual/code/release gates passed.
