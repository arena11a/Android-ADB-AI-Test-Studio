import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { redact } from "../audit.js";
import type { Session } from "./session.js";
import type { MetricSample } from "./metrics.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type ReportLang = "th" | "en";

export interface ReportInput {
  session: Session; metrics?: MetricSample[]; importantLogs?: string[]; aiSummary?: string;
  device?: { model?: string; androidVersion?: string };
  /** report language (defaults to Thai) */
  lang?: ReportLang;
}

/** Static report labels — data values (names, steps) are never translated here. */
const L = {
  th: {
    htmlLang: "th", title: "รายงานทดสอบ", startEnd: "เริ่ม / สิ้นสุด", device: "อุปกรณ์", app: "แอป",
    steps: "ขั้นตอน", ok: "สำเร็จ", failed: "ล้มเหลว", blocked: "ถูกบล็อก", approved: "อนุมัติ", denied: "ปฏิเสธ",
    crashes: "แครช / ANR", aiSummary: "สรุปจาก AI", metrics: "เมตริก", cpu: "CPU ระบบ", ram: "RAM แอป",
    noData: "ไม่มีข้อมูล", none: "ไม่พบ", params: "พารามิเตอร์", reason: "เหตุผล", result: "ผล", shot: "ภาพ",
    importantLogs: "ล็อกสำคัญ", time: "เวลา", crash: "แครช", anr: "ANR",
    stepsRow: "ขั้นตอน", okCount: "สำเร็จ", failedCount: "ล้มเหลว", blockedCount: "บล็อก",
    approvedCount: "อนุมัติ", deniedCount: "ปฏิเสธ",
  },
  en: {
    htmlLang: "en", title: "Test report", startEnd: "Start / end", device: "Device", app: "App",
    steps: "Steps", ok: "ok", failed: "failed", blocked: "blocked", approved: "Approved", denied: "Denied",
    crashes: "Crashes / ANR", aiSummary: "AI summary", metrics: "Metrics", cpu: "System CPU", ram: "App RAM",
    noData: "no data", none: "none found", params: "Parameters", reason: "Reason", result: "Result", shot: "Screenshot",
    importantLogs: "Important logs", time: "Time", crash: "Crash", anr: "ANR",
    stepsRow: "Steps", okCount: "ok", failedCount: "failed", blockedCount: "blocked",
    approvedCount: "approved", deniedCount: "denied",
  },
} as const;

function labels(i: ReportInput) { return L[i.lang === "en" ? "en" : "th"]; }

export function summarize(i: ReportInput) {
  const st = i.session.steps;
  return {
    name: i.session.name, started: i.session.startedAt, ended: i.session.endedAt, stop_reason: i.session.stopReason,
    device: { serial: i.session.device, ...i.device }, package: i.session.package, app_version: i.session.appVersion,
    steps: st.length, success: st.filter((s) => s.result === "success").length, failed: st.filter((s) => s.result === "failed").length,
    blocked: st.filter((s) => s.result === "blocked" || s.result === "denied").length, approvals: i.session.approvals,
    crashes: i.session.crashes.length, anrs: i.session.anrs.length,
  };
}

/** Inline SVG sparkline — no external assets, nothing leaves the machine. */
function spark(vals: number[], label: string, unit: string, noData: string): string {
  if (vals.length < 2) return `<p>${esc(label)}: ${esc(noData)}</p>`;
  const w = 480, h = 80, max = Math.max(...vals, 1), min = Math.min(...vals, 0);
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - ((v - min) / (max - min || 1)) * (h - 6) - 3).toFixed(1)}`).join(" ");
  return `<figure><figcaption>${esc(label)} (max ${max.toFixed(1)}${unit})</figcaption><svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(label)}"><polyline fill="none" stroke="#2563eb" stroke-width="2" points="${pts}"/></svg></figure>`;
}

export function renderHtml(i: ReportInput): string {
  const t = labels(i);
  const sum = summarize(i);
  const rows = i.session.steps.map((s) => {
    let img = "";
    if (s.screenshot && existsSync(s.screenshot)) img = `<img alt="step ${s.idx}" width="160" src="data:image/png;base64,${readFileSync(s.screenshot).toString("base64")}">`;
    return `<tr><td>${s.idx}</td><td>${esc(s.tool)}</td><td><code>${esc(redact(JSON.stringify(s.params)))}</code></td><td>${esc(s.reason ?? "")}</td><td class="r-${s.result}">${s.result}${s.error_code ? ` (${esc(s.error_code)})` : ""}</td><td>${img}</td></tr>`;
  }).join("");
  const m = i.metrics ?? [];
  return `<!doctype html><html lang="${t.htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.title)} — ${esc(sum.name)}</title>
<style>:root{color-scheme:light dark}body{font:14px system-ui;margin:2rem auto;max-width:1000px;padding:0 1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #8884;padding:.4rem;vertical-align:top;text-align:left}
.r-success{color:#15803d}.r-failed,.r-denied{color:#b91c1c}.r-blocked{color:#b45309}pre{white-space:pre-wrap;background:#8881;padding:.6rem}</style></head><body>
<h1>${esc(sum.name)}</h1>
<table><tr><th>${esc(t.startEnd)}</th><td>${esc(sum.started)} → ${esc(sum.ended ?? "-")} (${esc(sum.stop_reason ?? "")})</td></tr>
<tr><th>${esc(t.device)}</th><td>${esc(sum.device.serial)} ${esc(sum.device.model ?? "")} Android ${esc(sum.device.androidVersion ?? "?")}</td></tr>
<tr><th>${esc(t.app)}</th><td>${esc(sum.package)} ${esc(sum.app_version ?? "")}</td></tr>
<tr><th>${esc(t.steps)}</th><td>${sum.steps} (${t.ok} ${sum.success} / ${t.failed} ${sum.failed} / ${t.blocked} ${sum.blocked}) · ${t.approved} ${sum.approvals.approved} · ${t.denied} ${sum.approvals.denied}</td></tr>
<tr><th>${esc(t.crashes)}</th><td>${sum.crashes} / ${sum.anrs}</td></tr></table>
${i.aiSummary ? `<h2>${esc(t.aiSummary)}</h2><pre>${esc(redact(i.aiSummary))}</pre>` : ""}
<h2>${esc(t.metrics)}</h2>${spark(m.map((x) => x.cpu_sys ?? 0), t.cpu, "%", t.noData)}${spark(m.map((x) => (x.ram_app_kb ?? 0) / 1024), t.ram, " MB", t.noData)}
<h2>${esc(t.crashes)} / ANR</h2><pre>${esc(redact([...i.session.crashes, ...i.session.anrs].join("\n")) || t.none)}</pre>
<h2>${esc(t.steps)}</h2><table><tr><th>#</th><th>Tool</th><th>${esc(t.params)}</th><th>${esc(t.reason)}</th><th>${esc(t.result)}</th><th>${esc(t.shot)}</th></tr>${rows}</table>
<h2>${esc(t.importantLogs)}</h2><pre>${esc(redact((i.importantLogs ?? []).join("\n")) || "-")}</pre>
</body></html>`;
}

export function renderMarkdown(i: ReportInput): string {
  const t = labels(i);
  const s = summarize(i);
  return [
    `# ${s.name}`, "",
    `- ${t.time}: ${s.started} → ${s.ended ?? "-"} (${s.stop_reason ?? ""})`,
    `- ${t.device}: ${s.device.serial} ${s.device.model ?? ""}`, `- ${t.app}: ${s.package} ${s.app_version ?? ""}`,
    `- ${t.stepsRow}: ${s.steps} (${t.okCount} ${s.success}, ${t.failedCount} ${s.failed}, ${t.blockedCount} ${s.blocked}), ${t.approvedCount} ${s.approvals.approved}, ${t.deniedCount} ${s.approvals.denied}`,
    `- ${t.crash}: ${s.crashes}, ${t.anr}: ${s.anrs}`, "",
    `| # | tool | ${t.result} | ${t.reason} |`, "|---|---|---|---|",
    ...i.session.steps.map((x) => `| ${x.idx} | ${x.tool} | ${x.result}${x.error_code ? ` (${x.error_code})` : ""} | ${(x.reason ?? "").replace(/\|/g, "/")} |`),
  ].join("\n");
}

export function writeReport(i: ReportInput, format: "html" | "md" | "json"): string {
  const out = path.join(i.session.dir, `report.${format}`);
  const body = format === "html" ? renderHtml(i) : format === "md" ? renderMarkdown(i) : JSON.stringify({ summary: summarize(i), steps: i.session.steps }, null, 2);
  writeFileSync(out, body, { mode: 0o600 });
  return out;
}
