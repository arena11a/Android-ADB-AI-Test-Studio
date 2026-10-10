import { useEffect, useState } from "react";
import { Button, Card, Empty, Icon, KeyVal, Pill, Row, Select, TextInput } from "../components/ui";
import { errMsg, useStudio } from "../store";
import { useI18n } from "../i18n";
import type { Session } from "@shared/types";

export function Sessions() {
  const { t } = useI18n();
  const policy = useStudio((s) => s.policy);
  const session = useStudio((s) => s.session);
  const history = useStudio((s) => s.history);
  const setHistory = (h: Session[]) => useStudio.setState({ history: h });
  const start = useStudio((s) => s.startSession);
  const stop = useStudio((s) => s.stopSession);
  const report = useStudio((s) => s.createReport);
  const call = useStudio((s) => s.call);
  const notify = useStudio((s) => s.notify);

  const [name, setName] = useState(`Session ${new Date().toLocaleString("th-TH")}`);
  const [goal, setGoal] = useState("");
  const pkg = policy?.targetPackages[0] ?? "";

  useEffect(() => {
    void call("sessions/history", { limit: 20 }).then((r: { sessions: Session[] }) => setHistory(r.sessions)).catch(() => undefined);
  }, [session?.status, call]);

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card title={t("sess.new")} icon={<Icon name="clock" className="h-4 w-4" />}>
        <span className="label">{t("sess.name")}</span>
        <TextInput value={name} onChange={setName} />
        <span className="label mt-2">{t("sess.goal")}</span>
        <TextInput value={goal} onChange={setGoal} placeholder={t("sess.goal_ph")} />
        <div className="mt-3 rounded-xl bg-[var(--color-surface-2)] p-2.5 text-[11px] dark:bg-[var(--color-surface-3)]">
          {t("sess.target")}: <span className="mono">{pkg || t("sess.target_missing")}</span>
        </div>
        <Row className="mt-3">
          <Button kind="primary" disabled={!pkg || !!session}
                  onClick={async () => { try { await start(name, pkg, goal || undefined); } catch (e) { notify(errMsg(e), "error"); } }}>
            {t("sess.start")}
          </Button>
          {session && <Button kind="danger" onClick={() => void stop("ui")}>{t("sess.stop")}</Button>}
        </Row>
      </Card>

      <Card title={session ? `${t("sess.current")}: ${session.name}` : t("sess.current")} className="xl:col-span-2"
            right={session && (
              <Row>
                {(["html", "md", "json"] as const).map((f) => (
                  <Button key={f} kind="quiet" size="sm" onClick={() => void report(f).catch((e) => notify(errMsg(e), "error"))}>{f.toUpperCase()}</Button>
                ))}
              </Row>
            )}>
        {session ? (
          <>
            <KeyVal rows={[
              [t("sess.col_package"), <span className="mono">{session.package}</span>],
              [t("common.ok"), `${session.status}${session.stopReason ? ` · ${session.stopReason}` : ""}`],
              [t("sess.col_steps"), `${session.steps.length} / ${session.maxSteps}`],
              [t("dash.crash_anr"), `${session.crashes.length} / ${session.anrs.length}`],
              [t("dash.artifacts"), <span className="mono">{session.dir}</span>],
            ]} />
            <div className="mt-3 max-h-72 overflow-y-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="text-[var(--color-ink-3)]"><tr><th className="py-1">{t("sess.col_idx")}</th><th>{t("sess.col_tool")}</th><th>{t("sess.col_result")}</th><th>{t("sess.col_risk")}</th><th>{t("sess.col_time")}</th></tr></thead>
                <tbody>
                  {session.steps.slice().reverse().map((s) => (
                    <tr key={s.idx} className="border-t border-[var(--color-edge)]">
                      <td className="py-1 tabular-nums">{s.idx}</td>
                      <td className="mono">{s.tool}</td>
                      <td className={s.result === "success" ? "text-emerald-600 dark:text-emerald-400" : s.result === "blocked" || s.result === "denied" ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"}>{s.result}</td>
                      <td>{s.risk}</td>
                      <td className="text-[var(--color-ink-3)]">{new Date(s.ts).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : <Empty icon={<Icon name="clock" className="h-8 w-8" />}>{t("sess.no_session")}</Empty>}
      </Card>

      <Card title={t("sess.history")} className="xl:col-span-3">
        {history.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">
                <tr><th className="py-1.5">{t("sess.col_name")}</th><th>{t("sess.col_package")}</th><th>{t("sess.col_start")}</th><th>{t("sess.col_end")}</th><th>{t("sess.col_reason")}</th><th>{t("sess.col_steps")}</th><th>{t("sess.col_crash")}</th></tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-t border-[var(--color-edge)]">
                    <td className="py-1.5">{h.name}</td>
                    <td className="mono text-[11px]">{h.package}</td>
                    <td className="text-[var(--color-ink-3)]">{new Date(h.startedAt).toLocaleString("th-TH")}</td>
                    <td className="text-[var(--color-ink-3)]">{h.endedAt ? new Date(h.endedAt).toLocaleString("th-TH") : "-"}</td>
                    <td>{h.stopReason ?? "-"}</td>
                    <td className="tabular-nums">{h.steps.length}</td>
                    <td className="tabular-nums">{h.crashes.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty icon={<Icon name="clock" className="h-8 w-8" />}>{t("sess.history_empty")}</Empty>}
      </Card>
    </div>
  );
}
