import { useEffect, useState } from "react";
import { Button, Card, Empty, Icon, KeyVal, Pill, Row, Select, TextInput, Toggle } from "../components/ui";
import { errMsg, useStudio } from "../store";
import { useI18n } from "../i18n";

export function Live() {
  const { t } = useI18n();
  const policy = useStudio((s) => s.policy);
  const media = useStudio((s) => s.media);
  const scrcpyStart = useStudio((s) => s.scrcpyStart);
  const scrcpyStop = useStudio((s) => s.scrcpyStop);
  const setPage = useStudio((s) => s.setPage);
  const call = useStudio((s) => s.call);
  const notify = useStudio((s) => s.notify);

  const [maxSize, setMaxSize] = useState("1024");
  const [stayAwake, setStayAwake] = useState(true);
  const [screenOff, setScreenOff] = useState(false);
  const [showTouches, setShowTouches] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void call("scrcpy/status").catch(() => undefined); }, [call]);
  useEffect(() => { if (media.scrcpy.running) setBusy(false); }, [media.scrcpy.running]);

  const enabled = policy?.features.liveView ?? false;
  const running = media.scrcpy.running;

  const start = async () => {
    setBusy(true);
    await scrcpyStart({
      maxSize: Number(maxSize) || undefined,
      stayAwake, turnScreenOff: screenOff, showTouches,
      windowTitle: "ADB AI Test Studio — live",
    });
    setBusy(false);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={t("live.title")} icon={<Icon name="monitor" className="h-4 w-4" />}
            right={<Pill tone={running ? "ok" : "neutral"}>{running ? t("live.running", { s: media.scrcpy.seconds ?? 0 }) : t("live.not_running")}</Pill>}>
        <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">{t("live.hint")}</p>

        {!enabled ? (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-[12px] text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-100">
            <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1">{t("live.disabled")}</span>
            <Button kind="ghost" size="sm" onClick={() => setPage("settings")}>{t("nav.settings")}</Button>
          </div>
        ) : running ? (
          <Row className="mt-4">
            <Button kind="danger" onClick={() => void scrcpyStop()}>⏹ {t("live.stop")}</Button>
            {media.scrcpy.serial && <span className="mono text-[11px] text-[var(--color-ink-3)]">{media.scrcpy.serial}</span>}
          </Row>
        ) : (
          <Row className="mt-4">
            <Button kind="primary" disabled={busy} onClick={() => void start()}>▶ {t("live.start")}</Button>
            {media.scrcpy.serial && <span className="mono text-[11px] text-[var(--color-ink-3)]">{media.scrcpy.serial}</span>}
          </Row>
        )}
      </Card>

      <Card title={t("live.options")}>
        <div className="grid gap-3">
          <div>
            <span className="label">{t("live.max_size")}</span>
            <TextInput value={maxSize} onChange={setMaxSize} className="mono" />
          </div>
          <Toggle checked={stayAwake} onChange={setStayAwake} label={t("live.stay_awake")} />
          <Toggle checked={screenOff} onChange={setScreenOff} label={t("live.screen_off")} />
          <Toggle checked={showTouches} onChange={setShowTouches} label={t("live.show_touches")} />
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-3)]">{t("live.no_audio")} · scrcpy = 60fps, latency ต่ำ, รองรับ Ctrl+Shift+O ปิดหน้าจอเครื่อง</p>
      </Card>

      <Card title={t("nav.record")} icon={<Icon name="video" className="h-4 w-4" />} className="lg:col-span-2">
        <Row>
          <span className="text-[13px] text-[var(--color-ink-2)]">{t("rec.hint", { n: 180 })}</span>
          <Button kind="ghost" size="sm" className="ml-auto" onClick={() => setPage("record")}>{t("nav.record")}</Button>
        </Row>
      </Card>
    </div>
  );
}

export function Record() {
  const { t } = useI18n();
  const policy = useStudio((s) => s.policy);
  const media = useStudio((s) => s.media);
  const recordStart = useStudio((s) => s.recordStart);
  const recordStop = useStudio((s) => s.recordStop);
  const call = useStudio((s) => s.call);
  const notify = useStudio((s) => s.notify);

  const [seconds, setSeconds] = useState("180");
  const [last, setLast] = useState<{ localPath: string; size: number; seconds: number } | null>(null);

  useEffect(() => { void call("record/status").catch(() => undefined); }, [call]);

  const enabled = policy?.privacy.recordVideo ?? false;
  const running = media.record.running;
  const elapsed = media.record.seconds ?? 0;

  const stop = async () => {
    const r = (await call("record/stop")) as { localPath: string; size: number; seconds: number };
    setLast(r);
    notify(t("rec.saved", { p: r.localPath }));
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={t("rec.title")} icon={<Icon name="video" className="h-4 w-4" />}
            right={<Pill tone={running ? "bad" : "neutral"}>{running ? `● REC ${elapsed}s` : t("live.not_running")}</Pill>}>
        <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">{t("rec.hint", { n: 180 })}</p>

        {!enabled ? (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-[12px] text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-100">
            <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0" />
            {t("rec.disabled")}
          </div>
        ) : running ? (
          <Row className="mt-4">
            <Button kind="danger" onClick={() => void stop().catch((e) => notify(errMsg(e), "error"))}>⏹ {t("rec.stop")}</Button>
            <span className="text-[13px] tabular-nums text-red-600 dark:text-red-400">{t("rec.recording", { s: elapsed })}</span>
          </Row>
        ) : (
          <>
            <div className="mt-4 max-w-48">
              <span className="label">{t("rec.seconds")}</span>
              <TextInput value={seconds} onChange={setSeconds} className="mono" />
            </div>
            <Row className="mt-3">
              <Button kind="primary" onClick={() => void recordStart(Math.max(1, Math.min(180, Number(seconds) || 180)))}>● {t("rec.start")}</Button>
            </Row>
          </>
        )}
      </Card>

      <Card title={t("rec.open")}>
        {last ? (
          <>
            <KeyVal rows={[
              [t("files.download_dir"), <span className="mono break-all">{last.localPath}</span>],
              [t("sess.col_steps"), `${last.seconds}s`],
              ["size", `${(last.size / 1048576).toFixed(1)} MB`],
            ]} />
            <Row className="mt-3">
              <Button kind="primary" onClick={() => void window.adbstudio.agent.openPath(last.localPath)}>{t("rec.open")}</Button>
              <Button kind="ghost" onClick={() => void window.adbstudio.agent.openPath(last.localPath.replace(/\/[^/]+$/, ""))}>{t("rec.open_folder")}</Button>
            </Row>
          </>
        ) : <Empty icon={<Icon name="video" className="h-8 w-8" />}>{t("sess.history_empty")}</Empty>}
      </Card>
    </div>
  );
}
