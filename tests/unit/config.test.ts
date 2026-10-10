import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { homedir } from "node:os";
import {
  SUPPORTED_CONFIG_VERSION, adbVersion, defaultConfigPath, defaultPolicyPath, expandHome,
  loadConfig, loadPolicyFile, resolveAdbPath,
} from "../../core/src/config.js";

describe("config", () => {
  it("expandHome", () => {
    expect(expandHome("~/.adbstudio")).toBe(path.join(homedir(), ".adbstudio"));
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("relative")).toBe("relative");
  });

  it("finds the repo config/policy defaults", () => {
    expect(defaultConfigPath()).toContain(path.join("config", "app.config.json"));
    expect(defaultPolicyPath()).toContain("policy.default.json");
    const cfg = loadConfig();
    expect(cfg.schemaVersion).toBe(SUPPORTED_CONFIG_VERSION);
    expect(typeof cfg.agent.endpointFile).toBe("string");
    expect(loadPolicyFile().mode).toBe("safe");
    expect(loadPolicyFile().forbiddenTools).toContain("raw_shell");
  });

  it("rejects a policy file that is newer than this build", () => {
    const f = path.join(mkdtempSync(path.join(tmpdir(), "pol-")), "p.json");
    writeFileSync(f, JSON.stringify({ schemaVersion: 99, targetPackages: [], features: {} }));
    expect(() => loadPolicyFile(f)).toThrow(/newer than this build/);
  });

  it("rejects a policy file without schemaVersion or targets", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pol-"));
    const a = path.join(dir, "a.json"); writeFileSync(a, JSON.stringify({ mode: "safe" }));
    expect(() => loadPolicyFile(a)).toThrow(/schemaVersion/);
    const b = path.join(dir, "b.json"); writeFileSync(b, JSON.stringify({ schemaVersion: 1, features: {} }));
    expect(() => loadPolicyFile(b)).toThrow(/targetPackages/);
  });

  it("rejects a missing config file", () => {
    expect(() => loadConfig("/nonexistent/app.config.json")).toThrow(/not found/);
  });

  it("explicit adb path is used as-is; auto searches PATH and SDK folders", () => {
    // an explicitly configured path is trusted, but must exist
    const dir = mkdtempSync(path.join(tmpdir(), "adbpath-"));
    const fake = path.join(dir, process.platform === "win32" ? "adb.exe" : "adb");
    writeFileSync(fake, "#!/bin/sh\n");
    chmodSync(fake, 0o755);
    expect(resolveAdbPath(fake)).toBe(fake);
    expect(() => resolveAdbPath(path.join(dir, "nope", "adb"))).toThrow(/not found/);

    // the same fake adb placed on PATH must be found by "auto"
    const old = process.env.PATH;
    process.env.PATH = dir + path.delimiter + old;
    try {
      expect(resolveAdbPath("auto")).toBe(fake);
    } finally { process.env.PATH = old; }
  });

  it("auto resolution either finds a real adb or throws with an install hint", () => {
    try {
      const p = resolveAdbPath("auto");
      expect(p.endsWith("adb") || p.endsWith("adb.exe")).toBe(true);
    } catch (e) {
      expect(String(e)).toMatch(/platform-tools|adb\.path/);
    }
  });

  it("adbVersion reads the first line of `adb version`", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "adbver-"));
    const fake = path.join(dir, process.platform === "win32" ? "adb.exe" : "adb");
    writeFileSync(fake, "#!/bin/sh\necho 'Android Debug Bridge version 1.0.41'\n");
    chmodSync(fake, 0o755);
    expect(adbVersion(fake)).toContain("Android Debug Bridge");
  });
});
