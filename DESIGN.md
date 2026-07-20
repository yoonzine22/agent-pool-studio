# Agent Pool Studio Design System

## 1. Atmosphere & Identity

Agent Pool Studio is a quiet, technical command deck: dense enough to supervise several coding agents, but calm enough that run state and required decisions are never lost in decoration. Its signature is the live execution graph, where restrained cyan edges connect tonal panels and status color appears only when work changes state.

## 2. Color

The implementation source of truth is `src/app/globals.css`. Values below document its semantic HSL tokens; themes may override values while preserving roles.

| Role | Token | Light | Dark / Void | Usage |
|---|---|---|---|---|
| Surface/base | `--background` | `0 0% 100%` | `215 27% 4%` | App background |
| Surface/card | `--card` | `0 0% 100%` | `220 30% 8%` | Panels and nodes |
| Surface/secondary | `--secondary` | `240 4.8% 95.9%` | `220 25% 11%` | Controls and selected rows |
| Surface/muted | `--muted` | `240 4.8% 95.9%` | `220 20% 14%` | Quiet fills and disabled states |
| Text/primary | `--foreground` | `240 10% 3.9%` | `210 20% 92%` | Main copy |
| Text/secondary | `--muted-foreground` | `240 3.8% 46.1%` | `220 15% 50%` | Metadata and hints |
| Border/default | `--border` | `240 5.9% 90%` | `220 20% 14%` | Panel and input boundaries |
| Accent/primary | `--primary` | `240 5.9% 10%` | `187 82% 53%` | Primary actions, focus, active graph edges |
| Status/success | `--success` | `142 71% 45%` | `160 60% 52%` | Completed and healthy |
| Status/warning | `--warning` | `38 92% 50%` | `38 92% 50%` | Waiting and approval required |
| Status/error | `--destructive` | `0 84.2% 60.2%` | `0 72% 51%` | Failed and destructive |
| Status/info | `--info` | `217 91% 60%` | `187 82% 53%` | Running and informational |
| Runtime/Codex | `--void-cyan` | `187 82% 40%` | `187 82% 53%` | Codex identity accent |
| Runtime/Antigravity | `--void-violet` | `263 70% 55%` | `263 90% 66%` | Antigravity identity accent |

Rules:

- Use Tailwind semantic utilities such as `bg-card`, `text-foreground`, `border-border`, and `text-primary`; never duplicate token values in components.
- Accent color communicates interaction or live execution, not decoration.
- Runtime identity never replaces status color. A running Antigravity agent is violet by identity and cyan/info by status.
- The existing theme classes may change values, but every component keeps the semantic token role.

## 3. Typography

| Level | Utility | Weight | Usage |
|---|---|---|---|
| Page title | `text-xl` | 600 | Primary panel heading |
| Section title | `text-base` | 600 | Major card or inspector section |
| Card title | `text-sm` | 600 | Agent and workflow node names |
| Body | `text-sm` | 400 | Default operational copy |
| Metadata | `text-xs` | 400–500 | Status, time, runtime, labels |
| Micro label | `text-2xs` | 500–600 | Compact badges only |

- Primary: Inter through the `--font-inter` Next font variable.
- Mono: JetBrains Mono through `--font-jetbrains-mono`, for run identifiers, commands, models, and paths.
- User-facing body copy stays at `text-sm` or larger. `text-2xs` is reserved for nonessential badge metadata.
- Labels use sentence case; uppercase is reserved for short runtime/status overlines.

## 4. Spacing & Layout

All spacing follows Tailwind's 4px base unit.

| Intent | Token / utility | Usage |
|---|---|---|
| Tight | `gap-1`, `p-1` | Icon-to-label and dense badges |
| Compact | `gap-2`, `p-2` | Inline controls and node internals |
| Standard | `gap-3`, `p-3` | Form fields and compact cards |
| Comfortable | `gap-4`, `p-4` | Panels and page regions |
| Section | `gap-6`, `p-6` | Major page groups where space allows |

- The application is a fixed-sidenav shell. The page frame stays fixed; the active panel body owns vertical scroll.
- Full-height regions use `100dvh` semantics. Scrollable flex/grid children require `min-h-0`.
- Pool and team card grids use `repeat(auto-fit, minmax(min(16rem, 100%), 1fr))` or equivalent Tailwind responsive grids, with no primary horizontal scroll at 375px.
- The workflow canvas may pan and zoom in two dimensions; its adjacent inspector reflows below the canvas at narrow widths.
- Primary content must remain readable at 200% zoom and with long agent names, paths, and unbroken run identifiers.

## 5. Components

### Panel

- **Structure**: heading/action cluster, optional status summary, scroll body.
- **Variants**: standard, inset, empty, error.
- **Spacing**: `p-4`, `gap-4`; dense inspector sections may use `p-3`.
- **States**: default, loading skeleton, empty explanation, recoverable error.
- **Accessibility**: semantic heading order; error copy linked to retry action.
- **Motion**: optional 150ms opacity entry; none for static containers.
- **Layout**: scroll-body-shell; body is the named scroll owner.

### Button

- **Structure**: existing `Button` primitive with optional SVG icon and label.
- **Variants**: default, secondary, ghost, outline, destructive, success, link.
- **States**: hover, active, `focus-visible`, disabled, loading.
- **Accessibility**: visible focus ring, minimum 44px touch target when pointer is coarse, explicit accessible name for icon-only controls.
- **Motion**: 200ms color/opacity/transform transition only.

### Runtime Badge

- **Structure**: provider SVG mark or dot, runtime name, optional health indicator.
- **Variants**: Codex, Antigravity, unavailable.
- **States**: configured, ready, unavailable, authentication required.
- **Accessibility**: color is reinforced by text and status; never color-only.
- **Motion**: none; health changes announce through the surrounding live region.

### Agent Card

- **Structure**: avatar, name/role, runtime badge, status, current task, actions.
- **Variants**: pool item, team member, compact workflow assignee.
- **States**: idle, running, waiting approval, completed, failed, unavailable, selected.
- **Accessibility**: card selection is a button; nested actions remain separately reachable; status has textual equivalent.
- **Motion**: selected/running emphasis uses opacity and transform only and respects reduced motion.
- **Layout**: intrinsic grid item with long-label truncation and full accessible title.

### Workflow Node

- **Structure**: drag handle, node type, label, assigned agent, input/output ports, status footer.
- **Variants**: agent task, parallel split/join, approval, start, finish.
- **States**: idle, selected, running, waiting, completed, failed, disconnected.
- **Accessibility**: nodes are keyboard selectable; a list-based order editor is the non-pointer fallback; ports have descriptive labels.
- **Motion**: live status uses restrained opacity/glow; no continuous motion when reduced motion is requested.
- **Layout**: absolute canvas item; inspector owns editing fields.

### Run Timeline

- **Structure**: ordered events with time, agent, event type, message, and artifact/action.
- **Variants**: compact node preview and full run drawer.
- **States**: streaming, paused, approval required, completed, cancelled, failed, empty.
- **Accessibility**: `aria-live="polite"` for new noncritical events and explicit alert semantics for approval/failure.
- **Motion**: new events fade in at 150ms; existing rows do not shift unexpectedly.

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|---|---|---|---|
| Micro | 100–150ms | ease-out | Press, selection, event entry |
| Standard | 200ms | ease-out | Inspector, drawer, graph selection |
| Emphasis | 300ms | `cubic-bezier(0.16, 1, 0.3, 1)` | Run state transition |

- Motion explains state changes or spatial relationships only.
- Animate `transform`, `opacity`, and existing glow/filter effects; never animate layout dimensions or positions.
- `prefers-reduced-motion` disables nonessential animation through the existing global rule.
- Destructive actions and run cancellation require a confirmation boundary; reversible graph edits do not.

## 7. Depth & Surface

Strategy: **mixed tonal shift plus restrained borders**.

- `surface-0` through `surface-3` express hierarchy.
- Standard cards use `bg-card border border-border rounded-lg`.
- Elevated overlays may use the existing `glass-strong` or `void-panel` recipes.
- Glow is reserved for focus, live execution, or selected graph edges. Static content never glows.
- Workflow edges sit behind nodes; selected/live edges receive the primary accent without obscuring labels.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Target WCAG 2.2 AA: 4.5:1 body contrast, 3:1 large text and UI boundaries.
- Full keyboard access for pool actions, team membership, graph selection, inspector editing, run controls, and approvals.
- The graph has a non-spatial ordered-list editing fallback for screen-reader and keyboard users.
- Status never relies on color alone; every state includes text or an icon with an accessible name.
- Preserve browser zoom, responsive reflow at 375px, logical reading order, reduced motion, and visible focus.
- Korean and English copy must tolerate 200% text sizing and longer localized labels.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| Upstream uses `h-screen` in the root shell | `src/app/layout.tsx` | Pre-existing layout behavior; changing the global shell is outside the feature boundary until visual regression coverage is established. | Replace with dynamic viewport sizing after full-route regression coverage. |
| Several upstream panels use untyped legacy data | Existing panel files | Pre-existing code; new Agent Pool Studio modules remain strict and do not broaden the migration. | Remove as upstream panels are touched for product work. |
