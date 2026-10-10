# Troubleshooting

## Devices and ADB

| Symptom | Cause / fix |
|---|---|
| device not listed | check the cable, unlock the phone, accept the RSA prompt, `adb devices` |
| `no permissions` (Linux) | install the udev rule for your vendor ID, then re-login |
| Windows cannot see the device | install the Google USB driver or the OEM driver |
| Wi-Fi adb drops / port changes | wireless debugging picks a new port — re-discover and reconnect with the current port |
| `DEVICE_UNAUTHORIZED` | accept the USB debugging prompt on the device |
| `DEVICE_LOCKED` | unlock the device yourself — the app never unlocks it |
| UI dump fails | the screen is animating or the window is secure — wait and retry |
| black screenshot | the app sets `FLAG_SECURE`; that is a deliberate limitation |
| Xiaomi/Oppo/Vivo: input ignored | enable "USB debugging (Security settings)" in Developer options |
| `POLICY_DENIED` | check mode / features / role in the policy |
| Safe Mode was entered automatically | an anomaly was detected (repeated blocked AI requests) — read the audit log and set the mode by hand |
| `endpoint.json` not found | start the agent/app before starting the AI CLI |

## Desktop app

| Symptom | Cause / fix |
|---|---|
| "agent disconnected" | press "⟳ agent", check that `adb` is on `PATH`; the agent log is printed by `npm run app:dev` |
| agent dies immediately | check that `config/app.config.json` is valid JSON; run `npm run agent` by hand to see the error |
| blank screen in dev | run `electron-vite dev` from the `app/` directory |
| packaged app: agent missing | run `npm run app:package` — it bundles the agent and config into `resources/agent/` |
| scrcpy will not start | this scrcpy build may lack an option (e.g. `--no-audio`); the app filters unsupported flags, but set `scrcpy.path` if the binary is elsewhere |
| Kill Switch stuck | press "Release Kill Switch" in the header — no AI tool can release it |

## Errors returned to the AI

| Code | Meaning |
|---|---|
| `POLICY_DENIED` | the mode/feature/role does not allow this tool |
| `NEEDS_APPROVAL` | a human must approve first (see the modal) |
| `APPROVAL_DENIED` / `APPROVAL_EXPIRED` | rejected, or the TTL ran out |
| `OUT_OF_SCOPE` | the package is not a target app |
| `PATH_FORBIDDEN` | the path is outside the sandbox |
| `FOREGROUND_MISMATCH` | another app is on top; the input was not sent |
| `RATE_LIMITED` | quota exceeded |
| `KILL_SWITCH` | everything is blocked until a human releases it |
