import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("idle check uses Bun's embedded read-only SQLite driver", () => {
  const script = `
    import { Database } from "bun:sqlite";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { rmSync } from "node:fs";
    import { readIdleState } from "./src/idle.ts";

    const path = join(tmpdir(), "t3codectl-idle-" + process.pid + ".sqlite");
    try {
      let db = new Database(path);
      db.exec("CREATE TABLE projection_thread_sessions (status TEXT, active_turn_id TEXT); CREATE TABLE projection_turns (state TEXT, completed_at TEXT);");
      db.exec("INSERT INTO projection_thread_sessions VALUES ('idle', NULL); INSERT INTO projection_turns VALUES ('completed', 'done');");
      db.close();
      const idle = readIdleState(path);
      if (idle.state !== "IDLE") throw new Error("expected IDLE, got " + idle.detail);

      db = new Database(path);
      db.exec("INSERT INTO projection_turns VALUES ('running', NULL);");
      db.close();
      const busy = readIdleState(path);
      if (busy.state !== "BUSY") throw new Error("expected BUSY, got " + busy.detail);
    } finally {
      rmSync(path, { force: true });
    }
  `;
  const result = spawnSync("bun", ["-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
