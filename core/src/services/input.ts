import { Adb, centerOf, parseForegroundPackage, parseUiHierarchy, type UiElement } from "../adb.js";
import { StudioError } from "../types.js";
import type { PolicyEngine } from "../policy.js";

/**
 * Screen input with the mandatory foreground guard:
 * before EVERY tap/swipe/text/key we confirm the target app is on top.
 * We never unlock the screen and never press at random to dismiss dialogs.
 */
export class InputService {
  constructor(private adb: Adb, private policy: PolicyEngine) {}

  async foreground(serial: string): Promise<string | null> {
    const { stdout } = await this.adb.shell(serial, ["dumpsys", "activity", "activities"]);
    return parseForegroundPackage(stdout);
  }

  private async isLocked(serial: string): Promise<boolean> {
    const { stdout } = await this.adb.shell(serial, ["dumpsys", "window"]);
    return /mDreamingLockscreen=true|isStatusBarKeyguard=true|mShowingLockscreen=true|keyguardShowing=true/.test(stdout);
  }

  /** Throws DEVICE_LOCKED or FOREGROUND_MISMATCH. Returns the foreground package. */
  async guard(serial: string, targetPkg: string | undefined): Promise<string> {
    if (await this.isLocked(serial)) throw new StudioError("DEVICE_LOCKED", "Device is locked — unlock it yourself, then retry");
    const fg = await this.foreground(serial);
    const allowed = this.policy.policy.targetPackages;
    const ok = fg !== null && (targetPkg ? fg === targetPkg : allowed.includes(fg));
    if (!ok) throw new StudioError("FOREGROUND_MISMATCH", `Foreground app is '${fg ?? "unknown"}', not a target app — stopped; ask the user`);
    return fg!;
  }

  /**
   * Dumps the UI hierarchy without leaving anything on device storage.
   * `exec-out` is required here: on several devices (e.g. Samsung Android 13)
   * plain `adb shell uiautomator dump /dev/tty` only prints "dumped to: ..."
   * and the XML never reaches us. `shell` stays as a fallback.
   */
  async dumpUi(serial: string): Promise<UiElement[]> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const viaExec = await this.adb.run(["exec-out", "uiautomator", "dump", "/dev/tty"], { serial, timeoutMs: 20_000 });
      const xml = this.extractXml(viaExec.stdout);
      if (xml) return parseUiHierarchy(xml);
      const viaShell = await this.adb.run(["shell", "uiautomator", "dump", "/dev/tty"], { serial, timeoutMs: 20_000 });
      const xml2 = this.extractXml(viaShell.stdout);
      if (xml2) return parseUiHierarchy(xml2);
      await new Promise((r) => setTimeout(r, 400)); // uiautomator often refuses while the screen animates
    }
    throw new StudioError("ADB_ERROR", "UI dump failed (screen may be animating, secure, or the dump is too large)");
  }

  private extractXml(stdout: string): string | null {
    const xml = stdout.slice(stdout.indexOf("<?xml"));
    return xml.includes("<hierarchy") ? xml : null;
  }

  async tap(serial: string, target: string | undefined, p: { x?: number; y?: number; selector?: { text?: string; resource_id?: string; content_desc?: string } }) {
    const fg = await this.guard(serial, target);
    let x = p.x, y = p.y;
    if (p.selector) {
      const els = (await this.dumpUi(serial)).filter((e) => e.package === fg && e.enabled);
      const s = p.selector;
      const hit = els.find((e) =>
        (s.text === undefined || e.text === s.text) &&
        (s.resource_id === undefined || e.resource_id === s.resource_id) &&
        (s.content_desc === undefined || e.content_desc === s.content_desc));
      if (!hit) throw new StudioError("ADB_ERROR", "No element matches selector on the current screen");
      ({ x, y } = centerOf(hit.bounds));
    }
    if (x === undefined || y === undefined) throw new StudioError("INVALID_PARAMS", "Provide selector or x,y");
    await this.adb.shell(serial, ["input", "tap", String(x), String(y)]);
    return { tapped: { x, y } };
  }

  async swipe(serial: string, target: string | undefined, p: { x1: number; y1: number; x2: number; y2: number; duration_ms: number }) {
    await this.guard(serial, target);
    await this.adb.shell(serial, ["input", "swipe", ...[p.x1, p.y1, p.x2, p.y2, p.duration_ms].map(String)]);
    return { swiped: true };
  }

  async typeText(serial: string, target: string | undefined, text: string) {
    await this.guard(serial, target);
    if (!/^[\x20-\x7E]+$/.test(text)) throw new StudioError("INVALID_PARAMS", "Only printable ASCII is supported by `input text`");
    // argv is passed without a local shell, but the device shell re-parses it: quote defensively.
    const safe = "'" + text.replace(/ /g, "%s").replace(/'/g, "'\\''") + "'";
    await this.adb.shell(serial, ["input", "text", safe]);
    return { typed: text.length };
  }

  async pressKey(serial: string, target: string | undefined, key: string) {
    await this.guard(serial, target);
    await this.adb.shell(serial, ["input", "keyevent", `KEYCODE_${key}`]);
    return { pressed: key };
  }

  async screenshot(serial: string): Promise<Buffer> {
    const r = await this.adb.must(["exec-out", "screencap", "-p"], { serial, binary: true, timeoutMs: 20_000 });
    if (!r.raw || r.raw.length < 100) throw new StudioError("ADB_ERROR", "Empty screenshot (secure window?)");
    return r.raw;
  }
}
