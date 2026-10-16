import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Empty, Icon, Pill, Row, Select, TextInput, Toggle } from "../components/ui";
import { useStudio } from "../store";
import { translate, useI18n } from "../i18n";

const LEVELS = ["V", "D", "I", "W", "E", "F"];
/** DOM rows rendered at once — the rest stays in the ring buffer above. */
const LOG_ROWS = 200;
const HL: Record<string, string> = {
  crash: "bg-red-100 text-red-900 dark:bg-red-950/70 dark:text-red-200",
  anr: "bg-orange-100 text-orange-900 dark:bg-orange-950/60 dark:text-orange-200",
  error: "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
};

export function Logs() {
  const { t } = useI18n();
  const logs = useStudio((s) => s.logs);
  const sub = useStudio((s) => s.subscribeLogs);
  const unsub = useStudio((s) => s.unsubscribeLogs);
  const subscribed = useStudio((s) => s.logsSubscribed);
  const notify = useStudio((s) => s.notify);
  const call = useStudio((s) => s.call);

  const [level, setLevel] = useState("I");
  const [tag, setTag] = useState("");
  const [contains, setContains] = useState("");
  const [hold, setHold] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const order = "VDIWEF";
    const min = order.indexOf(level);
    return logs
      .filter((l) => order.indexOf(l.level) >= min)
      .filter((l) => !tag || l.tag.includes(tag))
      .filter((l) => !contains || l.msg.toLowerCase().includes(contains.toLowerCase()))
      .slice(-LOG_ROWS);
  }, [logs, level, tag, contains]);

  useEffect(() => { if (!hold) endRef.current?.scrollIntoView({ block: "end" }); }, [filtered.length, hold]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of logs) c[l.level] = (c[l.level] ?? 0) + 1;
    return c;
  }, [logs]);

  const save = async () => {
    try {
      const r = (await call("logs/query", { level: "V", lines: 2000 })) as { lines: { ts: string; level: string; tag: string; pid: number; msg: string }[] };
      const text = r.lines.map((l) => `${l.ts} ${l.pid} ${l.level} ${l.tag}: ${l.msg}`).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      a.download = `logcat-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
      a.click(); URL.revokeObjectURL(a.href);
      notify(translate("toast.log_saved", { n: r.lines.length }));
    } catch (e) { notify(String(e), "error"); }
  };

  const levelColor = (l: string) => l === "E" || l === "F" ? "text-red-600 dark:text-red-400" : l === "W" ? "text-amber-600 dark:text-amber-400" : "text-[var(--color-ink-3)]";

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_17rem]">
      <Card
        title={t("logs.title")} icon={<Icon name="lines" className="h-4 w-4" />}
        right={
          <Row>
            <span className="mono text-[var(--color-ink-3)]">{logs.length} · {Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" ")}</span>
            {subscribed
              ? <Button kind="danger" size="sm" onClick={() => void unsub()} title={t("logs.stop")}>⏹ {t("logs.stop")}</Button>
              : <Button kind="primary" size="sm" onClick={() => void sub(level)} title={t("logs.start")}>▶ {t("logs.start")}</Button>}
            <Button kind="quiet" size="sm" onClick={() => void save()}>{t("logs.save")}</Button>
          </Row>
        }>
        <Row>
          <Select value={level} onChange={setLevel} className="!w-28" options={LEVELS.map((l) => ({ value: l, label: `≥ ${l}` }))} />
          <TextInput value={tag} onChange={setTag} placeholder={t("logs.tag")} className="!w-36 mono" />
          <TextInput value={contains} onChange={setContains} placeholder={t("logs.contains")} className="!w-44" />
          <Toggle checked={hold} onChange={setHold} label={t("logs.autoscroll")} />
          <Button kind="ghost" size="sm" onClick={() => useStudio.setState({ logs: [] })} title={t("logs.clear")}>🗑 {t("logs.clear")}</Button>
        </Row>

        <div className="mt-3 h-[30rem] overflow-y-auto rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-2)] mono dark:bg-[#060b16]">
          {filtered.length ? filtered.map((l, i) => (
            <div key={`${l.ts}-${l.pid}-${i}`} className={`flex gap-2 px-2 py-0.5 text-[11px] ${l.highlight ? HL[l.highlight] : ""} hover:bg-[var(--color-surface-3)]`}>
              <span className="shrink-0 text-[var(--color-ink-3)]">{l.ts.slice(6)}</span>
              <span className={`shrink-0 font-bold ${levelColor(l.level)}`}>{l.level}</span>
              <span className="w-28 shrink-0 truncate text-[var(--color-ink-3)]" title={l.tag}>{l.tag}</span>
              <span className="whitespace-pre-wrap break-all">{l.msg}</span>
            </div>
          )) : <Empty className="m-3" icon={<Icon name="lines" className="h-8 w-8" />}>{t("logs.empty")}</Empty>}
          <div ref={endRef} />
        </div>
      </Card>

      <Card title={t("logs.policy")}>
        <ul className="space-y-2 text-[11px] leading-relaxed text-[var(--color-ink-2)]">
          <li>{t("logs.note_redact")}</li>
          <li>{t("logs.highlight")}{" "}
            <Pill tone="bad">crash</Pill> <Pill tone="warn">ANR</Pill> <Pill tone="warn">error</Pill>
          </li>
          <li>{t("logs.note_crash")}</li>
          <li>{t("logs.note_target_only")}</li>
          <li>{t("logs.note_buffer")}</li>
        </ul>
      </Card>
    </div>
  );
}
