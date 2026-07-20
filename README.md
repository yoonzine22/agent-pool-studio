<div align="center">

# Agent Pool Studio

Self-hosted command deck for building and operating Codex and Antigravity agent teams.

Dispatch tasks, inspect runs, review failures, track spend, and coordinate agent runtimes
from one local dashboard backed by SQLite.

Agent Pool Studio is this fork's focused Studio experience, built on [Mission Control by
Builderz Labs](https://github.com/builderz-labs/mission-control). Upstream documentation,
security guidance, and license terms remain applicable.

[![Quality Gate](https://github.com/yoonzine22/agent-pool-studio/actions/workflows/quality-gate.yml/badge.svg)](https://github.com/yoonzine22/agent-pool-studio/actions/workflows/quality-gate.yml)
[![Release](https://img.shields.io/github/v/release/yoonzine22/agent-pool-studio)](https://github.com/yoonzine22/agent-pool-studio/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<img src="docs/mission-control-overview.png" alt="Mission Control overview dashboard with active sessions, live activity, fleet status per runtime, and the task pipeline" width="900">

</div>

> [!WARNING]
> Mission Control is alpha software. APIs, schemas, and configuration may change between
> releases. Read the [security guidance](#security-boundary) before exposing it to a network.

## Agent Pool Studio quick start / 빠른 시작

Use this short path to create a team and run a visual workflow (한국어로 따라 하기: 설치 →
실행 → `/studio` 열기 → Pool → Team → Workflow → Run).

Prerequisites:

- Node.js **22 or newer** (`node --version`)
- [pnpm](https://pnpm.io/installation)
- An authenticated **Codex CLI** (`codex`) and **Antigravity CLI** (`agy`) available on `PATH`

From the repository root, install and start the local server:

```bash
pnpm install
pnpm dev
```

On the first visit, open `http://localhost:3000/setup` to create the local admin account;
then open `http://localhost:3000/studio` (or use the Studio link in the navigation).

The Studio flow is:

1. **Pool** — register Codex and Antigravity runtimes.
2. **Team** — compose a team from pool members.
3. **Workflow** — connect the visual graph and save it.
4. **Run** — start the workflow and monitor its timeline.

For a local installation that uses the default workspace (workspace ID `1`), set one explicit
root before starting the server. Every Studio agent workspace must be an existing directory
inside this root:

```bash
export MC_WORKSPACE_ROOT=/absolute/path/to/your/workspaces
export AGENT_STUDIO_CODEX_BIN=/absolute/path/to/codex
export AGENT_STUDIO_ANTIGRAVITY_BIN=/absolute/path/to/agy
pnpm dev
```

The two CLI path overrides are optional when `codex` and `agy` are already on `PATH`.
`MC_WORKSPACE_ROOT` is a quick-start fallback for workspace ID `1` only.

For multiple authenticated workspaces, configure an absolute root for each workspace ID with
a JSON object:

```bash
export MC_STUDIO_WORKSPACE_ROOTS='{"1":"/srv/agent-studio/workspace-1","2":"/srv/agent-studio/workspace-2"}'
pnpm dev
```

`MC_STUDIO_WORKSPACE_ROOTS` takes precedence over `MC_WORKSPACE_ROOT` for every mapped ID.
Each configured root must be an existing, accessible absolute directory. A non-default
workspace without an explicit mapping is rejected, and malformed mapping JSON fails closed;
workspace `2`, for example, cannot use workspace `1`'s root or a symlink that resolves into it.

## Start locally

Node.js 22 or newer and pnpm are required for a source install.

```bash
git clone https://github.com/yoonzine22/agent-pool-studio.git
cd agent-pool-studio
bash install.sh --local
```

Open `http://localhost:3000/setup`, create the first admin account, then copy the API key
from Settings if an agent or script needs headless access.

The manual path is useful when you already manage Node and pnpm:

```bash
nvm use 22
pnpm install
pnpm dev
```

Windows users can run `./install.ps1 -Mode local` in PowerShell.

### Start with Docker

```bash
docker compose up
```

Or run the published multi-architecture image:

```bash
docker pull ghcr.io/builderz-labs/mission-control:latest
docker run --rm -p 3000:3000 ghcr.io/builderz-labs/mission-control:latest
```

Use the hardened Compose overlay for a network-accessible deployment:

```bash
docker compose -f docker-compose.yml -f docker-compose.hardened.yml up -d
```

The [deployment guide](docs/deployment.md) covers persistent data, TLS termination,
gateway connectivity, and standalone builds.

## What Mission Control governs

The control plane sits above agent runtimes. It does not replace their reasoning or tool
loops. It gives operators one place to see and govern the work around those loops.

| Area | Shipped surface |
|---|---|
| Tasks | Inbox, assignment, execution, review, Aegis quality gate, and completion receipts |
| Agents | Registration, presence, sessions, runtime adapters, configuration, and workspace sync |
| Operations | Activity stream, schedules, alerts, webhooks, logs, token use, and cost views |
| Knowledge | Memory browser, relationship graph, skills registry, and local skill synchronization |
| Governance | Roles, API keys, security events, trust signals, approvals, audits, and evals |
| Interfaces | Web UI, CLI, MCP server, OpenAPI-described REST API, WebSocket, and SSE |

The runtime is self-hosted and workspace-aware. SQLite stores local control-plane state.
Shared workspaces can use deployment-level runtime integrations. Strict workspaces block
those integrations until the underlying resources carry workspace ownership. A gateway is
optional for task, project, agent, scheduler, webhook, alert, and cost work; live session
messaging needs a connected runtime gateway.

## Operator field notes

Dashboards compress a sequence into current state. When a run needs review, record the
identity, task, tool call, approval, result, and verification evidence before changing it.
Keep unresolved items distinct from accepted risk.

![Mission Control operator field notes](docs/operator-field-notes.webp)

Logs show what ran. A completion receipt or inspected artifact shows what finished.

## Pick the right fit

Use Mission Control when multiple agents or runtimes make it hard to answer who owns a
task, what executed, which result passed review, or where spend and failures accumulated.

It is probably the wrong tool when:

- one agent on one machine already stays understandable from its native CLI;
- you need a managed multi-tenant SaaS rather than a self-hosted control plane;
- you want an agent framework to define planning and tool use;
- your deployment cannot tolerate alpha schema or API changes.

Adapters and observation surfaces cover OpenClaw, Claude Code, Codex,
CrewAI, LangGraph, AutoGen, and Claude SDK workflows. Adapter depth varies by runtime; see
[agent setup](docs/agent-setup.md) and [CLI integration](docs/cli-integration.md) before
assuming feature parity.

## Connect an agent

The shortest gateway-free loop uses the REST API. Export the URL and API key shown in
Settings:

```bash
export MC_URL=http://localhost:3000
export MC_API_KEY=replace-with-your-api-key
```

Register an agent and create work:

```bash
curl -s -X POST "$MC_URL/api/agents/register" \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"scout","role":"researcher"}'

curl -s -X POST "$MC_URL/api/tasks" \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Review open incidents","assigned_to":"scout","priority":"medium"}'
```

The agent can then claim its queue:

```bash
curl -s "$MC_URL/api/tasks/queue?agent=scout" \
  -H "Authorization: Bearer $MC_API_KEY"
```

Continue with the [first-agent quickstart](docs/quickstart.md) for heartbeats, task results,
queue behavior, CLI equivalents, and MCP setup.

### CLI

```bash
pnpm mc agents list --json
pnpm mc tasks queue --agent scout --json
pnpm mc events watch --types agent,task
```

### MCP server

```bash
claude mcp add mission-control -- \
  env MC_URL=http://127.0.0.1:3000 MC_API_KEY=replace-with-your-api-key \
  node /absolute/path/to/mission-control/scripts/mc-mcp-server.cjs
```

Use the [CLI and MCP reference](docs/cli-agent-control.md) for the current command and tool
surface. The REST contract lives in [`openapi.json`](openapi.json). A running instance serves
the interactive reference at `/docs` and the OpenAPI JSON at `/api/docs`.

## Product surfaces

### Tasks and quality review

The task board tracks work through inbox, assignment, execution, review, quality review,
and completion. Aegis review requires an approval record before a task reaches done.

![Mission Control task board with assigned, in-progress, and review columns of agent tasks](docs/mission-control-tasks.png)

### Agents and runtimes

Agent views combine registration state, heartbeats, sessions, configuration, local runtime
discovery, and workspace files.

![Mission Control agents panel showing a five-agent squad with roles, heartbeats, and workspace conventions](docs/mission-control-agents.png)

### Memory and skills

The memory browser and relationship graph inspect filesystem-backed memory and linked
session knowledge. The Skills Hub discovers local skill roots and scans registry content
before installation.

![Mission Control memory browser rendering a markdown agent note with wiki-style links between memory files](docs/mission-control-memory.png)

### Schedules and activity

Recurring task templates create dated work on a cron schedule. The activity stream combines
agent, task, and system events for operator review.

![Mission Control cron management calendar with scheduled jobs across the week](docs/mission-control-cron.png)

![Mission Control activity stream with per-agent status and heartbeat events](docs/mission-control-activity.png)

## Documentation

| Guide | Use it for |
|---|---|
| [Quickstart](docs/quickstart.md) | Register an agent and run the first task loop |
| [Agent setup](docs/agent-setup.md) | Sources, identities, SOUL files, and heartbeats |
| [Orchestration](docs/orchestration.md) | Dispatch, handoffs, workflows, and review gates |
| [CLI and MCP](docs/cli-agent-control.md) | Headless commands and agent tools |
| [CLI integration](docs/cli-integration.md) | Claude Code, Codex, and gateway-free connections |
| [Deployment](docs/deployment.md) | Local, Docker, standalone, reverse proxy, and VPS setup |
| [Security hardening](docs/SECURITY-HARDENING.md) | Network, container, CSP, and secret controls |
| [Support](SUPPORT.md) | Questions, bugs, feature proposals, and security-report routing |
| [OpenClaw compatibility](docs/openclaw-config-compatibility.md) | Config and state-directory behavior |
| [Release process](RELEASE.md) | Versioning, tags, images, and release checks |

## Architecture

```text
Web UI ─┐
CLI ────┼── auth ─ dispatch ─ events ─ policy ─ receipts
MCP ────┤                                      │
REST ───┘                         SQLite + agent runtimes
```

| Layer | Technology |
|---|---|
| Application | Next.js 16 App Router, React 19, TypeScript 5 |
| Interface | Tailwind CSS 4, Zustand, Recharts, xterm.js |
| State | SQLite through better-sqlite3, with WAL mode |
| Boundaries | REST/OpenAPI, MCP, CLI, WebSocket, and SSE |
| Access | Session cookies, API keys, Google sign-in, and role checks |
| Validation | Zod at input boundaries |
| Verification | Vitest, Playwright, ESLint, TypeScript, build, and API parity checks |

Runtime data defaults to `.data/`. Set `MISSION_CONTROL_DATA_DIR` to an absolute persistent
path for standalone deployments. The complete environment contract is in
[`.env.example`](.env.example).

## Security boundary

- Keep Mission Control on a trusted network unless a TLS reverse proxy and
  `MC_ALLOWED_HOSTS` are configured.
- Replace or securely store generated credentials before broader access.
- Use the hardened Compose overlay for production-like container deployments.
- Treat agent messages, skill packages, webhooks, and MCP content as untrusted input.
- Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

Access controls and security inspection surfaces are included, but alpha status
still applies. Read [SECURITY-HARDENING.md](docs/SECURITY-HARDENING.md) before relying on a
network-accessible deployment.

## Develop

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

`pnpm quality:gate` runs the full repository gate. Useful diagnostics:

```bash
bash scripts/station-doctor.sh
bash scripts/security-audit.sh
pnpm api:parity
```

Common local failures:

| Symptom | Check |
|---|---|
| Login returns an internal error after changing Node versions | Run `pnpm rebuild better-sqlite3` |
| Docker cannot reach the gateway | Set `OPENCLAW_GATEWAY_HOST=host.docker.internal` |
| Browser WebSocket cannot connect | Leave `NEXT_PUBLIC_GATEWAY_HOST` empty or set a browser-reachable host |
| Password text after `#` disappears | Quote `AUTH_PASS` or use `AUTH_PASS_B64` |

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution scope, coding standards, and review
expectations. Community conduct is defined in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Project status and support

Release notes live in [CHANGELOG.md](CHANGELOG.md). Open issues are the current roadmap;
the project does not promise dates for unassigned work.

- Bugs and feature proposals: [GitHub Issues](https://github.com/builderz-labs/mission-control/issues)
- Vulnerabilities: [private reporting instructions](SECURITY.md)
- Builderz Labs: [builderz.dev](https://builderz.dev)
- Maintained by [Nyk](https://nyk.dev). [Sponsor ongoing development](https://github.com/sponsors/0xNyk) or follow [@nykdotdev](https://x.com/nykdotdev).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/star-history-dark.svg">
    <img src="docs/star-history-light.svg" alt="Mission Control star history" width="600">
  </picture>
</p>

## License

[MIT](LICENSE) © 2026 [Builderz Labs](https://github.com/builderz-labs)
