import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

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

export type IdleResult = { state: "IDLE" | "BUSY" | "UNKNOWN"; detail: string };

/** Read T3 Code's activity projection without requiring a system sqlite binary. */
export function readIdleState(stateDb: string): IdleResult {
  if (!existsSync(stateDb)) return { state: "UNKNOWN", detail: "state-db-unreadable" };
  let db: Database | undefined;
  try {
    db = new Database(stateDb, { readonly: true });
    const row = db.query(IDLE_QUERY).get() as { idle_detail?: unknown } | null;
    const detail = typeof row?.idle_detail === "string" ? row.idle_detail.trim() : "";
    const state = detail.split("|", 1)[0];
    if (state === "IDLE") return { state, detail };
    if (state === "BUSY") return { state, detail };
    return { state: "UNKNOWN", detail: detail || "unexpected-query-result" };
  } catch {
    return { state: "UNKNOWN", detail: "state-query-failed" };
  } finally {
    db?.close();
  }
}
