import { useEffect, useState } from "react";
import { Button, Card, Empty, Icon, KeyVal, Pill, Row, Skeleton } from "../components/ui";
import { errMsg, useStudio } from "../store";
import { translate, useI18n } from "../i18n";

interface Finding {
  id: string; severity: "critical" | "high" | "medium" | "low" | "info";
  title: string; detail: string; packages: string[];
  fix?: { tool: "app_disable" | "app_uninstall" | "app_revoke"; package?: string; hint: string };
}
interface Report { serial: string; tookMs: number; findings: Finding[]; stats: Record<string, number> }

const SEV: Record<string, { cls: string; rank: number }> = {
  critical: { cls: "bg-red-100 text-red-900 dark:bg-red-900/50 dark:text-red-100", rank: 0 },
  high: { cls: "bg-orange-100 text-orange-900 dark:bg-orange-900/50 dark:text-orange-100", rank: 1 },
  medium: { cls: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100", rank: 2 },
  low: { cls: "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100", rank: 3 },
  info: { cls: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300", rank: 4 },
};

export function Security() {
  const { t } = useI18n();
  const policy = useStudio((s) => s.policy);
  const hello = useStudio((s) => s.hello);
  const scan = useStudio((s) => s.scan);
  const runScan = useStudio((s) => s.runScan);
  const runTool = useStudio((s) => s.runTool);
  const setMode = useStudio((s) => s.setMode);
  const notify = useStudio((s) => s.notify);

  const report = scan.report as Report | null;
  const repairOn = policy?.mode === "repair";
  const repairFeature = policy?.features.repair ?? false;

  useEffect(() => { if (repairOn && !scan.report && !scan.loading) void runScan(); }, [repairOn, scan.report, scan.loading, runScan]);

  const fix = async (f: Finding) => {
    const pkg = f.packages[0];
    if (!pkg) return;
    if (!confirm(`${f.fix?.hint ?? translate("seqperation.proceed")} → ${pkg}\n${translate("seqperation.needs_approval")}`)) return;
    try {
      if (f.fix?.tool === "app_uninstall") await runTool("app_uninstall", { package: pkg, reason: translate("reason.security_from") });
      else if (f.fix?.tool === "app_revoke") await runTool("app_revoke", { package: pkg, permission: "android.permission.READ_SMS", reason: translate("reason.security_from") });
      else await runTool("app_disable", { package: pkg, reason: translate("reason.security_from") });
      notify(`${pkg} ${translate("common.ok")}`);
      void runScan();
    } catch (e) { notify(errMsg(e), "error"); }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card title={t("sec.title")} icon={<Icon name="shield" className="h-4 w-4" />} className="xl:col-span-2"
            right={
              <Row>
                {!repairOn && (
                  <Button kind="ghost" size="sm" disabled={!repairFeature || hello?.killSwitch}
                          onClick={() => void setMode("repair" as never)}>{t("sec.enable_repair")}</Button>
                )}
                <Button kind="primary" size="sm" onClick={() => void runScan()} disabled={scan.loading}>
                  {scan.loading ? `⏳ ${t("sec.scanning")}` : `🔍 ${t("sec.scan")}`}
                </Button>
              </Row>
            }>
        <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">{t("sec.hint")}</p>
        {!repairFeature && (
          <p className="mt-2 text-[12px] text-amber-600 dark:text-amber-400">
            ⚠ {t("sec.warn_off", { feat: t("set.repair") })} → {t("nav.settings")} → {t("set.advanced_features")}
          </p>
        )}

        {report && (
          <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {([
              ["sec.user_apps", report.stats.userApps],
              ["sec.system_apps", report.stats.systemApps],
              ["sec.device_admins", report.stats.deviceAdmins],
              ["sec.accessibility", report.stats.accessibilityServices],
              ["sec.listeners", report.stats.notificationListeners],
              ["sec.unknown", report.stats.unknownSources],
            ] as Array<[string, number]>).map(([k, v]) => (
              <div key={k} className="rounded-xl border border-[var(--color-edge)] p-2.5">
                <div className="text-[11px] text-[var(--color-ink-3)]">{t(k)}</div>
                <div className="text-lg font-semibold tabular-nums">{v}</div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 space-y-2">
          {scan.loading && <Skeleton rows={4} />}
          {scan.error && <Empty icon="⚠">{scan.error}</Empty>}
          {report && !scan.loading && report.findings.filter((f) => f.severity !== "info").length === 0 && (
            <Empty icon="✓">{t("sec.no_findings")}</Empty>
          )}
          {report?.findings.map((f) => (
            <div key={f.id} className={`rounded-xl border p-3 ${SEV[f.severity].cls}`}>
              <Row className="justify-between">
                <b className="text-[13px]">{f.title}</b>
                <Pill>{t(`sev.${f.severity}`)}</Pill>
              </Row>
              <p className="mt-1 text-[12px] leading-relaxed opacity-90">{f.detail}</p>
              {!!f.packages.length && (
                <ul className="mt-1.5 mono space-y-0.5 text-[11px] opacity-80">
                  {f.packages.slice(0, 8).map((p) => <li key={p}>{p}</li>)}
                </ul>
              )}
              {f.fix && f.packages.length > 0 && (
                <Row className="mt-2">
                  <Button kind="danger" size="sm" disabled={!repairOn || hello?.killSwitch} onClick={() => void fix(f)}>
                    {f.fix.tool === "app_uninstall" ? t("sec.fix_uninstall") : f.fix.tool === "app_revoke" ? t("sec.fix_revoke") : t("sec.fix_disable")}
                  </Button>
                  <span className="text-[11px] opacity-70">{f.fix.hint}</span>
                </Row>
              )}
            </div>
          ))}
          {report?.findings.filter((f) => f.severity === "info").map((f) => (
            <div key={f.id} className="rounded-xl border border-dashed border-[var(--color-edge)] p-3 text-[12px] text-[var(--color-ink-2)]">
              <b className="text-[13px]">{f.title}</b>
              <p className="mt-1 leading-relaxed">{f.detail}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card title={t("sec.stats")}>
        {report ? (
          <KeyVal rows={[
            [t("dev.serial"), <span className="mono">{report.serial}</span>],
            ["ms", `${report.tookMs}`],
            [t("sec.findings"), `${report.findings.length}`],
            [t("dash.status"), repairOn ? `repair` : (policy?.mode ?? "-")],
          ]} />
        ) : <Empty icon={<Icon name="shield" className="h-8 w-8" />}>{t("dash.audit_empty")}</Empty>}
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-3)]">{t("boot.human_only")}</p>
      </Card>
    </div>
  );
}
