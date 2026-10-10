import { useEffect, useState } from "react";
import { Button, Card, Empty, Icon, Row, Select } from "../components/ui";
import { Sparkline, StatBox } from "../components/Charts";
import { errMsg, useStudio } from "../store";
import { translate, useI18n } from "../i18n";

const INTERVALS = [1000, 2000, 5000];

export function Metrics() {
  const { t } = useI18n();
  const metrics = useStudio((s) => s.metrics);
  const subscribed = useStudio((s) => s.metricsSubscribed);
  const sub = useStudio((s) => s.subscribeMetrics);
  const unsub = useStudio((s) => s.unsubscribeMetrics);
  const policy = useStudio((s) => s.policy);
  const call = useStudio((s) => s.call);
  const notify = useStudio((s) => s.notify);

  const pkg = policy?.targetPackages[0];
  const [interval, setInterval] = useState(2000);
  const last = metrics[metrics.length - 1];
  const series = (key: "cpu_sys" | "cpu_app" | "ram_app_kb" | "batt_pct" | "storage_free_kb" | "batt_temp_c") =>
    metrics.map((m) => m[key]).filter((v): v is number => typeof v === "number");

  useEffect(() => () => { void unsub(); }, []);

  const csv = async () => {
    try {
      const r = (await call("metrics/csv")) as { csv: string };
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([r.csv], { type: "text/csv" }));
      a.download = `metrics-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
      a.click(); URL.revokeObjectURL(a.href);
      notify(translate("toast.csv_saved"));
    } catch (e) { notify(errMsg(e), "error"); }
  };

  return (
    <div className="grid gap-4">
      <Card
        title={t("metrics.title")} icon={<Icon name="chart" className="h-4 w-4" />}
        right={
          <Row>
            <Select value={String(interval)} onChange={(v) => setInterval(Number(v))} className="!w-36"
                    options={INTERVALS.map((i) => ({ value: String(i), label: t("metrics.every", { n: i / 1000 }) }))} />
            {subscribed
              ? <Button kind="danger" size="sm" onClick={() => void unsub()}>⏹ {t("metrics.stop")}</Button>
              : <Button kind="primary" size="sm" onClick={() => void sub(interval)}>▶ {t("metrics.start")}</Button>}
            <Button kind="quiet" size="sm" onClick={() => void csv()}>CSV</Button>
            <span className="mono text-[var(--color-ink-3)]">{t("metrics.points", { n: metrics.length })}</span>
          </Row>
        }>
        {!subscribed && !metrics.length && <Empty icon={<Icon name="chart" className="h-8 w-8" />}>{t("metrics.hint")}{pkg ? ` (${pkg})` : ""}</Empty>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatBox label={t("metrics.cpu_sys")} value={last?.cpu_sys !== undefined ? last.cpu_sys.toFixed(1) : "—"} sup="%">
            <Sparkline values={series("cpu_sys")} unit="%" color="#3b82f6" />
          </StatBox>
          <StatBox label={t("metrics.cpu_app")} value={last?.cpu_app !== undefined ? last.cpu_app.toFixed(1) : "—"} sup="%">
            <Sparkline values={series("cpu_app")} unit="%" color="#8b5cf6" />
          </StatBox>
          <StatBox label={t("metrics.ram")} value={last?.ram_app_kb !== undefined ? (last.ram_app_kb / 1024).toFixed(0) : "—"} sup="MB">
            <Sparkline values={series("ram_app_kb").map((v) => v / 1024)} unit=" MB" color="#10b981" />
          </StatBox>
          <StatBox label={t("metrics.battery")} value={last?.batt_pct !== undefined ? String(last.batt_pct) : "—"} sup="%">
            <Sparkline values={series("batt_pct")} unit="%" color="#f59e0b" />
          </StatBox>
          <StatBox label={t("metrics.temp")} value={last?.batt_temp_c !== undefined ? last.batt_temp_c.toFixed(1) : "—"} sup="°C">
            <Sparkline values={series("batt_temp_c")} unit="°C" color="#ef4444" />
          </StatBox>
          <StatBox label={t("metrics.storage")} value={last?.storage_free_kb !== undefined ? (last.storage_free_kb / 1048576).toFixed(0) : "—"} sup="GB">
            <Sparkline values={series("storage_free_kb").map((v) => v / 1048576)} unit=" GB" color="#0ea5e9" />
          </StatBox>
        </div>
      </Card>

      <Card title={t("metrics.limited")}>
        {last?.limited.length
          ? <ul className="list-disc space-y-1 pl-5 text-[13px] text-[var(--color-ink-2)]">{last.limited.map((l) => <li key={l}>{l}</li>)}</ul>
          : <Empty>{t("metrics.limited_ok")}</Empty>}
      </Card>
    </div>
  );
}
