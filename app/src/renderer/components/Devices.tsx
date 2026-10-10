import { Button, Select } from "./ui";
import { useStudio } from "../store";
import { translate, useI18n } from "../i18n";
import type { DeviceInfo } from "@shared/types";

/** Device picker + refresh. Empty list = "no device", which most tools will refuse. */
export function DevicePicker() {
  const { t } = useI18n();
  const devices = useStudio((s) => s.devices);
  const selected = useStudio((s) => s.selected);
  const select = useStudio((s) => s.selectDevice);
  const refresh = useStudio((s) => s.refresh);

  const online = devices.filter((d) => d.state === "online");
  return (
    <div className="flex items-center gap-2">
      <Select
        value={selected ?? ""}
        onChange={(v) => select(v || null)}
        options={[
          { value: "", label: devices.length ? `— ${t("app.select_device")} —` : `— ${t("app.no_device")} —` },
          ...devices.map((d) => ({
            value: d.serial,
            label: `${d.model ?? d.serial} · ${d.state}${d.transport === "wifi" ? " · Wi-Fi" : ""}`,
          })),
        ]}
      />
      <span className={`h-2 w-2 rounded-full ${online.length ? "bg-emerald-500" : "bg-zinc-400"}`} title={online.length ? t("dash.status") : t("app.no_device")} />
      <Button kind="ghost" onClick={() => void refresh()} title={t("app.refresh_devices")}>⟳</Button>
    </div>
  );
}

export function DeviceFacts({ d }: { d: DeviceInfo }) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
      {([
        ["dev.model", d.model ?? "-"],
        ["dev.manufacturer", d.manufacturer ?? "-"],
        ["dev.android", d.androidVersion ? `${d.androidVersion} (SDK ${d.sdk ?? "?"})` : "-"],
        ["dev.serial", d.serial],
        ["dev.transport", d.transport === "wifi" ? `Wi-Fi${d.ip ? ` (${d.ip})` : ""}` : "USB"],
        ["dev.battery", d.batteryPct !== undefined ? `${d.batteryPct}%` : "-"],
        ["dev.state", d.state],
        ["dev.controlled", d.controlledBySession ?? "-"],
      ] as Array<[string, string]>).map(([k, v]) => (
        <div key={k}>
          <div className="text-xs text-[var(--color-ink-3)]">{t(k)}</div>
          <div className="truncate font-medium" title={v}>{v}</div>
        </div>
      ))}
    </div>
  );
}
