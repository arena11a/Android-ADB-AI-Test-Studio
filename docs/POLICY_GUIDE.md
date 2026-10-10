# Policy guide

File: `config/policy.default.json` — copy it to `~/.adbstudio/policy.json` and edit there (the agent reads the copy if it exists).
The UI can also change most of this at runtime (Settings page); the file is the default at start-up.

| Field | Meaning |
|---|---|
| `schemaVersion` | bump when the structure changes; a newer file than the build supports is refused |
| `mode` | `safe` / `observe` / `develop` / `automation` / `approve_all` / `plan_only` / `repair` / `bootloader` |
| `role` | `viewer` (low risk) / `tester` (≤ high) / `admin` (+ critical) |
| `targetPackages` | the only packages any tool may touch — empty means no app actions at all |
| `features.*` | separate switches: `files`, `install`, `delete`, `input`, `power`, `advancedMode`, `liveView`, `repair`, `bootloader` (all **off** by default) |
| `files.allow` / `files.deny` | device paths; `{target}` expands to each target package; **deny always wins** |
| `forbiddenTools` | never allowed, no matter the mode |
| `alwaysApprove` | always requires approval, every time |
| `rateLimits` | tool calls/minute, input/second and /minute, installs/hour, deletes/session, same-screen retries |
| `session` | max steps/seconds and stop conditions (crash, ANR, leaving the target app, no progress) |
| `approval` | TTL in seconds; `neverPermanent: ["high","critical"]` forbids permanent approvals |
| `ai` | `logsTargetOnly`, `allowRawCoordinates`, `requireReason`, `dryRunDefault` |
| `privacy` | `recordScreenshots`, `recordVideo`, `redactLogs`, `highPrivacyMode`, `localOnly` |
| `anomaly` | thresholds that raise alerts and optionally drop the app into Safe Mode |

## How a decision is reached

```
kill switch → schema (zod, strict) → forbidden tools → mode gate → feature flags
  → role → scope (package / path / system app) → foreground guard (input tools)
  → rate limits & quotas → session limits → dry-run? → allow | ask | deny
```

## Rules of thumb

- Tightening is always safe. Loosening (enabling a feature or mode) should be done **one step at a time and only when needed**.
- Bootloader and repair tools always `ask` — never silently `allow` — and bootloader tools are denied for AI in every mode.
- Repeated blocked AI requests (`anomaly.forbiddenRepeatThreshold` inside the window) drop the app into Safe Mode automatically.

## Example: allow only reading

```json
{
  "mode": "observe",
  "role": "viewer",
  "targetPackages": ["com.example.app"],
  "features": { "liveView": false, "repair": false, "bootloader": false }
}
```
