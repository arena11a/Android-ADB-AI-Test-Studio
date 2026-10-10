import { useEffect, useMemo, useState } from "react";
import { Button, Card, Empty, Icon, KeyVal, Pill, Row, Select, TextInput } from "../components/ui";
import { errMsg, useStudio } from "../store";
import { useI18n } from "../i18n";
import type { StudioApi } from "@shared/types";

/** typed-confirmation steps, matching the schemas of the tools they guard */
const CONFIRM = {
  unlock: "WIPE-ALL-DATA",
  sideload: "SIDELOAD",
  flash: "FLASH",
  lock: "RE-LOCK",
  erase: "ERASE",
} as const;

/** action id → i18n key, so the dropdown follows the selected language */
const ACTIONS: Array<[string, string]> = [
  ["reboot_bootloader", "act.reboot_bootloader"],
  ["reboot_recovery", "act.reboot_recovery"],
  ["set_active_a", "act.set_active_a"],
  ["set_active_b", "act.set_active_b"],
  ["flashing_unlock", "act.flashing_unlock"],
  ["flashing_lock", "act.flashing_lock"],
  ["flash_boot", "act.flash_boot"],
  ["flash_init_boot", "act.flash_init_boot"],
  ["flash_recovery", "act.flash_recovery"],
  ["flash_vendor_boot", "act.flash_vendor_boot"],
  ["flash_dtbo", "act.flash_dtbo"],
  ["flash_vbmeta", "act.flash_vbmeta"],
  ["flash_modem", "act.flash_modem"],
  ["erase_userdata", "act.erase_userdata"],
  ["erase_cache", "act.erase_cache"],
  ["erase_metadata", "act.erase_metadata"],
];

/** what each action needs typed, for the confirmation field */
const CONFIRM_WORD: Record<string, string> = {
  flashing_unlock: CONFIRM.unlock, flash_boot: CONFIRM.flash, flash_init_boot: CONFIRM.flash,
  flash_recovery: CONFIRM.flash, flash_vendor_boot: CONFIRM.flash, flash_dtbo: CONFIRM.flash,
  flash_vbmeta: CONFIRM.flash, flash_modem: CONFIRM.flash, flashing_lock: CONFIRM.lock,
  erase_userdata: CONFIRM.erase, erase_cache: CONFIRM.erase, erase_metadata: CONFIRM.erase,
};

const NEEDS_IMAGE = new Set(["flash_boot", "flash_init_boot", "flash_recovery", "flash_vendor_boot", "flash_dtbo", "flash_vbmeta", "flash_modem"]);

export function Bootloader() {
  const { t } = useI18n();
  const policy = useStudio((s) => s.policy);
  const hello = useStudio((s) => s.hello);
  const call = useStudio((s) => s.call);
  const setMode = useStudio((s) => s.setMode);
  const notify = useStudio((s) => s.notify);

  const [action, setAction] = useState<string>("reboot_bootloader");
  const [image, setImage] = useState("");
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const inMode = policy?.mode === "bootloader";
  const feature = policy?.features.bootloader ?? false;
  const locked = !inMode || !!hello?.killSwitch;
  const picked = action && action !== "__none";
  const needsWord = !!CONFIRM_WORD[action];
  const needsImage = NEEDS_IMAGE.has(action);
  const canRun = !locked && !busy && picked && (!needsWord || word === CONFIRM_WORD[action]) && (!needsImage || !!image);

  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    const push = (line: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 60));
    try {
      const r = (await call("tool/call", {
        tool: toolFor(action),
        params: {
          reason: "bootloader page",
          ...(action === "reboot_bootloader" ? { target: "bootloader" } : {}),
          ...(action === "reboot_recovery" ? { target: "recovery" } : {}),
          ...(action === "set_active_a" ? { slot: "a" } : {}),
          ...(action === "set_active_b" ? { slot: "b" } : {}),
          ...(action === "flashing_unlock" ? { expect: CONFIRM.unlock } : {}),
          ...(action === "flashing_lock" ? { expect: CONFIRM.lock } : {}),
          ...(action?.startsWith("flash_") ? { partition: action.slice(6), image, expect: CONFIRM.flash } : {}),
          ...(action?.startsWith("erase_") ? { partition: action.slice(6), expect: CONFIRM.erase } : {}),
        },
      })) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
      if (r.ok) { push(`✓ ${t("common.ok")} — ${JSON.stringify(r.data ?? {})}`); notify(`${t("common.ok")} ✓`); }
      else push(`✗ ${r.error?.code}: ${r.error?.message}`), notify(`${r.error?.code}: ${r.error?.message}`, "error");
    } catch (e) { push(`✗ ${errMsg(e)}`); notify(errMsg(e), "error"); }
    finally { setBusy(false); setWord(""); }
  };

  const toolFor = (a: string) =>
    a === "reboot_bootloader" || a === "reboot_recovery" ? "boot_reboot_target"
    : a === "set_active_a" || a === "set_active_b" ? "fastboot_set_active"
    : a === "flashing_unlock" ? "fastboot_unlock"
    : a === "flashing_lock" ? "fastboot_lock"
    : a?.startsWith("flash_") ? "fastboot_flash"
    : a?.startsWith("erase_") ? "fastboot_erase"
    : "boot_reboot_target";

  const imageName = useMemo(() => image.split("/").pop() || "", [image]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={t("boot.warn_title")} icon={<Icon name="shield" className="h-4 w-4" />}
            right={<Pill tone={inMode ? "bad" : "neutral"}>{inMode ? t("mode.bootloader") : t("live.not_running")}</Pill>}>
        <div className="flex gap-3 rounded-xl border border-red-300 bg-red-50 p-3 text-[12px] leading-relaxed text-red-900 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-100">
          <Icon name="shield" className="mt-0.5 h-5 w-5 shrink-0" />
          <p>{t("boot.warn_body")}</p>
        </div>
        {!feature && <p className="mt-3 text-[12px] text-amber-600 dark:text-amber-400">⚠ {t("sec.warn_off", { feat: t("set.bootloader") })} → {t("nav.settings")}</p>}
        <Row className="mt-4">
          {inMode
            ? <Button kind="ghost" onClick={() => void setMode("safe" as never)}>{t("set.safe_mode")}</Button>
            : <Button kind="danger" disabled={!feature} onClick={() => void setMode("bootloader" as never)}>{t("boot.enter_word")}</Button>}
        </Row>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink-3)]">{t("boot.human_only")}</p>
      </Card>

      <Card title={t("boot.actions")} icon={<Icon name="monitor" className="h-4 w-4" />}>
        <span className="label">{t("boot.action")}</span>
        <Select value={action} onChange={(v) => { setAction(v); setWord(""); }}
                  options={[{ value: "__none", label: `— ${t("act.choose")} —` }, ...ACTIONS.map(([v, k]) => ({ value: v, label: t(k) }))]} />

        {needsImage && (
          <div className="mt-3">
            <span className="label">{t("boot.image_path")}</span>
            <Row>
              <div className="min-w-48 flex-1"><TextInput value={image} onChange={setImage} placeholder="/home/you/Downloads/boot.img" className="mono" /></div>
              <Button kind="ghost" onClick={async () => {
                const r = (await window.adbstudio.agent.chooseLocalFile(t("boot.image_path"))) as { canceled: boolean; path?: string };
                if (!r.canceled && r.path) setImage(r.path);
              }}>…</Button>
            </Row>
            {image && <p className="mono mt-1 text-[11px] text-[var(--color-ink-3)]">{imageName}</p>}
          </div>
        )}

        {needsWord && (
          <div className="mt-3">
            <span className="label">{t("boot.word")}: {CONFIRM_WORD[action]}</span>
            <TextInput value={word} onChange={setWord} placeholder={CONFIRM_WORD[action]} className="mono" />
          </div>
        )}

        <Row className="mt-4">
          <Button kind={needsWord ? "danger" : "warn"} disabled={!canRun} onClick={() => void run()}>
            {busy ? `⏳ ${t("boot.running")}` : `▶ ${t("boot.run")}`}
          </Button>
          {(needsWord || action?.startsWith("erase_")) && (
            <span className="text-[11px] text-red-600 dark:text-red-400">{t("boot.data_loss_warn")}</span>
          )}
        </Row>
      </Card>

      <Card title={t("boot.status")} className="lg:col-span-2">
        <KeyVal rows={[
          [t("app.mode"), <b>{policy?.mode ?? "-"}</b>],
          [t("set.bootloader"), <Pill tone={feature ? "ok" : "neutral"}>{feature ? t("common.yes") : t("common.no")}</Pill>],
          [t("dash.kill_switch"), hello?.killSwitch ? t("dash.kill_switch_active") : t("dash.kill_switch_off")],
        ]} />
        <div className="mt-3 flex gap-2">
          <Button kind="ghost" size="sm" disabled={locked} onClick={() => void call("tool/call", { tool: "fastboot_info", params: { reason: "bootloader page", sub: "devices" } })
            .then((r: { ok: boolean; data?: { devices: string }; error?: { message: string } }) => setLog((l) => [`${t("boot.devices")}: ${r.ok ? r.data?.devices || "—" : r.error?.message}`, ...l].slice(0, 60)))}>
            {t("boot.devices")}
          </Button>
          <Button kind="ghost" size="sm" disabled={locked} onClick={() => void call("tool/call", { tool: "fastboot_info", params: { reason: "bootloader page", sub: "getvar_current_slot" } })
            .then((r: { ok: boolean; data?: { current_slot: string }; error?: { message: string } }) => setLog((l) => [`${t("boot.slot")}: ${r.ok ? r.data?.current_slot : r.error?.message}`, ...l].slice(0, 60)))}>
            {t("boot.slot")}
          </Button>
        </div>

        <h3 className="mt-4 text-[11px] font-bold uppercase tracking-wide text-[var(--color-ink-3)]">{t("boot.log")}</h3>
        {log.length ? (
          <ul className="mono mt-1 max-h-52 space-y-1 overflow-y-auto rounded-xl bg-[var(--color-surface-2)] p-2.5 text-[11px] dark:bg-[#060b16]">
            {log.map((l, i) => <li key={i} className="break-all">{l}</li>)}
          </ul>
        ) : <Empty className="mt-2">{t("boot.log_empty")}</Empty>}
      </Card>
    </div>
  );
}
