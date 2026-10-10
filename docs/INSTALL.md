# Install

## Requirements

| | |
|---|---|
| Node.js | 20 LTS or newer (22 recommended) |
| `adb` | Android platform-tools on `PATH`, or set `adb.path` in `config/app.config.json` |
| `scrcpy` | optional — only needed for the Live view page |
| `fastboot` | optional — ships with platform-tools, used by the Bootloader page |

> Use only with devices and apps you own or are allowed to test.

## Linux

```bash
sudo apt install android-sdk-platform-tools scrcpy
# if `adb devices` reports "no permissions", add a udev rule:
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="<VID>", MODE="0660", GROUP="plugdev"' | sudo tee /etc/udev/rules.d/51-android.rules
sudo udevadm control --reload && sudo usermod -aG plugdev $USER   # then log out/in
```

## Windows

```powershell
winget install Google.PlatformTools
winget install Genymobile.scrcpy
```

Install the Google USB driver or your OEM driver if Windows does not list the device.

## Build & run

```bash
npm install
npm run app:dev          # Electron app with hot reload  (what most people want)
npm run app:start        # production build, then run
npm test                 # 82 tests
npm run typecheck        # core + mcp-bridge + app
npm run build            # compile everything
```

The app spawns the Local Agent itself (a bundled `agent.cjs`), so you do **not** run the agent by hand when using the UI. You only run the agent (or the MCP bridge) separately when an AI CLI should connect — see [AI_INTEGRATION_GUIDE.md](AI_INTEGRATION_GUIDE.md).

If the app cannot find adb, set `adb.path` (absolute) in `config/app.config.json` or add it to `PATH`. For scrcpy/fastboot use `scrcpy.path` / `fastboot.path`.

## Phone setup

1. Enable **Developer options** → turn on **USB debugging** (and **Wireless debugging** for Wi-Fi).
2. Accept the RSA fingerprint prompt on the phone.
3. `adb devices` should list it as `device`.

## Wi-Fi adb (Android 11+)

Wireless debugging → *Pair device with pairing code* → `adb pair host:port` (6-digit code) → `adb connect host:port`.
Use trusted networks only: the pairing code is the only secret, so anyone on the LAN can pair while the dialog is open.

## Packaging

```bash
npm run app:package          # installers into app/release/ (AppImage/deb on Linux, NSIS on Windows, dmg on macOS)
npm run app:package -- --dir # unpacked build only (fast)
```

The packaging step bundles the agent and the MCP bridge into `resources/agent/` together with the default config, so the installed app is self-contained. Code signing is **not** configured — see the notes in the root README.

## Building the agent bundle manually

```bash
npm run build                  # core + mcp-bridge TypeScript
npm run prepare-agent -w @adbstudio/app   # esbuild bundle → app/pack/agent/
```
