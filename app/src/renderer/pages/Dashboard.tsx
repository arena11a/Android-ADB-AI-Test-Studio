import { useEffect, useState } from "react";
import { Button, Card, Empty, Icon, KeyVal, Pill, Row } from "../components/ui";
import { StatBox } from "../components/Charts";
import { DeviceFacts } from "../components/Devices";
import { errMsg, useStudio } from "../store";
import { translate, useI18n, localeOf } from "../i18n";
import type { DeviceInfo } from "@shared/types";

export function Dashboard() {
  const { t, lang } = useI18n();
  const locale = localeOf(lang);
  const hello = useStudio((s) => s.hello);
  const policy = useStudio((s) => s.policy);
  const devices = useStudio((s) => s.devices);
  const selected = useStudio((s) => s.selected);
  const session = useStudio((s) => s.session);
  const approvals = useStudio((s) => s.approvals);
  const audit = useStudio((s) => s.audit);
  const status = useStudio((s) => s.status);
  const runTool = useStudio((s) => s.runTool);
  const notify = useStudio((s) => s.notify);
  const refresh = useStudio((s) => s.refresh);
  const refreshAudit = useStudio((s) => s.refreshAudit);
  const stopSession = useStudio((s) => s.stopSession);
  const setPage = useStudio((s) => s.setPage);
  const folders = useStudio((s) => s.folders);
  const saveScreenshot = useStudio((s) => s.saveScreenshot);
  const applyPreset = useStudio((s) => s.applyPreset);

  const [shot, setShot] = useState<string | null>(null);
  const device: DeviceInfo | undefined = devices.find((d) => d.serial === selected) ?? devices[0];

  useEffect(() => { if (!audit.length) void refreshAudit(); }, [audit.length, refreshAudit]);

  const act = async (label: string, tool: string, params: Record<string, unknown> = {}) => {
    try { await runTool(tool, { reason: label, ...params }); notify(`${label} ✓`); }
    catch (e) { notify(errMsg(e), "error"); }
  };
  const screenshot = async () => {
    try {
      const r = (await runTool("screenshot", { reason: translate("reason.screenshot_dash") })) as unknown as { data: { png_base64: string; bytes: number } };
      setShot(`data:image/png;base64,${r.data.png_base64}`);
      notify(translate("toast.shot_ok", { kb: (r.data.bytes / 1024).toFixed(0) }));
    } catch (e) { notify(errMsg(e), "error"); }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Row className="xl:col-span-3">
        <span className="text-[11px] text-[var(--color-ink-3)]">{t("preset.hint")}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {(["read", "test", "repair", "bootloader"] as const).map((p) => (
            <Button key={p} kind="ghost" size="sm" title={t(`mode.${p === "read" ? "observe" : p === "test" ? "develop" : p}`)}
                    onClick={() => void applyPreset(p)}>
              {t(`preset.${p}`)}
            </Button>
          ))}
        </div>
      </Row>

      {(!device || !policy?.targetPackages.length) && (
        <Card title={t("dash.setup")} icon={<Icon name="shield" className="h-4 w-4" />} className="xl:col-span-3">
          <ol className="grid gap-2 sm:grid-cols-3">
            {([
              ["dash.step1", "nav.apps", !device],
              ["dash.step2", "nav.apps", !!device && !policy?.targetPackages.length],
              ["dash.step3", "nav.settings", false],
            ] as Array<[string, string, boolean]>).map(([key, page, done], i) => (
              <li key={key} className={`rounded-xl border p-3 ${done ? "border-[var(--color-brand)] bg-blue-50/40 dark:bg-blue-950/20" : "border-[var(--color-edge)]"}`}>
                <div className="flex items-center gap-2">
                  <span className={`grid h-6 w-6 place-items-center rounded-full text-[12px] font-bold ${done ? "bg-[var(--color-brand)] text-white" : "bg-[var(--color-surface-3)] text-[var(--color-ink-3)]"}`}>{i + 1}</span>
                  <b className="text-[13px]">{t(key)}</b>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-ink-2)]">{t(`${key}.hint`)}</p>
                <Button kind="ghost" size="sm" className="mt-2" onClick={() => setPage((page as string).replace(/^nav\./, "") as never)}>{t(page)}</Button>
              </li>
            ))}
          </ol>
        </Card>
      )}

      <Card title={t("dash.device")} icon={<Icon name="phone" className="h-4 w-4" />}
            right={<Button kind="quiet" size="sm" onClick={() => void refresh()}>⟳</Button>}
            className={device ? "xl:col-span-2" : ""}>
        {device ? (
          <>
            <DeviceFacts d={device} />
            <Row className="mt-4">
              <Button kind="primary" onClick={() => void screenshot()} disabled={hello?.killSwitch} title={t("quick.screenshot_hint")}>📸 {t("dash.screenshot")}</Button>
              <Button kind="ghost" onClick={() => void saveScreenshot()} disabled={hello?.killSwitch} title={t("quick.save_hint")}>💾 {t("dash.save_shot")}</Button>
              <Button kind="ghost" onClick={() => void act(t("dash.ui_dump"), "ui_hierarchy")} title={t("quick.ui_hint")}>🧩 {t("dash.ui_dump")}</Button>
              <Button kind="ghost" onClick={() => setPage("logs")} title={t("quick.logs_hint")}>≡ {t("dash.open_logs")}</Button>
              <Button kind="ghost" onClick={() => setPage("metrics")} title={t("quick.metrics_hint")}>◔ {t("dash.open_metrics")}</Button>
              <Button kind="ghost" onClick={() => setPage("live")} title={t("quick.live_hint")}>🖥 {t("nav.live")}</Button>
              <Button kind="ghost" onClick={() => setPage("record")} title={t("quick.record_hint")}>⏺ {t("nav.record")}</Button>
              <Button kind="ghost" onClick={() => setPage("security")} title={t("quick.security_hint")}>🛡 {t("nav.security")}</Button>
            </Row>
            <p className="mt-2 text-[11px] text-[var(--color-ink-3)]">
              {t("quick.need_mode", { mode: policy ? t(`mode.short.${policy.mode}`) : t("mode.short.safe") })}
            </p>
          </>
        ) : <Empty icon={<Icon name="phone" className="h-8 w-8" />}>{t("dash.no_device")}</Empty>}
      </Card>

      <Card title={t("dash.status")} icon={<Icon name="gear" className="h-4 w-4" />}>
        <KeyVal rows={[
          [t("app.mode"), policy ? <>{t(`mode.short.${policy.mode}`)}</> : "-"],
          [t("dash.role"), policy ? t(`role.${policy.role}`) : "-"],
          [t("dash.targets"), policy?.targetPackages.length ? <span className="mono">{policy.targetPackages.join(", ")}</span> : t("dash.targets_none")],
          [t("app.kill_switch"), hello?.killSwitch
            ? <Pill tone="bad">{t("dash.kill_switch_active")}</Pill>
            : <Pill tone="ok">{t("dash.kill_switch_off")}</Pill>],
          [t("dash.pending"), <Pill tone={approvals.length ? "warn" : "neutral"}>{approvals.length}</Pill>],
          [t("dash.adb"), <span className="mono">{status.adbPath ?? "-"}</span>],
          [t("dash.agent_restarts"), `${status.restarts}`],
        ]} />
      </Card>

      {shot && (
        <Card title={t("dash.screenshot_title")} className="xl:col-span-2"
              right={<Button kind="quiet" size="sm" onClick={() => setShot(null)}>✕</Button>}>
          <img src={shot} alt="screenshot" className="max-h-96 rounded-xl border border-[var(--color-edge)]" />
        </Card>
      )}

      <Card title={t("dash.current_session")} icon={<Icon name="clock" className="h-4 w-4" />}
            right={session && <Button kind="danger" size="sm" onClick={() => void stopSession("ui")}>{t("dash.stop_session")}</Button>}>
        {session ? (
          <KeyVal rows={[
            [t("sess.col_name"), session.name],
            [t("dash.package"), <span className="mono">{session.package}</span>],
            [t("dash.steps"), `${session.steps.length} / ${session.maxSteps}`],
            [t("dash.crash_anr"), `${session.crashes.length} / ${session.anrs.length}`],
            [t("dash.approvals_ok_denied"), `${session.approvals.approved} / ${session.approvals.denied}`],
            [t("dash.artifacts"), <span className="mono">{session.dir}</span>],
          ]} />
        ) : <Empty icon={<Icon name="clock" className="h-8 w-8" />}>{t("dash.no_session")}</Empty>}
      </Card>

      <Card title={t("dash.audit")} icon={<Icon name="lines" className="h-4 w-4" />}
            right={<Button kind="quiet" size="sm" onClick={() => setPage("settings")}>{t("dash.audit_open")}</Button>}
            className="xl:col-span-2">
        {audit.length ? (
          <ul className="space-y-1">
            {audit.slice(0, 8).map((e) => (
              <li key={e.seq} className="flex items-center gap-2 text-[11px]">
                <span className="mono w-12 shrink-0 text-[var(--color-ink-3)]">#{e.seq}</span>
                <span className="w-16 shrink-0 text-[var(--color-ink-3)]">{new Date(e.ts).toLocaleTimeString(locale)}</span>
                <span className={`mono w-28 shrink-0 truncate ${e.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`} title={e.tool}>{e.tool}</span>
                <span className="mono w-20 shrink-0 text-[var(--color-ink-3)]">{e.actor}</span>
                <span className="truncate">{e.ok ? e.decision : e.error_code}</span>
              </li>
            ))}
          </ul>
        ) : <Empty icon={<Icon name="lines" className="h-8 w-8" />}>{t("dash.audit_empty")}</Empty>}
      </Card>

      {device && (
        <Card title={t("dash.metrics_live")} icon={<Icon name="chart" className="h-4 w-4" />} className="xl:col-span-3">
          <LiveStats />
        </Card>
      )}
    </div>
  );
}

function LiveStats() {
  const { t } = useI18n();
  const metrics = useStudio((s) => s.metrics);
  const call = useStudio((s) => s.call);
  const [once, setOnce] = useState<{ cpu_sys?: number; cpu_app?: number; ram_app_kb?: number; batt_pct?: number; batt_temp_c?: number; storage_free_kb?: number; limited?: string[] } | null>(null);

  useEffect(() => {
    void call("tool/call", { tool: "metrics_read", params: { reason: translate("reason.dashboard"), seconds: 3, interval_ms: 1000 } })
      .then((r: { data?: { samples: typeof once[] } }) => r?.data?.samples?.length && setOnce(r.data.samples[r.data.samples.length - 1]))
      .catch(() => undefined);
  }, [call]);

  const s = metrics[metrics.length - 1] ?? once;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatBox label={t("metrics.cpu_sys")} value={s?.cpu_sys !== undefined ? `${s.cpu_sys.toFixed(1)}%` : "—"} sup="%" />
      <StatBox label={t("metrics.ram")} value={s?.ram_app_kb !== undefined ? `${(s.ram_app_kb / 1024).toFixed(0)}` : "—"} sup="MB" />
      <StatBox label={t("metrics.battery")} value={s?.batt_pct !== undefined ? `${s.batt_pct}%` : "—"} sup={s?.charging ? t("metrics.charging") : undefined} />
      <StatBox label={t("metrics.storage")} value={s?.storage_free_kb !== undefined ? `${(s.storage_free_kb / 1048576).toFixed(0)}` : "—"} sup="GB" />
    </div>
  );
}
