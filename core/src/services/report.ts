import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { redact } from "../audit.js";
import type { Session } from "./session.js";
import type { MetricSample } from "./metrics.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface ReportInput { session: Session; metrics?: MetricSample[]; importantLogs?: string[]; aiSummary?: string; device?: { model?: string; androidVersion?: string } }

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
function spark(vals: number[], label: string, unit: string): string {
  if (vals.length < 2) return `<p>${esc(label)}: no data</p>`;
  const w = 480, h = 80, max = Math.max(...vals, 1), min = Math.min(...vals, 0);
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - ((v - min) / (max - min || 1)) * (h - 6) - 3).toFixed(1)}`).join(" ");
  return `<figure><figcaption>${esc(label)} (max ${max.toFixed(1)}${unit})</figcaption><svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(label)}"><polyline fill="none" stroke="#2563eb" stroke-width="2" points="${pts}"/></svg></figure>`;
}

export function renderHtml(i: ReportInput): string {
  const sum = summarize(i);
  const rows = i.session.steps.map((s) => {
    let img = "";
    if (s.screenshot && existsSync(s.screenshot)) img = `<img alt="step ${s.idx}" width="160" src="data:image/png;base64,${readFileSync(s.screenshot).toString("base64")}">`;
    return `<tr><td>${s.idx}</td><td>${esc(s.tool)}</td><td><code>${esc(redact(JSON.stringify(s.params)))}</code></td><td>${esc(s.reason ?? "")}</td><td class="r-${s.result}">${s.result}${s.error_code ? ` (${esc(s.error_code)})` : ""}</td><td>${img}</td></tr>`;
  }).join("");
  const m = i.metrics ?? [];
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test report — ${esc(sum.name)}</title>
<style>:root{color-scheme:light dark}body{font:14px system-ui;margin:2rem auto;max-width:1000px;padding:0 1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #8884;padding:.4rem;vertical-align:top;text-align:left}
.r-success{color:#15803d}.r-failed,.r-denied{color:#b91c1c}.r-blocked{color:#b45309}pre{white-space:pre-wrap;background:#8881;padding:.6rem}</style></head><body>
<h1>${esc(sum.name)}</h1>
<table><tr><th>เริ่ม / สิ้นสุด</th><td>${esc(sum.started)} → ${esc(sum.ended ?? "-")} (${esc(sum.stop_reason ?? "")})</td></tr>
<tr><th>อุปกรณ์</th><td>${esc(sum.device.serial)} ${esc(sum.device.model ?? "")} Android ${esc(sum.device.androidVersion ?? "?")}</td></tr>
<tr><th>แอป</th><td>${esc(sum.package)} ${esc(sum.app_version ?? "")}</td></tr>
<tr><th>ขั้นตอน</th><td>${sum.steps} (สำเร็จ ${sum.success} / ล้มเหลว ${sum.failed} / ถูกบล็อก ${sum.blocked}) · อนุมัติ ${sum.approvals.approved} · ปฏิเสธ ${sum.approvals.denied}</td></tr>
<tr><th>แครช / ANR</th><td>${sum.crashes} / ${sum.anrs}</td></tr></table>
${i.aiSummary ? `<h2>สรุปจาก AI</h2><pre>${esc(redact(i.aiSummary))}</pre>` : ""}
<h2>เมตริก</h2>${spark(m.map((x) => x.cpu_sys ?? 0), "CPU ระบบ", "%")}${spark(m.map((x) => (x.ram_app_kb ?? 0) / 1024), "RAM แอป", " MB")}
<h2>แครช / ANR</h2><pre>${esc(redact([...i.session.crashes, ...i.session.anrs].join("\n")) || "ไม่พบ")}</pre>
<h2>ขั้นตอน</h2><table><tr><th>#</th><th>Tool</th><th>พารามิเตอร์</th><th>เหตุผล</th><th>ผล</th><th>ภาพ</th></tr>${rows}</table>
<h2>ล็อกสำคัญ</h2><pre>${esc(redact((i.importantLogs ?? []).join("\n")) || "-")}</pre>
</body></html>`;
}

export function renderMarkdown(i: ReportInput): string {
  const s = summarize(i);
  return [
    `# ${s.name}`, "",
    `- เวลา: ${s.started} → ${s.ended ?? "-"} (${s.stop_reason ?? ""})`,
    `- อุปกรณ์: ${s.device.serial} ${s.device.model ?? ""}`, `- แอป: ${s.package} ${s.app_version ?? ""}`,
    `- ขั้นตอน: ${s.steps} (สำเร็จ ${s.success}, ล้มเหลว ${s.failed}, บล็อก ${s.blocked}), อนุมัติ ${s.approvals.approved}, ปฏิเสธ ${s.approvals.denied}`,
    `- แครช: ${s.crashes}, ANR: ${s.anrs}`, "",
    "| # | tool | ผล | เหตุผล |", "|---|---|---|---|",
    ...i.session.steps.map((x) => `| ${x.idx} | ${x.tool} | ${x.result}${x.error_code ? ` (${x.error_code})` : ""} | ${(x.reason ?? "").replace(/\|/g, "/")} |`),
  ].join("\n");
}

export function writeReport(i: ReportInput, format: "html" | "md" | "json"): string {
  const out = path.join(i.session.dir, `report.${format}`);
  const body = format === "html" ? renderHtml(i) : format === "md" ? renderMarkdown(i) : JSON.stringify({ summary: summarize(i), steps: i.session.steps }, null, 2);
  writeFileSync(out, body, { mode: 0o600 });
  return out;
}
