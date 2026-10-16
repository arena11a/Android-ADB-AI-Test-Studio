import type { ComponentProps, ReactNode } from "react";
import { useI18n } from "../i18n";

/* ---------- card ------------------------------------------------------- */
export function Card({ title, icon, right, children, className = "", bodyClass = "" }:
  { title?: string; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={`card rise ${className}`}>
      {title !== undefined && (
        <header className="card-h">
          {icon && <span className="text-[var(--color-ink-3)]">{icon}</span>}
          <h2 className="flex-1 truncate">{title}</h2>
          {right}
        </header>
      )}
      <div className={`card-b ${bodyClass}`}>{children}</div>
    </section>
  );
}

/* ---------- controls --------------------------------------------------- */
export function Button({ kind = "ghost", size, children, ...rest }:
  { kind?: "primary" | "danger" | "ghost" | "warn" | "quiet"; size?: "sm" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = { primary: "btn-primary", danger: "btn-danger", ghost: "btn-ghost", warn: "btn-warn", quiet: "btn-quiet" }[kind];
  return <button {...rest} className={`${cls} ${size === "sm" ? "btn-sm" : ""} ${rest.className ?? ""}`}>{children}</button>;
}

export function Select<T extends string>({ value, onChange, options, className = "" }:
  { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} className={`input ${className}`}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function TextInput({ value, onChange, placeholder, className = "", ...rest }:
  { value: string; onChange: (v: string) => void; placeholder?: string; className?: string } &
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return <input {...rest} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={`input ${className}`} />;
}

export function Toggle({ checked, onChange, label, hint }:
  { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--color-edge)] p-2.5 transition-colors hover:border-[var(--color-brand)]/40">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
             className="mt-0.5 h-4 w-4 rounded border-[var(--color-edge)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]" />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{label}</span>
        {hint && <span className="block text-[11px] leading-snug text-[var(--color-ink-3)]">{hint}</span>}
      </span>
    </label>
  );
}

/* ---------- feedback --------------------------------------------------- */
export function Pill({ children, tone = "neutral", className = "", ...rest }:
  { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "bad" | "info"; className?: string } & Omit<ComponentProps<"span">, "children" | "className" | "tone">) {
  const tones = {
    neutral: "bg-[var(--color-surface-3)] text-[var(--color-ink-2)]",
    ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
    warn: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
    bad: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-100",
    info: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-100",
  };
  return <span className={`pill ${tones[tone]} ${className}`.trim()} {...rest}>{children}</span>;
}

export function Empty({ icon, children, className = "" }: { icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--color-edge)] p-8 text-center ${className}`}>
      {icon && <div className="text-2xl opacity-40">{icon}</div>}
      <p className="max-w-sm text-[13px] leading-relaxed text-[var(--color-ink-3)]">{children}</p>
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="skel h-8" style={{ width: `${100 - i * 8}%` }} />)}
    </div>
  );
}

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
           className="card rise w-full max-w-md shadow-2xl">
        <header className="card-h"><h2 className="flex-1">{title}</h2></header>
        <div className="card-b">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-[var(--color-edge)] p-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Confirm({ title, body, confirmLabel, onConfirm, onCancel, danger = true }:
  { title: string; body: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void; danger?: boolean }) {
  const { t } = useI18n();
  return (
    <Modal title={title} onClose={onCancel}
           footer={<>
             <Button kind="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
             <Button kind={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
           </>}>
      {body}
    </Modal>
  );
}

/* ---------- data display ---------------------------------------------- */
export function KeyVal({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(6.5rem,auto)_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="col-span-2 grid grid-cols-subgrid items-baseline">
          <dt className="text-[var(--color-ink-3)]">{k}</dt>
          <dd className="min-w-0 font-medium break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Row({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-2 ${className}`}>{children}</div>;
}

export function Icon({ name, className = "" }: { name: string; className?: string }) {
  const common = { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "phone": return <svg {...common}><rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M10 18.5h4" /></svg>;
    case "grid": return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>;
    case "folder": return <svg {...common}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>;
    case "lines": return <svg {...common}><path d="M4 6h16M4 12h16M4 18h10" /></svg>;
    case "chart": return <svg {...common}><path d="M4 19V5M4 19h16M8 15l3.5-4 3 2.5L20 8" /></svg>;
    case "monitor": return <svg {...common}><rect x="2.5" y="4" width="19" height="13" rx="2" /><path d="M9 20.5h6M12 17v3.5" /></svg>;
    case "video": return <svg {...common}><rect x="2.5" y="6" width="13" height="12" rx="2" /><path d="M16 10.5l5-3v9l-5-3Z" /></svg>;
    case "clock": return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>;
    case "db": return <svg {...common}><ellipse cx="12" cy="6" rx="7.5" ry="3" /><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" /></svg>;
    case "gear": return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M12 2.5v2.2M12 19.3v2.2M4.2 7.2l1.9 1.1M17.9 15.7l1.9 1.1M19.8 7.2l-1.9 1.1M6.1 15.7l-1.9 1.1" /></svg>;
    case "shield": return <svg {...common}><path d="M12 3l7.5 3v6c0 4.6-3.2 7.9-7.5 9-4.3-1.1-7.5-4.4-7.5-9V6Z" /></svg>;
    default: return null;
  }
}
