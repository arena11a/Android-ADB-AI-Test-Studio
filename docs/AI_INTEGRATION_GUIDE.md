# AI integration guide

The app exposes the device to AI CLIs through MCP — but the bridge holds **no policy of its own**.
Every call goes through the agent's Policy Engine, Approval Queue and audit log, exactly like the UI.

## 1. Start the Local Agent

```bash
npm install && npm run build
npm run agent                 # = node core/dist/cli.js
# custom paths:  node core/dist/cli.js --adb-path /usr/bin/adb --data-dir ~/.adbstudio
```

The agent prints one machine-readable line on stdout and writes `~/.adbstudio/endpoint.json`
(url + a fresh 32-byte token, mode `0600`) for the bridge to read:

```
ADBSTUDIO_READY {"agent":{"url":"ws://127.0.0.1:41234","token":"…"},"control":{…},"pid":1234}
```

> Using the desktop app? Then you do **not** need this step — the app runs the agent itself.
> Run it separately only when you want an AI CLI to connect.

## 2. Start the MCP bridge (stdio)

```bash
npm run bridge                # = node mcp-bridge/dist/index.js
```

Environment variables: `ADBSTUDIO_ENDPOINT_FILE` (defaults to `~/.adbstudio/endpoint.json`)
and `ADBSTUDIO_CLIENT` (`claude-code`, `opencode`, `codex`, …) which shows up in the approval dialog.

## 3. Point your AI client at the bridge

**Claude Code**

```bash
claude mcp add adb-studio -e ADBSTUDIO_CLIENT=claude-code -- \
  node /path/to/adb-ai-test-studio/mcp-bridge/dist/index.js
```

**OpenCode** (`opencode.json`)

```json
{
  "mcp": {
    "adb-studio": {
      "type": "local",
      "command": ["node", "/path/to/adb-ai-test-studio/mcp-bridge/dist/index.js"],
      "environment": { "ADBSTUDIO_CLIENT": "opencode" },
      "enabled": true
    }
  }
}
```

**Codex / generic MCP client** — same shape as OpenCode: spawn `node …/mcp-bridge/dist/index.js`
over stdio with `ADBSTUDIO_CLIENT` set. Any MCP client that can launch a local stdio server works.

## 4. Tools the AI can see

37 tools, each with `zod` schemas, a risk level and a category. Highlights:

| Area | Tools |
|---|---|
| device | `device_list`, `device_info`, `device_connect`, `device_disconnect` |
| app | `app_list`, `app_launch`, `app_stop`, `app_install`, `app_uninstall`, `app_clear_data` |
| screen/input | `screenshot`, `ui_hierarchy`, `tap`, `swipe`, `type_text`, `press_key` |
| file | `file_list`, `file_pull`, `file_push`, `file_delete` (sandboxed) |
| logs/metrics | `logs_read`, `metrics_read` |
| session/report | `session_start`, `session_stop`, `report_create` |
| security (repair mode) | `security_scan`, `device_admins`, `app_permissions`, `app_disable`, `app_revoke`, `app_force_stop` |
| bootloader (human-only) | `boot_reboot_target`, `fastboot_info`, `fastboot_reboot`, `fastboot_unlock`, `adb_sideload` |

Every tool accepts `device`, `reason` and `dry_run`. There is **no** raw shell, no root, and no way for the AI to change the mode.

## 5. Safe starter prompts

> Call `device_list`, then `device_info`, and summarise the device state.

> Start a session for `com.example.app`, walk the login flow, prefer `ui_hierarchy` before every tap,
> give a reason for every step, and stop with a report if the screen does not change three times.

## 6. Expected behaviour for the AI

| Situation | What the AI sees |
|---|---|
| risky action | `NEEDS_APPROVAL` — it must wait; retrying constantly is a policy violation |
| denied action | `POLICY_DENIED` / `OUT_OF_SCOPE` / `PATH_FORBIDDEN` / `FOREGROUND_MISMATCH` / `DEVICE_LOCKED` |
| kill switch | `KILL_SWITCH` — everything stops until a human releases it |
| too many blocked requests | Safe Mode is entered automatically (see `anomaly` in the policy) |
