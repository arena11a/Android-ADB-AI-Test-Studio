import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Actor, Risk } from "./types.js";

export type ApprovalOutcome = "approved" | "denied" | "expired" | "cancelled";

export interface ApprovalRequest {
  id: string;
  requestedBy: Actor;
  client?: string;
  tool: string;
  params: unknown;
  reason?: string;
  risk: Risk;
  impact: string;
  device?: string;
  package?: string;
  createdAt: number;
  expiresAt: number;
  /** critical actions need the user to type this word in the UI */
  typedConfirm?: string;
}

interface Pending { req: ApprovalRequest; resolve: (o: ApprovalOutcome) => void; timer: NodeJS.Timeout }

/**
 * Approvals are single-use by design: approve() resolves exactly one waiting
 * request. There is no "remember this choice" — high/critical are never permanent.
 */
export class ApprovalQueue extends EventEmitter {
  private pending = new Map<string, Pending>();

  request(input: Omit<ApprovalRequest, "id" | "createdAt" | "expiresAt">, ttlSeconds: number): { req: ApprovalRequest; outcome: Promise<ApprovalOutcome> } {
    const now = Date.now();
    const req: ApprovalRequest = { ...input, id: randomUUID(), createdAt: now, expiresAt: now + ttlSeconds * 1000 };
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(req.id, "expired"), ttlSeconds * 1000);
      this.pending.set(req.id, { req, resolve, timer });
    });
    this.emit("added", req);
    return { req, outcome };
  }

  list(): ApprovalRequest[] { return [...this.pending.values()].map((p) => p.req); }

  approve(id: string, typedConfirm?: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (p.req.typedConfirm && typedConfirm !== p.req.typedConfirm) return false; // wrong word: stays pending
    return this.settle(id, "approved");
  }
  deny(id: string): boolean { return this.settle(id, "denied"); }
  cancel(id: string): boolean { return this.settle(id, "cancelled"); }
  cancelAll(): void { for (const id of [...this.pending.keys()]) this.settle(id, "cancelled"); }

  private settle(id: string, outcome: ApprovalOutcome): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(outcome);
    this.emit("settled", p.req, outcome);
    return true;
  }
}
