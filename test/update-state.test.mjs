import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("update attempt state is durable and rejects malformed records", async () => {
  const home = await mkdtemp(join(tmpdir(), "t3codectl-update-state-"));
  const statePath = join(home, "update-state.json");
  try {
    const script = `
      import { readUpdateAttempt, writeUpdateAttempt } from "./src/update-state.ts";
      const statePath = process.env.T3CODECTL_TEST_STATE_PATH;
      const started = { protocol: 1, startedAt: "2026-09-02T12:00:00.000Z", finishedAt: null, result: "running", error: null };
      writeUpdateAttempt(statePath, started);
      if (JSON.stringify(readUpdateAttempt(statePath)) !== JSON.stringify(started)) throw new Error("running attempt did not round-trip");
      const finished = { ...started, finishedAt: "2026-09-02T12:01:00.000Z", result: "deferred", error: "insufficient capacity" };
      writeUpdateAttempt(statePath, finished);
      if (JSON.stringify(readUpdateAttempt(statePath)) !== JSON.stringify(finished)) throw new Error("finished attempt did not round-trip");
      await Bun.write(statePath, "{ malformed");
      if (readUpdateAttempt(statePath) !== null) throw new Error("malformed state was accepted");
    `;
    const result = spawnSync("bun", ["-e", script], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, T3CODECTL_TEST_STATE_PATH: statePath },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
