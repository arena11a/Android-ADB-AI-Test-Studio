#!/usr/bin/env node
// Fake `adb` for tests. State lives in $FAKE_ADB_STATE (json). Every invocation is appended to .calls.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const sf = process.env.FAKE_ADB_STATE;
const st = JSON.parse(readFileSync(sf, "utf8"));
let a = process.argv.slice(2);
appendFileSync(sf + ".calls", JSON.stringify(a) + "\n");
if (a[0] === "-s") a = a.slice(2);
const save = () => writeFileSync(sf, JSON.stringify(st));
const out = (s) => process.stdout.write(s);
const c = a[0];
if (c === "devices") out(`List of devices attached\n${st.devices.map((d) => `${d.serial}\t${d.state}${d.state === "device" ? " model:Pixel_8" : ""}`).join("\n")}\n`);
else if (c === "install") { const pk = st.apkPackage; if (!st.user.includes(pk)) st.user.push(pk); save(); out("Success\n"); }
else if (c === "uninstall") { st.user = st.user.filter((p) => p !== a[1]); save(); out("Success\n"); }
else if (c === "exec-out") {
  if (a.join(" ").includes("uiautomator")) out(`<?xml version='1.0'?><hierarchy><node text="Login" resource-id="com.example.app:id/login" content-desc="" class="android.widget.Button" package="${st.foreground}" clickable="true" enabled="true" bounds="[100,200][300,300]"/></hierarchy>`);
  else process.stdout.write(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(st.screen ?? "frame0".repeat(30))]));
}
else if (c === "logcat") {
  // stream a few lines then stay alive until the test kills us (LogService.stop)
  const lines = [
    "10-10 10:00:00.000  1234  1234 I TestTag  : hello from logcat",
    "10-10 10:00:01.000  1234  1234 W TestTag  : a warning",
    "10-10 10:00:02.000  1234  1234 D Chatty  : more detail",
  ];
  let i = 0;
  const t = setInterval(() => { if (i < lines.length) out(lines[i++] + "\n"); else clearInterval(t); }, 5);
  setTimeout(() => process.exit(0), 15000).unref();
}
else if (c === "reboot") out("");
else if (c === "shell") {
  const s = a.slice(1);
  const j = s.join(" ");
  if (s[0] === "getprop") out({ "ro.product.manufacturer": "Google", "ro.product.model": "Pixel 8", "ro.build.version.release": "14", "ro.build.version.sdk": "34" }[s[1]] + "\n");
  else if (j.startsWith("dumpsys battery")) out("  level: 77\n  status: 3\n  temperature: 301\n");
  else if (j.startsWith("dumpsys activity")) out(`  topResumedActivity=ActivityRecord{1 u0 ${st.foreground}/.Main t5}\n`);
  else if (j.startsWith("dumpsys window")) out(st.locked ? "mShowingLockscreen=true\n" : "mShowingLockscreen=false\n");
  else if (j.startsWith("pm list packages -s")) out("package:com.android.settings\npackage:android\n");
  else if (j.startsWith("pm list packages -3")) out(st.user.map((p) => `package:${p}`).join("\n") + "\n");
  else if (s[0] === "uiautomator") out(`<?xml version='1.0'?><hierarchy><node text="Login" resource-id="com.example.app:id/login" content-desc="" class="android.widget.Button" package="${st.foreground}" clickable="true" enabled="true" bounds="[100,200][300,300]"/></hierarchy>`);
  else if (s[0] === "pidof") out("1234\n");
  else if (s[0] === "monkey") out("Events injected: 1\n");
  else if (s[0] === "input" || s[0] === "am") out("");
  else if (s[0] === "ip") out("192.168.1.0/24 dev wlan0 src 192.168.1.50\n");
  else if (s[0] === "cat" && s[1] === "/proc/stat") out("cpu  1000 0 1000 8000 0 0 0 0 0 0\ncpu0 500 0 500 4000 0 0 0 0 0 0\n");
  else if (s[0] === "df") out("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block 1000000 400000 600000 40% /data\n");
  else if (j.startsWith("dumpsys cpuinfo")) out("  15% 1234/com.example.app: 10% user + 5% kernel\n");
  else if (j.startsWith("dumpsys meminfo")) out("Applications Memory Usage (in Kilobytes):\nTOTAL PSS: 123456\n");
  else if (s[0] === "ls") out("total 0\n-rw-r--r-- 1 u0 u0 5 2026-01-01 00:00 a.txt\n");
  else out("");
} else out("");
