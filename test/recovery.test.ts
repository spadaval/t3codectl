import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failedCapacityRun, isCapacityFailure, readRecoveryState, recoverThreads } from "../src/recovery.ts";

const HOUR = 3600000;
function fixture() {
  const thread = { id: "thread-1", archivedAt: null, deletedAt: null, settledAt: null, settledOverride: null, lineage: { relationshipToParent: null }, status: "failed", latestRunId: "run-1", activeRunId: null };
  const run = { id: "run-1", ordinal: 1, status: "failed", rootNodeId: "node-1", userMessageId: "human-message", completedAt: new Date(0).toISOString() };
  const projection = { thread, runs: [run], runtimeRequests: [], turnItems: [{ type: "error", ordinal: 1, runId: run.id, nodeId: run.rootNodeId, failure: { class: "provider_error", message: 'HTTP 503: provider has insufficient capacity', retryable: null } }] };
  return { thread, run, projection };
}
async function scenario(fn: (ctx: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "t3-recovery-test-"));
  const f = fixture();
  const ctx = { ...f, path: join(dir, "state.json"), clock: HOUR, sent: [] as any[], shellReads: 0,
    client: {} as any, log: [] as string[] };
  ctx.client.get = async (path: string) => {
    if (path === "/api/orchestration/shell") { ctx.shellReads++; return { schemaVersion: 2, threads: [ctx.thread] }; }
    return { projection: ctx.projection };
  };
  ctx.client.dispatch = async (command: any) => { ctx.sent.push(command); };
  ctx.sweep = () => recoverThreads({ client: ctx.client, statePath: ctx.path, now: () => ctx.clock, log: (s) => ctx.log.push(s) });
  try { await fn(ctx); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("capacity classification excludes quota, permanent errors and conversation text", () => {
  for (const message of ['Provider is overloaded', '{"type":"overloaded_error","message":"Overloaded"}', 'model is at capacity', 'capacity exceeded', 'server is busy']) {
    expect(isCapacityFailure({ class: "provider_error", message })).toBe(true);
  }
  for (const message of ['quota exhausted: insufficient capacity', 'authentication failure: overloaded', 'rate limit exceeded', 'invalid_request_error: server busy', 'disk capacity low', 'generic 503 unavailable', 'unsupported model']) {
    expect(isCapacityFailure({ class: "provider_error", message })).toBe(false);
  }
  expect(isCapacityFailure({ class: "usage_limit", message: "overloaded" })).toBe(false);
  expect(isCapacityFailure({ class: "provider_error", message: "overloaded", retryable: false })).toBe(false);
});

test("only latest failed root-run errors qualify", () => {
  const { projection, run } = fixture();
  expect(failedCapacityRun(projection)?.id).toBe("run-1");
  projection.runs.push({ ...run, id: "new", ordinal: 2, status: "completed" });
  expect(failedCapacityRun(projection)).toBeNull();
  projection.runs.pop(); projection.turnItems[0].nodeId = "child-node";
  expect(failedCapacityRun(projection)).toBeNull();
});

test("settled, archived, snoozed, delegated, pending approval and busy threads are skipped", async () => {
  for (const changes of [{ settledAt: "now" }, { settledOverride: "settled" }, { archivedAt: "now" }, { snoozedUntil: "later" }, { lineage: { relationshipToParent: "subagent" } }, { activeRunId: "active" }, { pendingBackgroundTasks: [{}] }, { pendingRuntimeRequest: {} }, { status: "cancelled" }]) {
    await scenario(async (c) => { Object.assign(c.thread, changes); await c.sweep(); expect(c.sent).toHaveLength(0); });
  }
  await scenario(async (c) => { c.projection.runtimeRequests.push({ status: "pending" }); await c.sweep(); expect(c.sent).toHaveLength(0); });
});

test("writes durable IDs before dispatch and replays uncertain delivery after backoff", async () => {
  await scenario(async (c) => {
    c.client.dispatch = async (command: any) => {
      expect(readRecoveryState(c.path).threads['thread-1'].commandId).toBe(command.commandId);
      c.sent.push(command); throw Error("lost response after acceptance");
    };
    expect((await c.sweep()).errors).toBe(1);
    expect(c.sent).toHaveLength(1);
    await c.sweep(); expect(c.sent).toHaveLength(1);
    c.clock += HOUR;
    await c.sweep(); expect(c.sent).toHaveLength(2);
    expect(c.sent[1]).toEqual(c.sent[0]);
    expect(readRecoveryState(c.path).threads['thread-1'].attempts).toBe(1);
  });
});

test("backoff and retry cap persist across automatic failures; manual continuation resets", async () => {
  await scenario(async (c) => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const before = c.sent.length;
      await c.sweep(); expect(c.sent).toHaveLength(before + 1);
      const message = c.sent.at(-1).messageId;
      c.run.ordinal++; c.run.id = `run-${c.run.ordinal}`; c.run.userMessageId = message;
      c.thread.latestRunId = c.run.id;
      c.projection.turnItems[0].runId = c.run.id;
      await c.sweep(); expect(c.sent).toHaveLength(before + 1);
      c.clock += HOUR * 2 ** (attempt - 1);
    }
    await c.sweep(); expect(c.sent).toHaveLength(5);
    c.run.userMessageId = "new human continuation";
    await c.sweep(); expect(c.sent).toHaveLength(6);
    expect(readRecoveryState(c.path).threads['thread-1'].attempts).toBe(1);
  });
});

test("fresh failures cool down; changed threads are rechecked before dispatch", async () => {
  await scenario(async (c) => { c.run.completedAt = new Date(c.clock).toISOString(); await c.sweep(); expect(c.sent).toHaveLength(0); });
  await scenario(async (c) => {
    const get = c.client.get;
    c.client.get = async (path: string) => { const result = await get(path); if (c.shellReads === 2) c.thread.status = "running"; return result; };
    await c.sweep(); expect(c.sent).toHaveLength(0);
  });
});

test("corrupt state and incompatible server fail closed", async () => {
  await scenario(async (c) => {
    writeFileSync(c.path, '{"protocol":1,"threads":{"thread-1":{"attempts":0}}}');
    await expect(c.sweep()).rejects.toThrow(); expect(c.sent).toHaveLength(0);
  });
  await scenario(async (c) => { c.client.get = async () => ({ schemaVersion: 1, threads: [c.thread] }); await expect(c.sweep()).rejects.toThrow(); });
});

test("later permanent root errors override earlier capacity errors; ambiguous order fails closed", () => {
  const { projection } = fixture();
  projection.turnItems.push({ ...projection.turnItems[0], ordinal: 2, failure: { class: 'provider_error', message: 'authentication failed', retryable: null } });
  expect(failedCapacityRun(projection)).toBeNull();
  projection.turnItems[1].failure.message = 'overloaded';
  expect(failedCapacityRun(projection)?.id).toBe('run-1');
  projection.turnItems[1].ordinal = 1;
  expect(failedCapacityRun(projection)).toBeNull();
  (projection.turnItems[1] as any).ordinal = undefined;
  expect(failedCapacityRun(projection)).toBeNull();
});

test("background work beginning during recheck prevents a continuation", async () => {
  await scenario(async (c) => {
    const get = c.client.get;
    c.client.get = async (path: string) => {
      const result = await get(path);
      if (c.shellReads === 2) c.thread.pendingBackgroundTasks = [{ status: 'running' }];
      return result;
    };
    await c.sweep(); expect(c.sent).toHaveLength(0);
  });
});
