import { RISK_CLASS, RISK_LABEL, translate, useI18n } from "../i18n";
import { useEffect, useState } from "react";
import { Button, Card } from "./ui";
import type { ApprovalRequest } from "@shared/types";

const RISK_STYLE = RISK_CLASS;
const _unused: Record<string, string> = {
  low: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  medium: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  high: "bg-orange-200 text-orange-950 dark:bg-orange-900/50 dark:text-orange-100",
  critical: "bg-red-200 text-red-950 dark:bg-red-900/60 dark:text-red-100",
};

/**
 * Approval dialog. Approve is single-use: there is deliberately no
 * "remember this choice" checkbox for high/critical actions, and critical
 * actions additionally require typing the confirmation word + holding the button.
 */
export function ApprovalModal({ req, onApprove, onDeny }: {
  req: ApprovalRequest; onApprove: (id: string, typed?: string) => void; onDeny: (id: string) => void;
}) {
  const { t } = useI18n();
  const [typed, setTyped] = useState("");
  const [hold, setHold] = useState(0);
  const [left, setLeft] = useState(Math.max(0, Math.ceil((req.expiresAt - Date.now()) / 1000)));

  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((req.expiresAt - Date.now()) / 1000))), 500);
    return () => clearInterval(t);
  }, [req.expiresAt]);

  useEffect(() => {
    if (hold <= 0 || hold >= 100) return;
    const t = setTimeout(() => setHold((h) => h + 5), 100);
    return () => clearTimeout(t);
  }, [hold]);

  const critical = req.risk === "critical";
  const typedOk = !req.typedConfirm || typed === req.typedConfirm;
  const canApprove = typedOk && left > 0 && (!critical || hold >= 100);

  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="ap-title"
         className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-2xl dark:bg-zinc-900 dark:text-zinc-100">
        <div className="flex items-center justify-between">
          <h2 id="ap-title" className="text-lg font-semibold">คำขออนุมัติ</h2>
          <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase ${RISK_STYLE[req.risk]}`}>{RISK_LABEL[req.risk]}</span>
        </div>

        <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-zinc-500">{t("approval.requester")}</dt><dd>{req.requestedBy === "ai" ? `AI (${req.client ?? translate("approval.unknown_client")})` : t("approval.user")}</dd>
          <dt className="text-zinc-500">{t("approval.tool")}</dt><dd className="font-mono">{req.tool}</dd>
          <dt className="text-zinc-500">{t("approval.device")}</dt><dd className="font-mono">{req.device ?? translate("app.select_device")}</dd>
          <dt className="text-zinc-500">{t("approval.package")}</dt><dd className="font-mono">{req.package ?? "-"}</dd>
          <dt className="text-zinc-500">{t("approval.impact")}</dt><dd>{req.impact}</dd>
          <dt className="text-zinc-500">{t("approval.ai_reason")}</dt><dd>{req.reason ?? "—"}</dd>
          <dt className="text-zinc-500">{t("approval.params")}</dt>
          <dd><pre className="max-h-32 overflow-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-800">{JSON.stringify(req.params, null, 2)}</pre></dd>
        </dl>

        {req.typedConfirm && (
          <label className="mt-4 block text-sm">
            {t("approval.type_word", { word: req.typedConfirm })}
            <input value={typed} onChange={(e) => setTyped(e.target.value)}
                   className="input mt-1" autoFocus />
          </label>
        )}

        <p className="mt-3 text-xs text-zinc-500">{t("approval.once_ttl", { left })}</p>

        <div className="mt-4 flex justify-end gap-2">
          <Button kind="ghost" onClick={() => onDeny(req.id)} autoFocus={!req.typedConfirm}>{t("common.cancel")}</Button>
          {critical ? (
            <button disabled={!typedOk || left === 0}
                    onPointerDown={() => setHold(1)} onPointerUp={() => hold < 100 && setHold(0)} onPointerLeave={() => hold < 100 && setHold(0)}
                    onClick={() => canApprove && onApprove(req.id, typed)}
                    className="btn-danger relative overflow-hidden disabled:cursor-not-allowed disabled:opacity-40">
              <span className="absolute inset-y-0 left-0 bg-red-900/60" style={{ width: `${Math.min(hold, 100)}%` }} />
              <span className="relative">{hold >= 100 ? t("approval.click_approve") : t("approval.hold_approve")}</span>
            </button>
          ) : (
            <Button kind="primary" disabled={!canApprove} onClick={() => onApprove(req.id)}>{t("approval.approve_once")}</Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Stack of pending approvals, newest first — one modal per pending request. */
export function ApprovalStack({ requests, onApprove, onDeny }: {
  requests: ApprovalRequest[]; onApprove: (id: string, typed?: string) => void; onDeny: (id: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const first = requests[0];
  useEffect(() => { if (first && !requests.some((r) => r.id === open)) setOpen(first.id); }, [first, open, requests]);
  const req = requests.find((r) => r.id === open) ?? first;
  if (!req) return null;
  return (
    <>
      {requests.length > 1 && (
        <div className="fixed bottom-4 right-4 z-40">
          <Card className="!bg-amber-100 !text-amber-950 dark:!bg-amber-900/60 dark:!text-amber-100">
            มีอีก {requests.length - 1} คำขอที่รออนุมัติ
          </Card>
        </div>
      )}
      <ApprovalModal req={req} onApprove={(id, t) => onApprove(id, t)} onDeny={onDeny} />
    </>
  );
}

export const riskClass = RISK_CLASS;
