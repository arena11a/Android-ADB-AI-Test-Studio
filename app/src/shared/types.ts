/**
 * Types shared between main, preload and renderer.
 * The engine (core/) owns the real definitions — these imports keep the UI in
 * sync instead of drifting into a second source of truth.
 */
import type { PolicyFile, Mode, Role, Risk, ToolResult } from "../../../core/src/types.js";
import type { ApprovalRequest } from "../../../core/src/approval.js";
import type { DeviceInfo } from "../../../core/src/services/devices.js";
import type { LogLine } from "../../../core/src/services/logcat.js";
import type { MetricSample } from "../../../core/src/services/metrics.js";
import type { Session, Step } from "../../../core/src/services/session.js";
import type { ControlEvent, ControlSnapshot } from "../../../core/src/control.js";

export type { PolicyFile, Mode, Role, Risk, ToolResult, ApprovalRequest, DeviceInfo, LogLine, MetricSample, Session, Step, ControlEvent, ControlSnapshot };

export interface AuditRow {
  seq: number; ts: string; actor: string; client?: string; tool: string; risk: Risk;
  decision: string; ok: boolean; error_code?: string; error_msg?: string;
  device?: string; session_id?: string; params?: unknown;
}

export interface AgentStatus {
  running: boolean;
  controlConnected?: boolean;
  startedAt: number | null;
  adbPath?: string;
  error?: string;
  restarts: number;
}

/** File/dialog helpers the UI gets from the main process. */
export interface DialogResult { canceled: boolean; path?: string }

/** Everything the renderer may use — exposed by the preload over contextBridge. */
export interface StudioApi {
  platform: string;
  /** subscribe to control-plane events; returns an unsubscribe function */
  on: (event: string, cb: (data: unknown) => void) => () => void;
  /** one control-plane method call */
  call: (method: string, params?: Record<string, unknown>) => Promise<any>;
  app: {
    onAgentState: (cb: (s: AgentStatus) => void) => () => void;
  };
  agent: {
    status: () => Promise<AgentStatus>;
    restart: () => Promise<AgentStatus>;
    openPath: (p: string) => Promise<string>;
    chooseApk: () => Promise<DialogResult>;
    chooseLocalFile: (title?: string) => Promise<DialogResult>;
  };
}

declare global {
  interface Window { adbstudio: StudioApi }
}
