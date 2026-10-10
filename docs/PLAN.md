# Plan

The original design document for this project (kept for context). The app is now implemented
beyond the MVP described here, with these additions:

- Two advanced modes: `repair` (AI-assisted diagnosis, every change approved) and `bootloader`
  (human-only fastboot/unlock/flash/sideload, AI denied in every mode).
- Read-only security scan with remediation suggestions (`core/src/services/security.ts`).
- scrcpy live view and `adb shell screenrecord` (≤ 180 s per file).
- SQLite history layer with migrations (`core/src/db.ts`) on top of the JSON/JSONL artifacts.
- Desktop UI with 10 pages, Thai/English, dark/light, presets and a guided first run.
- scrcpy/fastboot option validation against the installed binaries.

Sections below are the planning text written before implementation.

---

# Android ADB AI Test Studio — project plan

## 1. Executive summary

**Goal:** let developers/QA and AI CLIs (Claude Code, OpenCode, …) test Android apps where every
command goes through a Policy Engine and risky actions require human approval.

**Design principles (strongest first)**

1. Human-in-control: Kill Switch + approval for every risky command.
2. Deny-by-default: if it is not in the allowlist, it is blocked.
3. Scoped: only target packages and allowed paths.
4. Local-only: no cloud, no telemetry, bind 127.0.0.1 only.
5. No raw shell: AI calls schema-validated tools only.
6. No root by default.
7. Auditable: append-only log with redaction.

**MVP outcome:** connect a device → set target apps → AI tests through MCP → approval in the UI →
HTML/JSON reports.

## 2. Architecture

```
┌──────────────────────── user machine (local only) ───────────────────────┐
│  ┌─────────────┐   IPC (contextBridge)   ┌────────────────────────────┐  │
│  │ Desktop UI  │◄───────────────────────►│        Local Agent (Node)  │  │
│  │ Electron +  │   WS 127.0.0.1 + token  │  ┌─────────────┐           │  │
│  │ React + TS  │                         │  │ Tool Router │◄──┐       │  │
│  └─────────────┘                         │  └──────┬──────┘   │       │  │
│  ┌─────────────┐   MCP (stdio)           │         ▼          │       │  │
│  │ AI CLI      │◄───────────────────────►│  ┌─────────────┐   │       │  │
│  │ Claude Code │   via mcp-bridge        │  │Policy Engine│   │       │  │
│  └─────────────┘                         │  └──────┬──────┘   │       │  │
│                                          │    allow │ ask │ deny      │  │
│                                          │         ▼     ▼             │  │
│                                          │  ┌──────────┐ ┌──────────┐ │  │
│                                          │  │ Executor │ │Approval Q│─┼──┼─►UI
│                                          │  └────┬─────┘ └──────────┘ │  │
│                                          │       ▼   ┌───────────┐   │  │
│                                          │  ┌───────────────────┐   │  │
│                                          │  │ Audit (hash chain)│   │  │
│                                          │  └───────────────────┘   │  │
│                                          │  Services: device, app,   │  │
│                                          │  file, input, screen,     │  │
│                                          │  logs, metrics, security, │  │
│                                          │  session, report, power   │  │
│                                          └───────────┬──────────────┘  │
└──────────────────────────────────────────────┼─────────────────────────┘
                                                   ▼
                                          adb server (127.0.0.1:5037)
                                                   ▼
                                        USB / wireless debugging
                                             Android device
```

### Components

| Component | Role |
|---|---|
| Desktop UI | dashboard, devices, apps, files, screen, logs, metrics, sessions, approvals, audit, settings, kill switch |
| Local Agent | separate process that owns every ADB call |
| Tool Router | validate schema → policy → approval → execute → audit |
| Policy Engine | allow / ask / deny + rate limits + scope |
| Approval Queue | TTL, typed confirmation, single use |
| Audit Logger | JSONL + hash chain, redacted |
| Device Manager | list/connect/pair/forget, per-device session lock |
| Command Queue | serialised per device so commands never collide |
| Metrics Collector | polls `dumpsys`/`/proc` on an interval |
| Log Service | logcat stream + filters + redaction + crash/ANR detection |
| File Service | list/pull/push/delete inside the sandbox, with backup + checksum |
| Session Manager | step/time budgets and stop conditions |
| Report Generator | HTML/MD/JSON |
| MCP Bridge | MCP stdio server → agent over WS + token |

## 3. Technology

Electron + React + TypeScript + Node (monorepo with npm workspaces): one language end to end,
official MCP SDK for Node, `execFile` for ADB (argv arrays, never shell strings), and
electron-builder for Win/Linux/macOS packages.

| Area | Choice |
|---|---|
| Desktop window | Electron |
| Build | Vite + electron-vite |
| UI | React 18 + Tailwind CSS v4 |
| State | Zustand |
| Charts | inline SVG sparklines |
| Validation | zod |
| i18n | built-in th/en dictionaries |
| Database | better-sqlite3 (optional) |
| Audit | JSONL + hash chain |
| MCP | @modelcontextprotocol/sdk |
| WS | ws |
| Tests | vitest + fake adb |
| Packaging | electron-builder |

## 4. Data model (SQLite, WAL, `user_version` migrations)

See `core/src/db.ts` for the implemented schema: `sessions`, `steps`, `approvals`, `ai_requests`,
`metrics`, `file_ops`, `app_ops`, `reports`, `devices`, `target_apps`.

The audit trail stays append-only JSONL with a hash chain; the database is a query layer on top.

## 5. Policy modes

| Mode | Capability |
|---|---|
| `safe` (default) | read-only: device/app lists, device info |
| `observe` | + screenshot, UI hierarchy, logs, metrics |
| `develop` | + tap/swipe/type/key, launch/stop target apps (foreground guard) |
| `automation` | AI: low/medium risk only, in scope |
| `approve_all` | every state change needs approval |
| `plan_only` | AI dry-run only |
| `repair` | AI reads diagnostics or requests fixes; every action approved |
| `bootloader` | human-only fastboot/unlock/flash/sideload |

| Risk | Examples | Default behaviour |
|---|---|---|
| `low` | list, screenshot, logs, metrics | allow (per mode) |
| `medium` | tap/swipe/type/key, launch/stop target | allow in develop/automation after the guard |
| `high` | install, uninstall, clear data, push, delete, revoke | ask every time |
| `critical` | reboot, unlock, flash, erase, sideload | ask + typed confirmation |
| `forbidden` | raw shell, root, system apps, other packages | deny always |

## 6. UI

10 pages: Dashboard, Apps, Live view (scrcpy), Record, Logs, Metrics, Files, Sessions,
Security (scan/repair), History (SQLite), Settings. Thai/English, dark/light, presets, and a
guided first run for people who are not driving an AI.
