import { Adb, parseBattery, type DeviceEntry } from "../adb.js";
import { StudioError } from "../types.js";

export interface DeviceInfo extends DeviceEntry {
  manufacturer?: string; model?: string; androidVersion?: string; sdk?: number; ip?: string; batteryPct?: number;
  controlledBySession?: string;
}

export class DeviceManager {
  /** serial → session id that currently controls it (shown in UI) */
  private locks = new Map<string, string>();
  private known = new Map<string, { nickname?: string; lastHost?: string; lastPort?: number }>();

  constructor(private adb: Adb) {}

  async list(): Promise<DeviceInfo[]> {
    const devs = await this.adb.listDevices();
    return devs.map((d) => ({ ...d, controlledBySession: this.locks.get(d.serial) }));
  }

  /** Resolve the target serial: explicit one must be online; otherwise exactly one online device. */
  async resolve(serial?: string): Promise<string> {
    const devs = await this.adb.listDevices();
    if (serial) {
      const d = devs.find((x) => x.serial === serial);
      if (!d) throw new StudioError("DEVICE_NOT_FOUND", `Device '${serial}' not found`);
      if (d.state === "unauthorized") throw new StudioError("DEVICE_UNAUTHORIZED", "Accept the USB-debugging prompt on the device");
      if (d.state !== "online") throw new StudioError("DEVICE_NOT_FOUND", `Device '${serial}' is ${d.state}`);
      return serial;
    }
    const online = devs.filter((d) => d.state === "online");
    if (online.length === 0) throw new StudioError("DEVICE_NOT_FOUND", "No online device");
    if (online.length > 1) throw new StudioError("INVALID_PARAMS", "Several devices online — pass 'device' (serial)");
    return online[0].serial;
  }

  async info(serial: string): Promise<DeviceInfo> {
    const prop = async (k: string) => (await this.adb.shell(serial, ["getprop", k])).stdout.trim() || undefined;
    const [manufacturer, model, androidVersion, sdk, bat, route] = await Promise.all([
      prop("ro.product.manufacturer"), prop("ro.product.model"), prop("ro.build.version.release"), prop("ro.build.version.sdk"),
      this.adb.shell(serial, ["dumpsys", "battery"]), this.adb.run(["shell", "ip", "route"], { serial }),
    ]);
    const ip = route.stdout.match(/src\s+((?:\d{1,3}\.){3}\d{1,3})/)?.[1];
    const base = (await this.adb.listDevices()).find((d) => d.serial === serial);
    return {
      serial, state: base?.state ?? "online", transport: base?.transport ?? "usb",
      manufacturer, model, androidVersion, sdk: sdk ? Number(sdk) : undefined, ip,
      batteryPct: parseBattery(bat.stdout).level, controlledBySession: this.locks.get(serial),
    };
  }

  async connect(host: string, port: number): Promise<string> {
    const r = await this.adb.run(["connect", `${host}:${port}`], { timeoutMs: 15_000 });
    const out = (r.stdout + r.stderr).trim();
    if (!/connected to/i.test(out) || /failed|cannot/i.test(out)) throw new StudioError("ADB_ERROR", out || "connect failed");
    this.known.set(`${host}:${port}`, { lastHost: host, lastPort: port });
    return out;
  }

  /** Pairing code is passed straight to adb and never stored or logged. */
  async pair(host: string, port: number, code: string): Promise<string> {
    if (!/^\d{6}$/.test(code)) throw new StudioError("INVALID_PARAMS", "Pairing code is 6 digits");
    const r = await this.adb.run(["pair", `${host}:${port}`, code], { timeoutMs: 20_000 });
    const out = (r.stdout + r.stderr).trim();
    if (!/successfully paired/i.test(out)) throw new StudioError("ADB_ERROR", out.replace(code, "******") || "pair failed");
    return out.replace(code, "******");
  }

  async disconnect(serial: string): Promise<void> {
    if (!/:\d+$/.test(serial)) throw new StudioError("INVALID_PARAMS", "Only Wi-Fi devices can be disconnected (unplug USB instead)");
    await this.adb.must(["disconnect", serial]);
  }

  /** mDNS discovery of Wireless-debugging devices on the local network. */
  async discover(): Promise<string[]> {
    const r = await this.adb.run(["mdns", "services"], { timeoutMs: 8_000 });
    return r.stdout.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  }

  forget(serial: string): void { this.known.delete(serial); }

  /** One controlling session per device, so two tests never fight over a phone. */
  acquire(serial: string, sessionId: string): void {
    const cur = this.locks.get(serial);
    if (cur && cur !== sessionId) throw new StudioError("SESSION_LIMIT", `Device is controlled by session ${cur}`);
    this.locks.set(serial, sessionId);
  }
  release(serial: string, sessionId: string): void { if (this.locks.get(serial) === sessionId) this.locks.delete(serial); }
}
