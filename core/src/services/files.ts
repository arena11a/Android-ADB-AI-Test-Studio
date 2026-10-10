import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Adb } from "../adb.js";
import { StudioError } from "../types.js";
import type { PolicyEngine } from "../policy.js";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`; // device-shell quoting

export class FileService {
  constructor(private adb: Adb, private policy: PolicyEngine, private localDir: string) {}

  /** Defence in depth: policy already checked, we check again right before touching the device. */
  private assertRemote(p: string): void {
    const why = this.policy.checkRemotePath(p);
    if (why) throw new StudioError("PATH_FORBIDDEN", why);
  }

  async list(serial: string, p: string) {
    this.assertRemote(p);
    const { stdout } = await this.adb.shell(serial, ["ls", "-la", q(p)]);
    return stdout.split("\n").filter(Boolean).slice(1).slice(0, 2000);
  }

  async pull(serial: string, remote: string, local?: string) {
    this.assertRemote(remote);
    const dest = path.resolve(this.localDir, local ?? path.posix.basename(remote));
    if (!dest.startsWith(path.resolve(this.localDir) + path.sep)) throw new StudioError("PATH_FORBIDDEN", "Local destination must stay inside the download folder");
    mkdirSync(path.dirname(dest), { recursive: true });
    await this.adb.must(["pull", remote, dest], { serial, timeoutMs: 600_000 });
    const buf = readFileSync(dest);
    return { local: dest, size: buf.length, sha256: sha256(buf) };
  }

  /** Push with checksum verification. If the remote file exists it is backed up first. */
  async push(serial: string, local: string, remote: string) {
    this.assertRemote(remote);
    const st = statSync(local);
    if (!st.isFile()) throw new StudioError("INVALID_PARAMS", "Local path must be a file");
    const data = readFileSync(local);
    const want = sha256(data);

    let backup: string | undefined;
    if (this.policy.policy.files.backupBeforeOverwrite) {
      const exists = await this.adb.run(["shell", "test", "-e", q(remote), "&&", "echo", "yes"], { serial });
      if (exists.stdout.includes("yes")) {
        backup = `${remote}.bak.${Date.now()}`;
        this.assertRemote(backup);
        await this.adb.shell(serial, ["cp", q(remote), q(backup)]);
      }
    }
    await this.adb.must(["push", local, remote], { serial, timeoutMs: 600_000 });

    // verify: size + sha256 on device
    const h = await this.adb.shell(serial, ["sha256sum", q(remote)]);
    const got = h.stdout.trim().split(/\s+/)[0];
    if (got !== want) throw new StudioError("ADB_ERROR", `Checksum mismatch after push (backup kept at ${backup ?? "n/a"})`);
    return { remote, size: data.length, sha256: want, backup };
  }

  async remove(serial: string, p: string, recursive: boolean) {
    this.assertRemote(p);
    // never delete an allowed root itself
    const roots = this.policy.policy.files.allow.flatMap((a) => a.includes("{target}") ? this.policy.policy.targetPackages.map((t) => a.replace("{target}", t)) : [a]);
    if (roots.includes(path.posix.normalize(p).replace(/\/$/, ""))) throw new StudioError("PATH_FORBIDDEN", "Refusing to delete an allowed root folder");
    await this.adb.shell(serial, recursive ? ["rm", "-r", q(p)] : ["rm", q(p)]);
    return { deleted: p };
  }
}
