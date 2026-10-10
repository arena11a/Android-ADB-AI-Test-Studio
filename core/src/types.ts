import type { z } from "zod";

export type Risk = "low" | "medium" | "high" | "critical" | "forbidden";
export type Mode = "safe" | "observe" | "develop" | "automation" | "approve_all" | "plan_only" | "repair" | "bootloader";
export type Actor = "user" | "ai";
export type Role = "viewer" | "tester" | "admin";
export type Category = "device" | "app" | "file" | "screen" | "input" | "logs" | "metrics" | "session" | "report" | "power" | "security" | "bootloader";

export type ErrorCode =
  | "POLICY_DENIED" | "NEEDS_APPROVAL" | "APPROVAL_DENIED" | "APPROVAL_EXPIRED"
  | "DEVICE_NOT_FOUND" | "DEVICE_UNAUTHORIZED" | "DEVICE_LOCKED" | "FOREGROUND_MISMATCH"
  | "OUT_OF_SCOPE" | "PATH_FORBIDDEN" | "RATE_LIMITED" | "KILL_SWITCH" | "SESSION_LIMIT"
  | "UNSUPPORTED" | "TIMEOUT" | "ADB_ERROR" | "INVALID_PARAMS" | "INTERNAL" | "APPROVAL_REQUIRED";

export class StudioError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
    this.name = "StudioError";
  }
}

export interface ToolDef {
  name: string;
  category: Category;
  risk: Risk;
  description: string;
  schema: z.ZodTypeAny;
  /** state-changing tools must be approved in approve_all mode */
  mutates: boolean;
}

export interface ToolRequest {
  tool: string;
  params: unknown;
  actor: Actor;
  client?: string;      // e.g. "claude-code", "opencode", "ui"
  sessionId?: string;
  reason?: string;
}

export type DecisionKind = "allow" | "ask" | "deny" | "dry_run";
export interface Decision {
  kind: DecisionKind;
  risk: Risk;
  code?: ErrorCode;
  message?: string;
}

export type ToolResult<T = unknown> =
  | { ok: true; data: T; risk: Risk; audit_id: number; dry_run?: boolean }
  | { ok: false; error: { code: ErrorCode; message: string }; risk: Risk; audit_id: number };

export interface PolicyFile {
  schemaVersion: number;
  mode: Mode;
  role: Role;
  targetPackages: string[];
  features: {
    files: boolean; install: boolean; delete: boolean; input: boolean; power: boolean;
    advancedMode: boolean; liveView: boolean; repair: boolean; bootloader: boolean;
  };
  localApkDirs: string[];
  files: {
    allow: string[]; deny: string[]; localDownloadDir: string;
    maxTextEditBytes: number; backupBeforeOverwrite: boolean;
  };
  forbiddenTools: string[];
  alwaysApprove: string[];
  rateLimits: {
    toolCallsPerMinute: number; inputPerSecond: number; inputPerMinute: number;
    installsPerHour: number; deletesPerSession: number; sameScreenRetries: number;
  };
  session: {
    defaultMaxSteps: number; defaultMaxSeconds: number; aiSessionMaxSeconds: number;
    stopOnCrash: boolean; stopOnAnr: boolean; stopWhenLeavingTarget: boolean;
  };
  approval: { ttlSeconds: number; allowTimeWindow: boolean; timeWindowSecondsMax: number; neverPermanent: Risk[] };
  ai: { logsTargetOnly: boolean; allowRawCoordinates: boolean; requireReason: boolean; dryRunDefault: boolean };
  anomaly: {
    forbiddenRepeatThreshold: number; forbiddenWindowSeconds: number; massDeleteThreshold: number;
    multiClearThreshold: number; powerRepeatThreshold: number; autoSafeModeOnAnomaly: boolean;
  };
  privacy: { localOnly: boolean; highPrivacyMode: boolean; recordScreenshots: boolean; recordVideo: boolean; redactLogs: boolean };
}
