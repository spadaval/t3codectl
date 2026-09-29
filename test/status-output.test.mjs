import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("status output groups related values, humanizes time, and colors state", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { formatRelativeTime, formatSchedule, renderStatus } from "./src/status-output.ts";

    const now = new Date("2026-09-22T23:09:11.326Z");
    assert.equal(formatRelativeTime("2026-09-22T21:09:11.326Z", now), "2 hours ago");
    assert.equal(formatRelativeTime("2026-09-23T03:09:11.326Z", now), "in 4 hours");
    assert.equal(formatSchedule("*-*-* 03:00:00"), "daily at 3:00 AM");

    const base = {
      active: true,
      health: true,
      healthReason: "healthy",
      runningVersion: "0.0.43-nightly.20260922.2110",
      latestVersion: "0.0.43-nightly.20260922.2110",
      latestError: null,
      updateTimer: { state: "active", schedule: "*-*-* 03:00:00", next: "2026-09-23T03:09:11.326Z" },
      lastUpdate: { startedAt: "2026-09-22T21:09:11.326Z", result: "up-to-date", error: null },
    };
    const plain = renderStatus(base, { color: false, now });
    assert.equal(plain, [
      "T3 Code",
      "  Service    running · healthy",
      "  Version    0.0.43-nightly.20260922.2110 (up to date)",
      "",
      "Automatic updates",
      "  Schedule   enabled · daily at 3:00 AM",
      "  Next       in 4 hours",
      "  Last       2 hours ago · up to date",
    ].join("\n"));
    assert.doesNotMatch(plain, /none|last update error|running version|latest version/i);

    const drifted = renderStatus({ ...base, latestVersion: "0.0.44", lastUpdate: { ...base.lastUpdate, result: "failed", error: "network unavailable" } }, { color: true, now });
    assert.ok(drifted.includes("\u001b[31m0.0.43-nightly.20260922.2110 (latest: 0.0.44)\u001b[0m"));
    assert.ok(drifted.includes("Error      \u001b[31mnetwork unavailable\u001b[0m"));
    assert.ok(renderStatus(base, { color: true, now }).includes("\u001b[32m0.0.43-nightly.20260922.2110 (up to date)\u001b[0m"));
  `;
  const result = spawnSync("bun", ["-e", script], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
