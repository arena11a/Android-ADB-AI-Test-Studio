import { translate, useI18n } from "../i18n";
import { Button } from "./ui";

/**
 * The emergency stop. Once engaged, every new request is rejected and only this
 * button (or Ctrl+Shift+K) can release it — there is no AI tool that does.
 */
export function KillSwitch({ active, onAsk }: { active: boolean; onAsk: () => void }) {
  const { t } = useI18n();
  if (active) {
    return (
      <Button kind="danger" className="ks-active gap-2" onClick={onAsk} title="Ctrl+Shift+K">
        ⏻ {t("app.kill_switch_release")}
      </Button>
    );
  }
  return (
    <Button kind="danger" gap-2 className="" onClick={onAsk} title="Ctrl+Shift+K">
      ⏻ {t("app.kill_switch")}
    </Button>
  );
}
