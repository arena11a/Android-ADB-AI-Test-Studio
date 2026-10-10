# Security

## Scope of use

For developing and testing apps on devices **you own or are allowed to test**. Do not use it on other people's devices, and do not use it to bypass security controls.

## Principles

1. **Deny-by-default** — a tool that is not registered is rejected. There is no free-form `adb shell` for AI, and no tool that changes the policy mode.
2. **One path** — every request goes Router → Policy → (Approval) → execute → Audit. The UI and the AI use the same router; only the `actor` differs.
3. **Scope** — only `targetPackages` and policy-allowed paths. System apps and other packages are blocked, and the sandbox is re-checked right before touching the device.
4. **Foreground guard** — before every tap/swipe/type/key the target app must be in the foreground. The screen is never unlocked, and `FLAG_SECURE` windows are never worked around.
5. **Local-only** — WebSockets bind `127.0.0.1` on random ports with a fresh 32-byte token per launch; endpoint files are `0600`; browser `Origin` headers are refused.
6. **Approvals** — single-use, with TTL. Critical actions require typing a confirmation word **and** holding the approve button. An AI can never run a critical bootloader action.
7. **Kill Switch** — rejects new requests, cancels pending approvals, stops logcat/metrics/mirror/recording and kills tracked child processes. Only a human releases it (UI or `Ctrl+Shift+K`).
8. **Audit** — append-only JSONL with a SHA-256 hash chain; secrets are redacted before writing. Editing or deleting a line breaks the chain (detectable), but **the file as a whole can still be deleted** by anyone with OS-level access.
9. **Advanced modes** — `repair` lets an AI read diagnostics or *request* a fix; `bootloader` is human-only and its tools are denied for `actor: "ai"` in every mode.

## Known limits

- **ADB is powerful by design.** This app constrains its *own* tools, not the machine: anyone who can run `adb` locally is only limited by the phone's own authorisation.
- **Prompt injection** — text on the screen or in logs is treated as *data*, never as instructions. Policy decisions never depend on what an AI says.
- **Redaction is pattern-based** and can miss unusual formats. Screenshots sent to an AI may contain private information: use test devices and test accounts.
- **Approval fatigue** — the modal is deliberately repetitive; do not click through it without reading.
- **Native modules** — `better-sqlite3` is optional; when it cannot load, history falls back to JSON files with no functional loss.

## Reporting a vulnerability

Open a private security advisory or contact the maintainer through GitHub instead of a public issue.
