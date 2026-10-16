import { translate } from "../i18n";

/** Minimal dependency-free chart: last N samples as an area+line sparkline. */
export function Sparkline({ values, max, min = 0, unit = "", height = 48, color = "#3b82f6" }: {
  values: number[]; max?: number; min?: number; unit?: string; height?: number; color?: string;
}) {
  const pts = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (pts.length < 2) {
    return <div className="flex items-end text-xs text-zinc-400" style={{ height }}>{translate("common.no_data")}</div>;
  }
  const hi = max ?? Math.max(...pts, 1);
  const lo = min ?? Math.min(...pts, 0);
  const span = hi - lo || 1;
  const W = 100;
  const step = W / (pts.length - 1);
  const y = (v: number) => height - 2 - ((v - lo) / span) * (height - 4);
  const line = pts.map((v, i) => `${(i * step).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 -2 ${W} ${height + 4}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      <polygon points={`0,${height} ${line} ${W},${height}`} fill={color} opacity="0.15" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
      <text x={W - 1} y="8" textAnchor="end" fill={color} fontSize="7">
        {typeof last === "number" ? `${last.toFixed(1)}${unit}` : ""}
      </text>
    </svg>
  );
}

export function StatBox({ label, value, sup, children }: { label: string; value: string; sup?: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}{sup && <span className="ml-1 text-xs font-normal text-[var(--color-ink-3)]">{sup}</span>}</div>
      {children}
    </div>
  );
}
