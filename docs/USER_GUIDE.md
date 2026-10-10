# User guide

1. **First launch** — read and accept the safety notice. The app starts in `safe` mode (read-only).
2. **Connect a device** — plug in USB (debugging on) or use Wi-Fi adb; the device appears in the header picker within ~5 s (or press ⟳).
3. **Add a target app** — Apps page → *Target apps* → type a package (`com.example.app`) → **Add**. At least one is required before any tool may touch an app.
4. **Pick a mode** (header): `observe` (screenshot/logs/metrics) → `develop` (input/launch) → `automation` (AI, low/medium risk only) → `approve_all` (every change needs approval).
5. **Enable risky features individually** — Settings → *Advanced features*: `files`, `install`, `delete`, `input`, `power`, `liveView`, `repair`, `bootloader` (all off by default).
6. **Allowed folders** — Settings → Policy → `files.allow` (defaults: `/sdcard/Download/adbstudio`, `/data/local/tmp/adbstudio`, `/sdcard/Android/data/<target>`).
7. **Approvals** — the modal shows requester, tool, parameters, reason, risk level and impact. Approval is single-use; critical actions need the typed word **and** hold-to-approve.
8. **Reports** — Sessions page → start a session → stop it → `HTML` / `MD` / `JSON`.
9. **Emergency stop** — the red button in the header or `Ctrl+Shift+K`. Only the UI can release it; no AI tool can.

## Daily workflow

```
plug in phone → add target app → mode = observe → screenshot / logs / metrics
             → mode = develop → tap via selector / launch / stop
             → Sessions → start → let it run → report
```

## Screenshots & recordings

- **Dashboard → “Save image”** writes a PNG to `~/Pictures/ADB-AI-Test-Studio/` and opens it.
- **Record page** (needs `privacy.recordVideo` in `config/policy.default.json`) writes MP4s to `~/Videos/ADB-AI-Test-Studio/`, max 180 s per file.
- **Files page → download** puts pulled files into `~/Downloads/adb-studio-pulled/`.

## Security check & repair

1. Open **Security** → press **Enable repair mode** and type `ซ่อม`.
2. Press **Scan device** (read-only): device admins, accessibility/notification listeners, non-Play installs, suspicious combinations.
3. Any finding with a suggested fix only runs after you approve it in the approval dialog. The AI can request the same fixes, but they never run without your approval.

## Bootloader work

1. Settings → enable the `bootloader` feature.
2. Open **Bootloader** → type `BOOTLOADER` to enter the mode.
3. Reboot into fastboot/recovery, read fastboot info, or unlock the bootloader (type `WIPE-ALL-DATA`, then approve). Unlocking **wipes the device**.
4. Back in the app, switch the mode back to `safe` when you are done.

The AI cannot enter this mode and cannot call any of these tools — the policy engine denies them in every mode.
