import { useEffect, useState } from "react";
import { Button, Card, Empty, Icon, Pill, Row, Select, TextInput } from "../components/ui";
import { translate } from "../i18n";
import { errMsg, useStudio } from "../store";
import { useI18n } from "../i18n";
import type { StudioApi } from "@shared/types";

interface AppList { user: string[]; system_count: number; targets: string[] }

export function Apps() {
  const { t } = useI18n();
  const policy = useStudio((s) => s.policy);
  const hello = useStudio((s) => s.hello);
  const setTargets = useStudio((s) => s.setTargets);
  const runTool = useStudio((s) => s.runTool);
  const notify = useStudio((s) => s.notify);

  const [scope, setScope] = useState<"target" | "user">("user");
  const [apps, setApps] = useState<AppList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [pkg, setPkg] = useState("");

  const load = async () => {
    try { const r = (await runTool("app_list", { scope })) as unknown as { data: AppList }; setApps(r.data); setListError(null); }
    catch (e) { setListError(errMsg(e)); setApps(null); }
  };
  useEffect(() => { void load(); }, [scope, policy?.targetPackages.join(","), hello?.killSwitch]);

  const act = async (label: string, tool: string, params: Record<string, unknown>) => {
    try { await runTool(tool, params); notify(`${label} ✓`); void load(); }
    catch (e) { notify(errMsg(e), "error"); }
  };

  const install = async () => {
    const r = (await window.adbstudio.agent.chooseApk(t("apps.install_apk"))) as { canceled: boolean; path?: string };
    if (r.canceled || !r.path) return;
    try {
      const res = (await runTool("app_install", { apk_path: r.path })) as unknown as { data: { newPackages: string[] } };
      notify(translate("toast.install_done", { pkgs: res.data.newPackages.join(", ") }));
      void load();
    } catch (e) { notify(errMsg(e), "error"); }
  };

  const targets = policy?.targetPackages ?? [];
  const list = apps?.user ?? [];
  const shown = filter ? list.filter((p) => p.includes(filter)) : list;

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card title={t("apps.targets")} icon={<Icon name="shield" className="h-4 w-4" />}
            right={<span className="text-[11px] text-[var(--color-ink-3)]">{t("apps.targets_hint")}</span>} className="xl:col-span-2">
        <Row className="items-end">
          <div className="min-w-56 flex-1">
            <span className="label">{t("apps.add_package")}</span>
            <TextInput value={pkg} onChange={setPkg} placeholder="com.example.app" className="mono" />
          </div>
          <Button kind="primary" disabled={!pkg || targets.includes(pkg)}
                  onClick={async () => { await setTargets([...targets, pkg]); setPkg(""); notify(t("common.ok")); }}>{t("apps.add")}</Button>
        </Row>

        <ul className="mt-3 space-y-1.5">
          {targets.map((target) => (
            <li key={target} className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-edge)] px-3 py-2">
              <span className="mono flex-1 text-[12px]">{target}</span>
              <Row>
                <Button size="sm" onClick={() => void act(t("apps.launch"), "app_launch", { package: target, reason: translate("reason.launch") })}>{t("apps.launch")}</Button>
                <Button size="sm" onClick={() => void act(t("apps.stop"), "app_stop", { package: target, reason: translate("reason.stop") })}>{t("apps.stop")}</Button>
                <Button size="sm" onClick={() => void act(t("apps.clear_data"), "app_clear_data", { package: target, reason: translate("reason.clear") })}>{t("apps.clear_data")}</Button>
                <Button kind="warn" size="sm" onClick={() => void act(t("apps.uninstall"), "app_uninstall", { package: target, reason: translate("reason.uninstall") })}>{t("apps.uninstall")}</Button>
                <Button kind="quiet" size="sm" title={t("apps.remove_target")}
                        onClick={async () => { await setTargets(targets.filter((x) => x !== target)); }}>✕</Button>
              </Row>
            </li>
          ))}
          {!targets.length && <Empty icon={<Icon name="phone" className="h-8 w-8" />}>{t("apps.targets_empty")}</Empty>}
        </ul>

        <Row className="mt-4">
          <Button kind="primary" onClick={() => void install()}>📦 {t("apps.install_apk")}</Button>
          <span className="self-center text-[11px] text-[var(--color-ink-3)]">{t("apps.install_hint")}</span>
        </Row>
      </Card>

      <Card title={t("apps.on_device")} icon={<Icon name="grid" className="h-4 w-4" />}>
        <Row>
          <Select value={scope} onChange={setScope} options={[{ value: "target", label: t("dash.targets") }, { value: "user", label: t("apps.user_apps") }]} />
          <div className="flex-1"><TextInput value={filter} onChange={setFilter} placeholder={t("apps.filter")} /></div>
          <Button kind="quiet" size="sm" onClick={() => void load()}>⟳</Button>
        </Row>
        <p className="mt-2 text-[11px] text-[var(--color-ink-3)]">{t("apps.user_count", { n: apps?.user.length ?? 0, s: apps?.system_count ?? 0 })}</p>
        <ul className="mt-2 max-h-[26rem] space-y-0.5 overflow-y-auto">
          {shown.map((p) => (
            <li key={p} className="flex items-center justify-between rounded-lg px-2 py-1 hover:bg-[var(--color-surface-3)]">
              <span className="mono truncate text-[11px]">{p}</span>
              {!targets.includes(p) && (
                <Button kind="quiet" size="sm" onClick={async () => { await setTargets([...targets, p]); }}>{t("apps.add_target")}</Button>
              )}
            </li>
          ))}
          {!!apps && !shown.length && <Empty>{t("apps.filter")} — {t("history.no_rows")}</Empty>}
          {!apps && <Empty>{listError ? `⚠ ${listError}` : t("common.loading")}</Empty>}
        </ul>
      </Card>
    </div>
  );
}
