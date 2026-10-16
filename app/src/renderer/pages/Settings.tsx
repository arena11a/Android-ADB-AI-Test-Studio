import { useEffect, useState } from "react";
import { Button, Card, Empty, Icon, KeyVal, Pill, Row, Select, TextInput, Toggle } from "../components/ui";
import { errMsg, useStudio } from "../store";
import { MODES, ROLES, translate } from "../i18n";
import { useI18n } from "../i18n";
import { localeOf } from "../i18n";

/** feature flag labels come from the dictionaries (no hardcoded strings) */
const FEATURE_LABELS: Record<string, [string, string]> = {
  files: ["feat.files", "feat.files.hint"],
  install: ["feat.install", "feat.install.hint"],
  delete: ["feat.delete", "feat.delete.hint"],
  input: ["feat.input", "feat.input.hint"],
  power: ["feat.power", "feat.power.hint"],
  advancedMode: ["feat.advanced", "feat.advanced.hint"],
  liveView: ["feat.live", "feat.live.hint"],
  repair: ["set.repair", "set.repair.hint"],
  bootloader: ["set.bootloader", "set.bootloader.hint"],
};

/** features that live in the "advanced" section above — never repeated in the risky grid */
const ADVANCED_FEATURES = new Set(["liveView", "repair", "bootloader"]);

export function Settings({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const { t, lang } = useI18n();
  const locale = localeOf(lang);
  const policy = useStudio((s) => s.policy);
  const audit = useStudio((s) => s.audit);
  const db = useStudio((s) => s.db);
  const status = useStudio((s) => s.status);
  const hello = useStudio((s) => s.hello);
  const setMode = useStudio((s) => s.setMode);
  const setRole = useStudio((s) => s.setRole);
  const setFeatures = useStudio((s) => s.setFeatures);
  const setTargets = useStudio((s) => s.setTargets);
  const safeMode = useStudio((s) => s.safeMode);
  const refreshAudit = useStudio((s) => s.refreshAudit);
  const call = useStudio((s) => s.call);
  const notify = useStudio((s) => s.notify);

  const folders = useStudio((s) => s.folders);
  const refreshFolders = useStudio((s) => s.refreshFolders);
  const aiClients = useStudio((s) => s.aiClients);
  const [verify, setVerify] = useState<{ ok: boolean; brokenAtSeq?: number } | null>(null);
  const [apkDir, setApkDir] = useState("");
  const refreshDb = useStudio((s) => s.refreshDb);

  useEffect(() => { void refreshAudit(); void refreshDb(); void refreshFolders(); }, [refreshAudit, refreshDb, refreshFolders]);

  if (!policy) return <Empty>{t("common.loading")}</Empty>;

  const act = async (fn: () => Promise<void>, ok: string) => { try { await fn(); notify(ok); } catch (e) { notify(errMsg(e), "error"); } };
  const download = (text: string, name: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = name; a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title={t("set.policy")} icon={<Icon name="gear" className="h-4 w-4" />}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className="label">{t("set.mode")}</span>
            <Select value={policy.mode} onChange={(v) => void act(() => setMode(v), "✓")} options={MODES.map((m) => ({ value: m, label: translate(`mode.short.${m}`) }))} />
            <p className="mt-1 text-[11px] leading-snug text-[var(--color-ink-3)]">{t(`mode.${policy.mode}`)}</p>
          </div>
          <div>
            <span className="label">{t("set.role")}</span>
            <Select value={policy.role} onChange={(v) => void act(() => setRole(v), "✓")} options={ROLES.map((r) => ({ value: r, label: translate(`role.${r}`) }))} />
            <p className="mt-1 text-[11px] leading-snug text-[var(--color-ink-3)]">{t("set.role_hint")}</p>
          </div>
        </div>

        <h3 className="mt-4 text-[11px] font-bold uppercase tracking-wide text-[var(--color-ink-3)]">{t("set.advanced_features")}</h3>
        <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
          {(["liveView", "repair", "bootloader"] as const).map((k) => (
            <Toggle key={k} checked={policy.features[k]} label={t(FEATURE_LABELS[k][0])} hint={t(FEATURE_LABELS[k][1])}
                    onChange={(v) => void act(() => setFeatures({ [k]: v }), t(FEATURE_LABELS[k][0]))} />
          ))}
        </div>

        <h3 className="mt-4 text-[11px] font-bold uppercase tracking-wide text-[var(--color-ink-3)]">{t("set.features")}</h3>
        <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
          {Object.entries(policy.features)
            .filter(([k]) => !ADVANCED_FEATURES.has(k))
            .map(([k, v]) => (
              <Toggle key={k} checked={v} label={t(FEATURE_LABELS[k][0])} hint={t(FEATURE_LABELS[k][1])}
                      onChange={(nv) => void act(() => setFeatures({ [k]: nv }), t(FEATURE_LABELS[k][0]))} />
            ))}
        </div>

        <Row className="mt-4">
          <Button kind="warn" onClick={() => void safeMode().catch((e) => notify(errMsg(e), "error"))}>🛡 {t("set.safe_mode")}</Button>
          <span className="self-center text-[11px] text-[var(--color-ink-3)]">{t("set.safe_mode_hint")}</span>
        </Row>

        <h3 className="mt-4 text-[11px] font-bold uppercase tracking-wide text-[var(--color-ink-3)]">{t("set.apk_dirs")}</h3>
        <Row className="mt-1.5">
          <div className="flex-1"><TextInput value={apkDir} onChange={setApkDir} placeholder="/home/you/adbstudio/apk" className="mono" /></div>
          <Button kind="ghost" onClick={() => void act(async () => {
            await call("policy/set_local_apk_dirs", { dirs: [...(policy.localApkDirs ?? []), apkDir] }); setApkDir("");
          }, "✓")}>{t("set.add")}</Button>
        </Row>
        <ul className="mt-2 space-y-1">
          {(policy.localApkDirs ?? []).map((d) => (
            <li key={d} className="flex items-center justify-between rounded-lg border border-[var(--color-edge)] px-2 py-1 text-[11px]">
              <span className="mono">{d}</span>
              <Button kind="quiet" size="sm" onClick={() => void act(async () =>
                call("policy/set_local_apk_dirs", { dirs: policy.localApkDirs.filter((x) => x !== d) }), "✓")}>✕</Button>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={t("set.ai")} icon={<Icon name="shield" className="h-4 w-4" />}>
        <KeyVal rows={[
          [t("set.ai_logs_target"), policy.ai.logsTargetOnly ? t("common.yes") : t("common.no")],
          [t("set.ai_raw_coords"), policy.ai.allowRawCoordinates ? t("common.yes") : t("common.no")],
          [t("set.ai_reason"), policy.ai.requireReason ? t("common.yes") : t("common.no")],
          [t("set.rate_limits"), <span className="mono">{Object.entries(policy.rateLimits).map(([k, v]) => `${k}=${v}`).join(" · ")}</span>],
          [t("set.privacy_record"), <Pill tone={policy.privacy.recordVideo ? "ok" : "neutral"}>{policy.privacy.recordVideo ? t("common.on") : t("common.off")}</Pill>],
        ]} />
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-3)]">{t("set.ai_hint")}</p>
      </Card>

      <Card title={t("set.folders")} icon={<Icon name="folder" className="h-4 w-4" />}>
        <ul className="space-y-2">
          {folders && ([
            ["files.screenshots", folders.screenshots],
            ["files.recordings", folders.recordings],
            ["files.pulled", policy.files.localDownloadDir],
            ["set.sessions_dir", folders.sessions],
            ["set.audit_dir", folders.audit],
          ] as Array<[string, string]>).map(([k, p2]) => (
            <li key={k} className="flex items-center gap-2 rounded-lg border border-[var(--color-edge)] px-2.5 py-1.5">
              <span className="w-28 shrink-0 text-[11px] text-[var(--color-ink-3)]">{t(k)}</span>
              <span className="mono flex-1 truncate text-[11px]" title={p2}>{p2}</span>
              <Button kind="quiet" size="sm" title={t("files.open_folder")} onClick={() => void window.adbstudio.agent.openPath(p2)}>↗</Button>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-3)]">{t("files.save_hint")}</p>
      </Card>

      <Card title={t("set.ai_connect")} icon={<Icon name="shield" className="h-4 w-4" />}
            right={<Pill tone={aiClients > 0 ? "ok" : "neutral"}>
              <span className={`h-1.5 w-1.5 rounded-full ${aiClients > 0 ? "bg-emerald-500" : "bg-zinc-400"}`} />
              {aiClients > 0 ? t("app.ai_connected", { n: aiClients }) : t("app.ai_disconnected")}
            </Pill>}>
        <p className="text-[12px] leading-relaxed text-[var(--color-ink-2)]">{t("set.ai_connect_hint")}</p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12px] text-[var(--color-ink-2)]">
          <li>{t("set.ai_step1")}</li>
          <li>{t("set.ai_step2")}</li>
          <li>{t("set.ai_step3")}</li>
        </ol>
        <pre className="mono mt-3 overflow-x-auto rounded-xl bg-[var(--color-surface-2)] p-3 text-[11px] dark:bg-[#060b16]">{"cd " + (status.adbPath ? "~/adb-ai-test-studio" : ".") + "\nnpm run bridge        # MCP stdio server -> agent\n# endpoint file (read by the bridge):\n" + "~/.adbstudio/endpoint.json"}</pre>
        <Row className="mt-3">
          <span className="mono text-[11px] text-[var(--color-ink-3)]">ADBSTUDIO_CLIENT=opencode|claude-code</span>
        </Row>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink-3)]">{t("set.ai_verify")}</p>
      </Card>

      <Card title={t("set.audit")} icon={<Icon name="lines" className="h-4 w-4" />} className="xl:col-span-2"
            right={<Row>
              <Button kind="quiet" size="sm" onClick={async () => setVerify((await call("audit/verify")) as { ok: boolean; brokenAtSeq?: number })}>{t("set.check")}</Button>
              <Button kind="quiet" size="sm" onClick={async () => {
                const r = (await call("audit/export", { format: "csv" })) as { text: string }; download(r.text, "audit.csv"); notify(translate("toast.csv_saved"));
              }}>CSV</Button>
              <Button kind="quiet" size="sm" onClick={() => void refreshAudit()}>⟳</Button>
            </Row>}>
        {verify && (
          <p className={`mb-2 text-[13px] ${verify.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
            {verify.ok ? `✓ ${t("set.audit_ok")}` : `✗ ${t("set.audit_broken", { n: verify.brokenAtSeq ?? 0 })}`}
          </p>
        )}
        {audit.length ? (
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-[var(--color-surface)] text-[var(--color-ink-3)]">
                <tr><th className="py-1">#</th><th>{t("sess.col_time")}</th><th>{t("set.col_actor")}</th><th>{t("sess.col_tool")}</th><th>{t("sess.col_risk")}</th><th>{t("set.col_decision")}</th><th>{t("sess.col_result")}</th><th>{t("set.col_device")}</th></tr>
              </thead>
              <tbody>
                {audit.map((e) => (
                  <tr key={e.seq} className="border-t border-[var(--color-edge)]">
                    <td className="tabular-nums">{e.seq}</td>
                    <td className="text-[var(--color-ink-3)]">{new Date(e.ts).toLocaleTimeString(locale)}</td>
                    <td>{e.actor}{e.client ? ` (${e.client})` : ""}</td>
                    <td className="mono">{e.tool}</td>
                    <td>{e.risk}</td>
                    <td>{e.decision}</td>
                    <td className={e.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>{e.ok ? t("common.ok") : e.error_code}</td>
                    <td className="max-w-32 truncate text-[var(--color-ink-3)]" title={e.device}>{e.device ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty icon={<Icon name="lines" className="h-8 w-8" />}>{t("dash.audit_empty")}</Empty>}
        <p className="mt-2 text-[11px] text-[var(--color-ink-3)]">{t("set.audit_jsonl")}</p>
      </Card>

      <Card title={t("set.agent")} icon={<Icon name="db" className="h-4 w-4" />}>
        <KeyVal rows={[
          [t("set.col_status"), status.running ? t("common.ok") : t("common.error")],
          [t("dash.adb"), <span className="mono">{status.adbPath ?? "-"}</span>],
          [t("set.sqlite"), db.available ? <Pill tone="ok">{t("common.on")} · v{db.schemaVersion}</Pill> : <Pill tone="warn">{t("common.off")} (JSON)</Pill>],
          [t("dash.agent_restarts"), `${status.restarts}`],
          [t("app.kill_switch"), hello?.killSwitch ? <Pill tone="bad">{t("common.on")}</Pill> : <Pill tone="ok">{t("common.off")}</Pill>],
          [t("dash.targets"), policy.targetPackages.join(", ") || t("dash.targets_none")],
        ]} />
        <Row className="mt-3">
          <Button kind="ghost" onClick={() => void window.adbstudio.agent.restart()}>↻ {t("app.restart_agent")}</Button>
          {policy.targetPackages.length > 0 && (
            <Button kind="ghost" onClick={() => void act(() => setTargets([]), "✓")}>{t("set.clear_targets")}</Button>
          )}
          <Button kind="ghost" onClick={() => void onRefresh()}>{t("set.reconnect")}</Button>
        </Row>
      </Card>
    </div>
  );
}
