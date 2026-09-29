import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("service state reads stable fields across launcher protocol revisions", () => {
  const script = `
    import assert from "node:assert/strict";
    import { parseServiceState } from "./src/service-state.ts";

    const version = "0.0.43-nightly.20260922.2110";
    assert.deepEqual(
      parseServiceState(JSON.stringify({ protocol: 2, activeVersion: version })),
      { activeVersion: version, updateStatus: "none" },
    );
    assert.deepEqual(
      parseServiceState(JSON.stringify({ protocol: 3, activeVersion: version })),
      { activeVersion: version, updateStatus: "none" },
    );
    assert.deepEqual(
      parseServiceState(JSON.stringify({
        protocol: 4,
        activeVersion: version,
        update: { status: "pending" },
      })),
      { activeVersion: version, updateStatus: "pending" },
    );
    assert.equal(parseServiceState("{ malformed"), null);
    assert.equal(parseServiceState(JSON.stringify({ protocol: 3, activeVersion: "nightly" })), null);
    assert.equal(parseServiceState(JSON.stringify({
      protocol: 3,
      activeVersion: version,
      update: { status: "unknown" },
    })), null);
  `;
  const result = spawnSync("bun", ["-e", script], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
