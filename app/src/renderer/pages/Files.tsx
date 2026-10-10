import { useEffect, useState } from "react";
import { Button, Card, Empty, Icon, Pill, Row, TextInput } from "../components/ui";
import { errMsg, useStudio } from "../store";
import { translate, useI18n } from "../i18n";
import type { StudioApi } from "@shared/types";

export function Files() {
  const { t } = useI18n();
  const policy = useStudio((s) => s.policy);
  const runTool = useStudio((s) => s.runTool);
  const notify = useStudio((s) => s.notify);

  const allowed = policy?.files.allow ?? [];
  const [path, setPath] = useState(allowed[0] ?? "/sdcard/Download/adbstudio");
  const [entries, setEntries] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const list = async () => {
    try { const r = (await runTool("file_list", { path, reason: "ดูโฟลเดอร์จาก UI" })) as unknown as { data: { entries: string[] } }; setEntries(r.data.entries); setError(null); }
    catch (e) { setError(errMsg(e)); setEntries([]); }
  };
  useEffect(() => { if (allowed.length) void list(); }, [allowed.join(",")]);

  const join = (name: string) => `${path.replace(/\/$/, "")}/${name}`;

  const pull = async (name: string) => {
    try {
      const r = (await runTool("file_pull", { remote: join(name), reason: `ดาวน์โหลด ${name}` })) as unknown as { data: { local: string; size: number; sha256: string } };
      const err = await window.adbstudio.agent.openPath(r.data.local);
      notify(err === "" ? `บันทึกที่ ${r.data.local}` : `${r.data.local} (sha256 ${r.data.sha256.slice(0, 12)}…)`);
    } catch (e) { notify(errMsg(e), "error"); }
  };

  const push = async () => {
    const r = (await window.adbstudio.agent.chooseLocalFile(t("files.upload"))) as { canceled: boolean; path?: string };
    if (r.canceled || !r.path) return;
    try {
      const res = (await runTool("file_push", { local: r.path, remote: join(r.path.split("/").pop()!), reason: translate("reason.upload") })) as unknown as { data: { remote: string; backup?: string; sha256: string } };
      notify(`${translate("toast.upload_done", { p: res.data.remote })} (sha256 ${res.data.sha256.slice(0, 12)}…)`);
      void list();
    } catch (e) { notify(errMsg(e), "error"); }
  };

  const del = async (name: string) => {
    if (!confirm(`ลบ ${name} ออกจากเครื่อง? (ต้องผ่านการอนุมัติ)`)) return;
    try { await runTool("file_delete", { path: join(name), recursive: false, reason: `${translate("files.delete")} ${name}` }); notify(`${translate("toast.delete_done", { name })} ✓`); void list(); }
    catch (e) { notify(errMsg(e), "error"); }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card title={t("files.browser")} icon={<Icon name="folder" className="h-4 w-4" />} className="xl:col-span-2">
        <Row>
          <div className="min-w-64 flex-1"><TextInput value={path} onChange={setPath} className="mono" /></div>
          <Button kind="primary" onClick={() => void list()}>{t("files.open")}</Button>
          <Button kind="ghost" onClick={() => void push()}>⬆ {t("files.upload")}</Button>
        </Row>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink-3)]">{t("files.hint")}</p>

        {error && <div className="mt-3"><Pill tone="bad">{error}</Pill></div>}

        {entries.length ? (
          <table className="mt-3 w-full text-left">
            <thead className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">
              <tr><th className="py-1.5">{t("files.browser")}</th><th className="py-1.5 text-right">{t("common.ok")}</th></tr>
            </thead>
            <tbody>
              {entries.map((line) => {
                const name = line.split(/\s+/).pop()!;
                const isDir = line.startsWith("d");
                return (
                  <tr key={line} className="border-t border-[var(--color-edge)]">
                    <td className="truncate py-1.5 mono" title={line}>
                      {isDir ? "📁" : "📄"}{" "}
                      <button className="hover:text-[var(--color-brand)] hover:underline" onClick={() => (isDir ? setPath(join(name)) : void pull(name))}>{name}</button>
                    </td>
                    <td className="whitespace-nowrap py-1.5 text-right">
                      {!isDir && <Button kind="quiet" size="sm" onClick={() => void pull(name)}>⬇ {t("files.download")}</Button>}
                      {!isDir && <Button kind="warn" size="sm" className="ml-1" onClick={() => void del(name)}>{t("files.delete")}</Button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : !error && <Empty className="mt-3" icon={<Icon name="folder" className="h-8 w-8" />}>{t("files.empty")}</Empty>}
      </Card>

      <Card title={t("files.allowed")}>
        <ul className="space-y-1">{allowed.map((a) => <li key={a} className="mono text-[11px]">{a}</li>)}</ul>
        <h3 className="mt-4 text-[11px] font-bold uppercase tracking-wide text-[var(--color-ink-3)]">{t("files.denied")}</h3>
        <ul className="mt-1 space-y-1">
          {(policy?.files.deny ?? []).map((a) => <li key={a} className="mono text-[11px] text-red-600 dark:text-red-400">{a}</li>)}
        </ul>
        <h3 className="mt-4 text-[11px] font-bold uppercase tracking-wide text-[var(--color-ink-3)]">{t("files.download_dir")}</h3>
        <p className="mono text-[11px]">{policy?.files.localDownloadDir ?? "-"}</p>
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-3)]">{t("files.notes")}</p>
      </Card>
    </div>
  );
}
