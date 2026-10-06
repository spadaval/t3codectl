import { test, expect } from "bun:test";
import { readSnapshotIdleState } from "../src/idle.ts";

test("V2 updates defer for active runs, runtime requests, background work and archived active runs", () => {
  const snapshot = (thread: any) => ({ schemaVersion: 2, threads: [thread], archivedThreads: [] });
  for (const status of ['preparing', 'queued', 'starting', 'running', 'waiting']) expect(readSnapshotIdleState(snapshot({ status })).state).toBe('BUSY');
  for (const fields of [{ activeRunId: 'run' }, { pendingRuntimeRequest: {} }, { pendingBackgroundTasks: [{}] }]) expect(readSnapshotIdleState(snapshot({ status: 'completed', ...fields })).state).toBe('BUSY');
  expect(readSnapshotIdleState({ schemaVersion: 2, threads: [], archivedThreads: [{ status: 'running' }] }).state).toBe('BUSY');
  expect(readSnapshotIdleState(snapshot({ status: 'failed' })).state).toBe('IDLE');
  expect(readSnapshotIdleState(snapshot({ status: 'future-status' })).state).toBe('UNKNOWN');
  expect(readSnapshotIdleState({ schemaVersion: 1, threads: [] }).state).toBe('UNKNOWN');
});
