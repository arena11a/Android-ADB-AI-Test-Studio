# ADB AI Test Studio

A desktop application (Windows / Linux) for testing Android apps over ADB — **local-only**, with a human always in control.

AI CLIs (Claude Code, OpenCode, Codex, …) can drive the device through MCP, but every single call goes through the Policy Engine, and anything risky waits for your approval.

> **Use this only with devices and apps you own or are allowed to test.**
> Unlocking bootloaders, revoking permissions and installing packages can destroy data — see [SECURITY.md](SECURITY.md).

---

## Highlights

- **Policy Engine first** — deny-by-default. No tool registration = no execution. There is no free-form `adb shell` tool for AI, ever.
- **Two advanced modes, both human-guarded** — `repair` (diagnose/infect; the AI may read, every change needs approval) and `bootloader` (fastboot/unlock/sideload; **the AI is denied in every mode, by the policy engine**).
- **Approval Queue** — single-use approvals, TTL, typed confirmation + hold-to-approve for critical actions.
- **Kill Switch** — stops everything instantly (`Ctrl+Shift+K`); only a human can release it.
- **Append-only audit** — JSONL + SHA-256 hash chain with redaction; tampering is detectable.
- **Real desktop UI** — 10 pages, Thai/English, dark/light, live logcat, metrics charts, scrcpy mirror, screen recording.
- **SQLite history** (with a graceful JSON fallback) for sessions, steps, metrics and approvals.

## Quick start

```bash
npm install
npm run app:dev          # Electron app with hot reload
```

Then plug in a phone (USB debugging on) and it appears in the device picker automatically.
See [docs/INSTALL.md](docs/INSTALL.md) for prerequisites, Wi-Fi adb and packaging.

| Page | What it does |
|---|---|
| **Dashboard** | device facts, screenshot (inline or saved), system status, current session, audit feed, live metrics |
| **Apps** | target apps (scope), launch/stop/clear, APK install & uninstall (approval flow) |
| **Live view** | scrcpy mirror in its own window (`liveView` feature) |
| **Record** | `adb shell screenrecord` ≤ 180 s per file, saved into `~/Videos/…` |
| **Logs** | live logcat with level/tag/text filters, redaction, crash/ANR highlight, export |
| **Metrics** | CPU/RAM/battery/storage charts + CSV export |
| **Files** | sandboxed browser (list/pull/push/delete, backups before overwrite) |
| **Sessions** | start/stop test sessions with step limits, stop conditions, HTML/MD/JSON reports |
| **Security** | read-only hygiene scan + approval-gated repair actions (`repair` mode) |
| **Bootloader** | reboot to bootloader/recovery, fastboot info, unlock (typed `WIPE-ALL-DATA`), sideload |
| **Settings** | policy (mode/role/features/APK dirs), audit verify/export, file locations, AI connection |

## Where files are stored

Everything lands on **your computer**, never left on the phone:

| What | Folder |
|---|---|
| Screenshots | `~/Pictures/ADB-AI-Test-Studio/` |
| Screen recordings | `~/Videos/ADB-AI-Test-Studio/` (Movies on macOS) |
| Pulled device files | `~/Downloads/adb-studio-pulled/` (policy `files.localDownloadDir`) |
| Session artifacts & reports | `~/.adbstudio/sessions/<id>/` |
| Audit log (append-only) | `~/.adbstudio/audit/audit.jsonl` |
| SQLite DB | `~/.adbstudio/studio.sqlite` (falls back to JSON if the native module can't load) |

Every page that writes a file has an “open folder” button, and Settings lists all locations.

## Get started in three steps

1. Plug in a phone with USB debugging on — it appears in the device picker.
2. Press a **preset** in the header: `Read only`, `Full testing`, `Repair & scan` or `Bootloader` —
   mode and features are configured for you. Advanced modes ask you to type a confirmation word.
3. Use the pages: screenshot, logs, metrics, live view, recording, sessions, reports.

Everything else (targets, feature switches, folders, audit) is in **Settings**.

## Modes

| Mode | What it allows |
|---|---|
| `safe` (default) | read-only: device/app lists, device info |
| `observe` | + screenshot, UI hierarchy, logs, metrics |
| `develop` | + tap/swipe/type/keys, launch/stop target apps (foreground guard applies) |
| `automation` | AI limited to low/medium risk inside scope |
| `approve_all` | every state change needs approval |
| `plan_only` | AI may only dry-run |
| `repair` ⚠ | **AI may read diagnostics or request a fix** (→ approval). Type `ซ่อม` to enter |
| `bootloader` ⚠ | **human-only** fastboot/unlock/sideload. Type `BOOTLOADER` to enter |

The mode selector lives in the app header — **there is no tool that changes the mode**, so an AI cannot escalate itself.

## Architecture

```
UI (Electron + React)  ──IPC──▶  Local Agent (child process)
                                  ├─ Tool Router → Policy → Approval → Audit → execute
AI CLI (Claude/OpenCode) ──MCP──▶ mcp-bridge ──WS 127.0.0.1 + token (actor "ai")
                                  └─ adb (execFile, argv only, no shell strings)
```

Two loopback sockets, each with its own random per-launch token: one for the MCP bridge (`actor: "ai"`), one for the UI (`actor: "user"`). Browser origins are refused.

| Folder | Contents |
|---|---|
| `core/src` | policy, audit, approval, router, adb wrapper, services, tools, agent CLI |
| `mcp-bridge/src` | MCP stdio server that forwards to the agent |
| `app/src` | Electron main/preload/renderer |

## Tests

```bash
npm test           # 82 tests: unit + integration (fake adb) + security matrix
npm run typecheck  # core + mcp-bridge + app
npm run build      # compile core, mcp-bridge and the Electron app
```

The suite covers the policy matrix (tool × mode × risk → allow/ask/deny), path sandboxing, redaction, rate limits, audit hash-chain tampering, the control plane (auth/origin/token, approvals, kill switch, streams), scrcpy/screenrecord/fastboot guards, plus the SQLite round-trip.

## Documentation

- [docs/INSTALL.md](docs/INSTALL.md) — prerequisites, build, Wi-Fi adb, packaging
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — day-to-day usage walkthrough
- [docs/SECURITY.md](docs/SECURITY.md) — threat model, guarantees and limits
- [docs/POLICY_GUIDE.md](docs/POLICY_GUIDE.md) — every policy knob explained
- [docs/AI_INTEGRATION_GUIDE.md](docs/AI_INTEGRATION_GUIDE.md) — Claude Code / OpenCode / Codex setup
- [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) — adding tools, sockets, build internals
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — common errors
- [docs/PLAN.md](docs/PLAN.md) — the original design document

## License

[MIT](LICENSE). The bundled `adb`/`scrcpy` binaries (if you install them) keep their own licenses.
