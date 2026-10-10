# Developer guide

## Project layout

```
core/src                Local Agent (Node/TS)
  adb.ts                ADB wrapper: execFile with argv only, timeouts, kill-switch tracking
  policy.ts             Policy Engine: kill → schema → forbidden → mode → features → role →
                        scope → path guard → rate limits → session limits → allow|ask|deny
  approval.ts           single-use approval queue with TTL and typed confirmation
  audit.ts              append-only JSONL + SHA-256 hash chain + redaction
  router.ts             the one execution path for UI and AI alike
  tools.ts              tool registry (zod, strict) with risk/category/mutates
  wire.ts               composition root: services + tool handlers + DB write-through
  db.ts                 optional SQLite (better-sqlite3) with `user_version` migrations
  server.ts             WS socket for the MCP bridge (actor "ai")
  control.ts            WS socket for the desktop UI (actor "user") + event fan-out
  cli.ts / agent.ts     process entrypoint / composition of both sockets
  services/             devices, apps, files, input, logcat, metrics, session, report,
                        security (scan), scrcpy, screen (screenrecord), bootloader (fastboot)

mcp-bridge/src          MCP stdio server → agent (holds no policy of its own)

app/src                 Electron + React
  main/index.ts         window, security posture, agent lifecycle, IPC bridge
  main/agent.ts         spawns the agent (system node if present, else Electron-as-node)
  main/control.ts       the only WebSocket client — the renderer never opens sockets
  preload/index.ts      contextBridge API: call() / on() / agent.* (sandboxed)
  renderer/             zustand store, i18n (th/en), 10 pages, design system
tests/                  unit · integration (fake adb) · security matrix
config/                 app.config.json + policy.default.json
```

## Adding a tool

1. Add a `def(...)` entry in `core/src/tools.ts` (category, risk, `mutates`, strict zod schema).
2. Register the handler in `core/src/wire.ts` — services do the work; `router.register` wires it up.
3. Extend `PolicyEngine` (`policy.ts`) if the tool needs new mode/feature rules.
4. Add tests: policy matrix in `tests/security/policy.test.ts`, behaviour in `tests/integration/pipeline.test.ts`.

Rules: never build shell strings (argv arrays only), never call `adb` outside `services/` and `adb.ts`,
and every new capability defaults to **off** (`features.*`) unless it is read-only.

## The two advanced modes

| Mode | Feature flag | What the AI may do |
|---|---|---|
| `repair` | `features.repair` | read diagnostics (`security_scan`, `device_admins`, `app_permissions`, logs, metrics…) **or request** a fix — every action becomes an approval |
| `bootloader` | `features.bootloader` | nothing. Bootloader tools are denied for `actor: "ai"` in **every** mode, in `evaluate()` |

Entering either mode requires the typed word (`ซ่อม` / `BOOTLOADER`) via `control.ts`, which also arms the feature. There is **no tool** that changes the mode, so an AI cannot escalate itself.

## Sockets & security

- `server.ts` (MCP bridge) and `control.ts` (UI) bind `127.0.0.1` on random ports with fresh 32-byte tokens; endpoint files are `0600`; browser `Origin` headers are refused.
- `fastboot`/`scrcpy` runners are allowlisted (`FASTBOOT_ALLOWED`, `FLASHABLE_PARTITIONS`) and validate partition names and image paths before spawning.
- `scrcpy` options are validated against the binary's own `--help`, so a build without audio forwarding cannot break the Live view.

## Testing helpers

| Env var | Effect |
|---|---|
| `ADBSTUDIO_PAGE=<page>` | open the app on a page |
| `ADBSTUDIO_LANG=th\|en` | force a language |
| `ADBSTUDIO_SKIP_FIRST_RUN=1` | hide the first-run dialog |
| `ADBSTUDIO_CAPTURE=/tmp/x.png` | capture the window and quit (smoke tests) |
| `ADBSTUDIO_NODE=/path/to/node` | force the agent's JS runtime |

```bash
npm test                # 84 tests
npm run typecheck       # core + mcp-bridge + app
npm run build           # compile everything
npm run app:dev         # Electron with hot reload
npm run app:package     # installers (bundles the agent + bridge into resources/agent/)
```

## Config & policy migration

Files carry `schemaVersion`; bump it when the structure changes and back up the old file. `loadPolicyFile()` refuses a file newer than the build supports. The UI edits the runtime copy only — the file is the start-up default.
