import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { plural } from "./ui.ts";

const IDLE_QUERY = `
WITH unknown_counts AS (
  SELECT
    (SELECT COUNT(*) FROM projection_thread_sessions WHERE status IS NULL OR lower(status) NOT IN ('idle','starting','connecting','running','ready','interrupted','stopped','error')) AS unknown_sessions,
    (SELECT COUNT(*) FROM projection_turns WHERE state IS NULL OR lower(state) NOT IN ('pending','queued','starting','connecting','running','in_progress','interrupted','completed','error')) AS unknown_turns
), busy_counts AS (
  SELECT
    (SELECT COUNT(*) FROM projection_thread_sessions WHERE active_turn_id IS NOT NULL OR lower(status) IN ('starting','connecting','running')) AS busy_sessions,
    (SELECT COUNT(*) FROM projection_turns WHERE completed_at IS NULL OR lower(state) IN ('pending','queued','starting','connecting','running','in_progress')) AS busy_turns
)
SELECT CASE WHEN unknown_sessions + unknown_turns > 0 THEN 'UNKNOWN' WHEN busy_sessions + busy_turns > 0 THEN 'BUSY' ELSE 'IDLE' END || '|' || unknown_sessions || '|' || unknown_turns || '|' || busy_sessions || '|' || busy_turns AS idle_detail
FROM unknown_counts, busy_counts;`;

/** `detail` is a compact diagnostic code; `summary` is the sentence shown to people. */
export type IdleResult = { state: "IDLE" | "BUSY" | "UNKNOWN"; detail: string; summary: string };

const IDLE_SUMMARY = "no agent work is running";

function unknown(detail: string, summary: string): IdleResult {
  return { state: "UNKNOWN", detail, summary };
}

/** Read T3 Code's activity projection without requiring a system sqlite binary. */
export function readIdleState(stateDb: string): IdleResult {
  if (!existsSync(stateDb)) return unknown("state-db-unreadable", "could not read T3 Code's state database");
  let db: Database | undefined;
  try {
    db = new Database(stateDb, { readonly: true });
    const row = db.query(IDLE_QUERY).get() as { idle_detail?: unknown } | null;
    const detail = typeof row?.idle_detail === "string" ? row.idle_detail.trim() : "";
    const [state, ...counts] = detail.split("|");
    const [unknownSessions, unknownTurns, busySessions, busyTurns] = counts.map(Number);
    if (state === "IDLE") return { state, detail, summary: IDLE_SUMMARY };
    if (state === "BUSY") {
      const parts = [busySessions ? plural(busySessions, "active session") : "", busyTurns ? plural(busyTurns, "unfinished turn") : ""].filter(Boolean);
      return { state, detail, summary: `agent work is running (${parts.join(", ")})` };
    }
    if (state === "UNKNOWN") return unknown(detail, `${plural(unknownSessions + unknownTurns, "session or turn", "sessions or turns")} in a state t3codectl does not recognize`);
    return unknown(detail || "unexpected-query-result", "T3 Code's state database returned an unexpected result");
  } catch {
    return unknown("state-query-failed", "could not query T3 Code's state database");
  } finally {
    db?.close();
  }
}

/** V2 runs live in a separate database; the authenticated shell is its public read boundary. */
export function readSnapshotIdleState(snapshot: any): IdleResult {
  if (snapshot?.schemaVersion !== 2 || !Array.isArray(snapshot.threads) || !Array.isArray(snapshot.archivedThreads)) {
    return unknown("unsupported-orchestration-snapshot", "T3 Code returned a thread list t3codectl does not recognize");
  }
  const terminal = new Set(["idle", "completed", "failed", "cancelled", "interrupted", "rolled_back"]);
  const active = new Set(["preparing", "queued", "starting", "running", "waiting"]);
  let busy = 0, unknownCount = 0;
  for (const thread of [...snapshot.threads, ...snapshot.archivedThreads]) {
    if (!thread || typeof thread.status !== "string" || (!terminal.has(thread.status) && !active.has(thread.status))) { unknownCount++; continue; }
    if (active.has(thread.status) || thread.activeRunId != null || thread.pendingRuntimeRequest != null || thread.pendingBackgroundTasks?.length) busy++;
  }
  const detail = `v2|unknown=${unknownCount}|busy=${busy}`;
  if (unknownCount) return unknown(detail, `${plural(unknownCount, "thread")} ${unknownCount === 1 ? "is" : "are"} in a state t3codectl does not recognize`);
  if (busy) return { state: "BUSY", detail, summary: `${plural(busy, "thread")} ${busy === 1 ? "is" : "are"} still working` };
  return { state: "IDLE", detail, summary: IDLE_SUMMARY };
}
