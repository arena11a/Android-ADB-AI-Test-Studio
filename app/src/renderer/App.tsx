import { useEffect, useMemo, useState } from "react";
import { I18nProvider, MODES, useI18n, type Lang } from "./i18n";
import { useStudio, type Page } from "./store";
import { DevicePicker } from "./components/Devices";
import { KillSwitch } from "./components/KillSwitch";
import { ApprovalStack } from "./components/ApprovalModal";
import { Button, Confirm, Icon, Modal, Pill, Select, TextInput } from "./components/ui";
import { Dashboard } from "./pages/Dashboard";
import { Apps } from "./pages/Apps";
import { Files } from "./pages/Files";
import { Logs } from "./pages/Logs";
import { Metrics } from "./pages/Metrics";
import { Live, Record } from "./pages/Live";

import { Sessions } from "./pages/Sessions";
import { Security } from "./pages/Security";
import { Bootloader } from "./pages/Bootloader";
import { History } from "./pages/History";
import { Settings } from "./pages/Settings";

const NAV: Array<{ id: Page; icon: string; group: "main" | "tools" }> = [
  { id: "dashboard", icon: "grid", group: "main" },
  { id: "apps", icon: "phone", group: "main" },
  { id: "live", icon: "monitor", group: "main" },
  { id: "record", icon: "video", group: "main" },
  { id: "logs", icon: "lines", group: "tools" },
  { id: "metrics", icon: "chart", group: "tools" },
  { id: "files", icon: "folder", group: "tools" },
  { id: "sessions", icon: "clock", group: "tools" },
  { id: "history", icon: "db", group: "tools" },
  { id: "security", icon: "shield", group: "tools" },
  { id: "bootloader", icon: "shield", group: "tools" },
  { id: "settings", icon: "gear", group: "tools" },
];

function Shell() {
  const { t, lang, setLang } = useI18n();
  const page = useStudio((s) => s.page);
  const setPage = useStudio((s) => s.setPage);
  const status = useStudio((s) => s.status);
  const aiClients = useStudio((s) => s.aiClients);
  const hello = useStudio((s) => s.hello);
  const policy = useStudio((s) => s.policy);
  const approvals = useStudio((s) => s.approvals);
  const decide = useStudio((s) => s.decide);
  const setMode = useStudio((s) => s.setMode);
  const toast = useStudio((s) => s.toast);
  const killSwitch = useStudio((s) => s.killSwitch);
  const refresh = useStudio((s) => s.refresh);
  const theme = useStudio((s) => s.theme);
  const setTheme = useStudio((s) => s.setTheme);

  const [killAsk, setKillAsk] = useState(false);
  // one-time safety notice; #firstrun=0 hides it (smoke captures / firstRun flag)
  const [firstRun, setFirstRun] = useState(() =>
    localStorage.getItem("adbstudio.firstRunSeen") !== "1" &&
    new URLSearchParams(location.hash.replace(/^#/, "")).get("firstrun") !== "0");
  const connected = status.controlConnected;
  const killActive = hello?.killSwitch ?? false;

  /* Ctrl+Shift+K = kill switch (documented emergency shortcut) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "K" || e.key === "k")) {
        e.preventDefault();
        killActive ? void killSwitch(false) : setKillAsk(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [killActive, killSwitch]);

  /* keep the html class in sync with the chosen theme */
  useEffect(() => { setTheme(theme); /* eslint-disable-line */ }, []);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { if (theme === "system") setTheme("system"); };
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme, setTheme]);

  const groups = useMemo(() => ({
    main: NAV.filter((n) => n.group === "main"),
    tools: NAV.filter((n) => n.group === "tools"),
  }), []);

  return (
    <div className="flex h-full flex-col">
      <header className="z-20 flex shrink-0 items-center gap-2.5 border-b border-[var(--color-edge)] bg-[var(--color-surface)]/90 px-4 py-2.5 backdrop-blur">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--color-brand)] text-white"><Icon name="shield" className="h-4 w-4" /></span>
        <b className="text-[13px] tracking-tight">{t("app.title")}</b>

        <Pill tone={connected ? "ok" : "bad"}>
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`} />
          {connected ? t("app.agent_connected") : t("app.agent_down")}
        </Pill>

        <Pill tone={aiClients > 0 ? "ok" : "neutral"}
              title={aiClients > 0 ? t("app.ai_connected", { n: aiClients }) : t("app.ai_disconnected")}>
          <span className={`h-1.5 w-1.5 rounded-full ${aiClients > 0 ? "bg-emerald-500" : "bg-zinc-400"}`} />
          {aiClients > 0 ? `${t("app.ai_label")} ×${aiClients}` : t("app.ai_label")}
        </Pill>

        <div className="ml-auto flex items-center gap-2">
          <select value={policy?.mode ?? "safe"} disabled={killActive} title={policy ? t(`mode.${policy.mode}`) : ""}
                  onChange={(e) => void setMode(e.target.value as typeof MODES[number])}
                  className="input !w-auto !py-1 text-xs disabled:opacity-50">
            {MODES.map((m) => <option key={m} value={m}>{t(`mode.short.${m}`)}</option>)}
          </select>

          {approvals.length > 0 && <Pill tone="warn">{t("app.pending_approvals", { n: approvals.length })}</Pill>}

          <Select value={lang} onChange={(l) => setLang(l as Lang)} className="!w-auto !py-1 text-xs"
                  options={[{ value: "th", label: "TH" }, { value: "en", label: "EN" }]} />
          <Select value={theme} onChange={setTheme} className="!w-auto !py-1 text-xs"
                  options={[
                    { value: "system", label: `◐ ${t("app.theme.system")}` },
                    { value: "light", label: `☀ ${t("app.theme.light")}` },
                    { value: "dark", label: `☾ ${t("app.theme.dark")}` },
                  ]} />

          <DevicePicker />
          <KillSwitch active={killActive} onAsk={() => setKillAsk(true)} />
          <Button kind="quiet" size="sm" title={t("app.restart_agent")} onClick={() => void window.adbstudio.agent.restart()}>⟳</Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="w-48 shrink-0 overflow-y-auto border-r border-[var(--color-edge)] bg-[var(--color-surface)] p-2.5">
          {(["main", "tools"] as const).map((g) => (
            <div key={g} className="mb-3">
              <p className="mb-1 px-2 text-[10px] font-bold uppercase tracking-widest text-[var(--color-ink-3)]">
                {g === "main" ? t("nav.group_main") : t("nav.group_tools")}
              </p>
              {groups[g].map((n) => (
                <button key={n.id} onClick={() => setPage(n.id)}
                        className={`nav-item mb-0.5 w-full ${page === n.id ? "nav-item-on" : "nav-item-off"}`}>
                  <Icon name={n.icon} className="h-4 w-4 opacity-80" />
                  <span className="truncate">{t(`nav.${n.id}`)}</span>
                </button>
              ))}
            </div>
          ))}

          {policy && (
            <div className="mt-2 rounded-xl bg-[var(--color-surface-2)] p-2.5 text-[11px] leading-relaxed text-[var(--color-ink-2)] dark:bg-[var(--color-surface-3)]">
              <p className="mb-1 font-semibold text-[var(--color-ink)]">{t(`mode.short.${policy.mode}`)}</p>
              {policy.targetPackages.length
                ? <p className="mono break-all">targets: {policy.targetPackages.join(", ")}</p>
                : <p className="text-amber-600 dark:text-amber-400">{t("dash.targets_none")}</p>}
              <p className="mt-1 opacity-70">{t("set.role")}: {t(`role.${policy.role}`)}</p>
            </div>
          )}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto p-4">
          {!connected && (
            <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-[13px] text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-100">
              <Icon name="phone" className="h-5 w-5" />
              <span className="flex-1">{t("app.banner.disconnected")}</span>
              <Button kind="ghost" size="sm" onClick={() => void window.adbstudio.agent.restart()}>{t("app.restart_agent")}</Button>
            </div>
          )}
          {killActive && (
            <div className="mb-4 flex items-center gap-3 rounded-xl border-2 border-red-500 bg-red-50 p-3 text-[13px] font-medium text-red-900 dark:bg-red-950/50 dark:text-red-100">
              <Icon name="shield" className="h-5 w-5" />
              {t("dash.kill_switch_active")}
              <Button kind="danger" size="sm" className="ml-auto" onClick={() => void killSwitch(false)}>{t("app.kill_switch_release")}</Button>
            </div>
          )}

          {page === "dashboard" && <Dashboard />}
          {page === "apps" && <Apps />}
          {page === "files" && <Files />}
          {page === "logs" && <Logs />}
          {page === "metrics" && <Metrics />}
          {page === "live" && <Live />}
          {page === "record" && <Record />}
          {page === "sessions" && <Sessions />}
          {page === "history" && <History />}
          {page === "security" && <Security />}

          {page === "bootloader" && <Bootloader />}
          {page === "settings" && <Settings onRefresh={refresh} />}
        </main>
      </div>

      {toast && (
        <div role="status" className={`rise fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-xl px-4 py-2 text-[13px] shadow-xl ${
          toast.kind === "error" ? "bg-red-600 text-white" : toast.kind === "warn" ? "bg-amber-500 text-white" : "bg-[var(--color-ink)] text-[var(--color-surface)]"
        }`}>{toast.text}</div>
      )}

      <ApprovalStack requests={approvals} onApprove={(id, typed) => void decide(id, "approve", typed)} onDeny={(id) => void decide(id, "deny")} />
      <WordDialog />

      {killAsk && (
        <Confirm title={t("app.kill_switch")} confirmLabel={t("app.kill_switch")} danger
                 onCancel={() => setKillAsk(false)}
                 onConfirm={() => { setKillAsk(false); void killSwitch(true); }}
                 body={<p className="text-[13px] leading-relaxed">{t("app.kill_body")}</p>} />
      )}

      {firstRun && (
        <Modal title={t("app.title")} onClose={() => { localStorage.setItem("adbstudio.firstRunSeen", "1"); setFirstRun(false); }}
               footer={<Button kind="primary" onClick={() => { localStorage.setItem("adbstudio.firstRunSeen", "1"); setFirstRun(false); }}>{t("common.ok")}</Button>}>
          <div className="flex gap-3">
            <Icon name="shield" className="h-8 w-8 shrink-0 text-[var(--color-brand)]" />
            <p className="text-[13px] leading-relaxed">{t("app.banner.first_run")}</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** In-app typed confirmation for the advanced modes (no browser prompt). */
function WordDialog() {
  const { t } = useI18n();
  const prompt = useStudio((s) => s.wordPrompt);
  const confirmMode = useStudio((s) => s.confirmMode);
  const cancel = useStudio((s) => s.cancelModePrompt);
  const [value, setValue] = useState("");
  if (!prompt) return null;
  return (
    <Modal title={t("prompt.word_title", { mode: prompt.mode, word: prompt.word })} onClose={cancel}
           footer={<>
             <Button kind="ghost" onClick={cancel}>{t("common.cancel")}</Button>
             <Button kind={prompt.mode === "bootloader" ? "danger" : "primary"} onClick={() => void confirmMode(value)}>{t("prompt.enter")}</Button>
           </>}>
      <p className="text-[13px] leading-relaxed">{t("prompt.word_hint")}</p>
      <TextInput value={value} onChange={setValue} placeholder={prompt.word} className="mono mt-3" />
      {prompt.error && <p className="mt-2 text-[12px] text-red-600 dark:text-red-400">{prompt.error}</p>}
      {prompt.mode === "bootloader" && <p className="mt-2 text-[12px] text-amber-600 dark:text-amber-400">{t("boot.warn_body")}</p>}
    </Modal>
  );
}

export function App() {
  return <I18nProvider><Shell /></I18nProvider>;
}
