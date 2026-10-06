import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const HOUR = 3600000;
const MAX_ATTEMPTS = 5;
export type RecoveryEntry = { failedRunId: string; commandId: string; messageId: string; attempts: number; nextAttemptAt: number };
export type RecoveryState = { protocol: 1; threads: Record<string, RecoveryEntry> };
export interface RecoveryClient { get(path: string): Promise<any>; dispatch(command: Record<string, unknown>): Promise<unknown> }

export function readRecoveryState(path: string): RecoveryState {
  if (!existsSync(path)) return { protocol: 1, threads: {} };
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state?.protocol !== 1 || !state.threads || typeof state.threads !== "object" || Array.isArray(state.threads)) throw new Error("invalid recovery state");
  for (const entry of Object.values(state.threads) as any[]) {
    if (!entry || ![entry.failedRunId, entry.commandId, entry.messageId].every((s) => typeof s === "string" && s.length > 0) ||
      !Number.isInteger(entry.attempts) || entry.attempts < 1 || entry.attempts > MAX_ATTEMPTS || !Number.isFinite(entry.nextAttemptAt)) throw new Error("invalid recovery entry");
  }
  return state;
}

export function writeRecoveryState(path: string, state: RecoveryState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp.${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** Match provider failures, never arbitrary conversation text or tool output. */
export function isCapacityFailure(failure: any): boolean {
  if (!failure || failure.class !== "provider_error" || failure.retryable === false || typeof failure.message !== "string") return false;
  // Quota, authentication and invalid requests need user action rather than retries.
  if (/\b(quota|billing|credits|rate.?limit(?:_error)?|unauthori[sz]ed|authentication|invalid.request(?:_error)?|unsupported.model)\b/i.test(failure.message)) return false;
  return /\b(overloaded|overloaded_error|overload_error|insufficient capacity|at capacity|capacity (?:exceeded|exhausted)|capacity_error|server (?:is )?busy)\b/i.test(failure.message);
}

function availableThread(thread: any): boolean {
  return thread && thread.archivedAt === null && thread.deletedAt === null && thread.settledAt === null &&
    thread.settledOverride !== "settled" && thread.snoozedUntil == null && thread.lineage?.relationshipToParent !== "subagent";
}

function eligibleShell(thread: any): boolean {
  return availableThread(thread) && thread.status === "failed" && thread.activeRunId === null &&
    thread.pendingRuntimeRequest == null && !thread.pendingBackgroundTasks?.length;
}

export function failedCapacityRun(projection: any): any | null {
  if (!projection || !availableThread(projection.thread) || !Array.isArray(projection.runs) || !Array.isArray(projection.turnItems) || !Array.isArray(projection.runtimeRequests)) return null;
  if (projection.runtimeRequests.some((r: any) => r.status === "pending")) return null;
  const latest = projection.runs.reduce((a: any, b: any) => !a || b.ordinal > a.ordinal ? b : a, null);
  if (!latest || latest.status !== "failed") return null;
  const errors = projection.turnItems.filter((i: any) => i.type === "error" && i.runId === latest.id && i.nodeId === latest.rootNodeId);
  if (!errors.length || errors.some((i: any) => !Number.isSafeInteger(i.ordinal))) return null;
  errors.sort((a: any, b: any) => b.ordinal - a.ordinal);
  if (errors.length > 1 && errors[0].ordinal === errors[1].ordinal) return null;
  return isCapacityFailure(errors[0].failure) ? latest : null;
}

function threadName(thread: any): string {
  return typeof thread?.title === "string" && thread.title.trim() ? `"${thread.title.trim()}"` : `thread ${thread.id}`;
}

function stableId(threadId: string, runId: string, kind: string): string {
  return `t3codectl-recovery-${createHash("sha256").update(JSON.stringify([threadId, runId, kind])).digest("hex")}`;
}

/** Caller holds the updater flock. Persist before sending so uncertain delivery is replayable. */
export async function recoverThreads(options: {
  client: RecoveryClient; statePath: string; now?: () => number; log?: (message: string, level: "ok" | "warn") => void;
}): Promise<{ resumed: number; errors: number }> {
  const { client, statePath } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? console.log;
  const state = readRecoveryState(statePath);
  const shell = await client.get("/api/orchestration/shell");
  if (!Array.isArray(shell.threads) || shell.schemaVersion !== 2) throw new Error("unsupported T3 orchestration snapshot");
  let resumed = 0, errors = 0;
  for (const thread of shell.threads) {
    if (!eligibleShell(thread)) continue;
    try {
      const path = `/api/orchestration/threads/${encodeURIComponent(thread.id)}/bounded`;
      const projection = (await client.get(path)).projection;
      const run = failedCapacityRun(projection);
      if (!run || run.id !== thread.latestRunId) continue;
      const previous = state.threads[thread.id];
      let entry: RecoveryEntry;
      if (previous?.failedRunId === run.id) {
        // Same request: reuse IDs even after a timeout or process crash.
        if (now() < previous.nextAttemptAt) continue;
        entry = previous;
      } else {
        const attempts = previous?.messageId === run.userMessageId ? previous.attempts : 0;
        if (attempts >= MAX_ATTEMPTS) { log(`${threadName(thread)} stopped on provider overload ${MAX_ATTEMPTS} times; continue it manually`, "warn"); continue; }
        if (attempts && now() < previous.nextAttemptAt) continue;
        const completedAt = Date.parse(run.completedAt);
        if (!Number.isFinite(completedAt) || now() - completedAt < 5 * 60000) continue;
        entry = { failedRunId: run.id, commandId: stableId(thread.id, run.id, "command"), messageId: stableId(thread.id, run.id, "message"), attempts: attempts + 1, nextAttemptAt: now() + HOUR * 2 ** attempts };
      }
      // Refresh both shell controls and run state immediately before submitting.
      const currentShell = (await client.get("/api/orchestration/shell")).threads?.find((t: any) => t.id === thread.id);
      if (!eligibleShell(currentShell) || currentShell.latestRunId !== run.id) continue;
      const current = failedCapacityRun((await client.get(path)).projection);
      if (!current || current.id !== run.id) continue;
      state.threads[thread.id] = { ...entry, nextAttemptAt: now() + HOUR * 2 ** (entry.attempts - 1) };
      writeRecoveryState(statePath, state);
      await client.dispatch({ type: "message.dispatch", commandId: entry.commandId, threadId: thread.id, messageId: entry.messageId,
        text: "The previous turn stopped because the provider reported temporary capacity or overload. Continue the existing task from where it stopped, checking the current state before repeating any actions.",
        attachments: [], createdBy: "agent", creationSource: "server", dispatchMode: { type: "start_immediately" } });
      resumed++;
      log(`Resumed ${threadName(thread)}, which stopped on provider overload (attempt ${entry.attempts} of ${MAX_ATTEMPTS})`, "ok");
      // Resume at most one thread per sweep to avoid a burst into the same overload.
      break;
    } catch { errors++; log(`Could not resume ${threadName(thread)}; the next run will retry`, "warn"); }
  }
  return { resumed, errors };
}
