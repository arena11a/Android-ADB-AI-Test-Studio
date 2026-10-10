import { useEffect, useState } from "react";
import { Button, Card, Empty, Icon, KeyVal, Row } from "../components/ui";
import { errMsg, useStudio } from "../store";
import { useI18n } from "../i18n";

const LABELS = ["sessions", "steps", "approvals", "metrics", "file_ops", "app_ops"] as const;

export function History() {
  const { t } = useI18n();
  const db = useStudio((s) => s.db);
  const refreshDb = useStudio((s) => s.refreshDb);
  const call = useStudio((s) => s.call);
  const notify = useStudio((s) => s.notify);

  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { void refreshDb(); }, [refreshDb]);

  const load = async (sessionId?: string) => {
    try {
      const r = sessionId
        ? ((await call("db/steps", { session_id: sessionId })) as { steps: Array<Record<string, unknown>> }).steps
        : ((await call("db/sessions", { limit: 50 })) as { sessions: Array<Record<string, unknown>> }).sessions;
      setRows(r);
      setOpen(sessionId ?? null);
    } catch (e) { notify(errMsg(e), "error"); }
  };

  if (!db.available) {
    return (
      <Card title={t("history.title")} icon={<Icon name="db" className="h-4 w-4" />}>
        <Empty icon={<Icon name="db" className="h-8 w-8" />}>{t("history.unavailable")}</Empty>
        <p className="mt-3 text-[11px] text-[var(--color-ink-3)]">{t("history.hint")}</p>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      <Card title={t("history.title")} icon={<Icon name="db" className="h-4 w-4" />}
            right={<Row>
              <span className="mono text-[var(--color-ink-3)]">{t("history.schema", { n: db.schemaVersion })}</span>
              <Button kind="quiet" size="sm" onClick={() => void refreshDb()}>⟳</Button>
            </Row>}>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {LABELS.map((k) => (
            <div key={k} className="rounded-xl border border-[var(--color-edge)] p-3">
              <div className="text-[11px] text-[var(--color-ink-3)]">{t(`history.${k}`)}</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">{db.stats[k] ?? 0}</div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-3)]">{t("history.hint")}</p>
      </Card>

      <Card title={open ? `${t("history.view_steps")} — ${open}` : t("history.sessions")}
            right={open ? <Button kind="ghost" size="sm" onClick={() => void load()}>{t("history.back")}</Button> : undefined}>
        {rows?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">
                <tr>
                  {Object.keys(rows[0]).map((k) => <th key={k} className="py-1.5 pr-3">{k}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-[var(--color-edge)]">
                    {Object.entries(r).map(([k, v]) => (
                      <td key={k} className="max-w-64 truncate py-1.5 pr-3 mono" title={String(v)}>
                        {k === "id" && !open && <button className="text-[var(--color-brand)] hover:underline" onClick={() => void load(String(v))}>{String(v)}</button>}
                        {!(k === "id" && !open) && String(v ?? "-")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty icon={<Icon name="db" className="h-8 w-8" />}>{t("history.no_rows")}</Empty>}
      </Card>
    </div>
  );
}
