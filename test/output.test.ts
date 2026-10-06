import { test, expect } from "bun:test";
import { describeHealthReason } from "../src/health-reason.ts";
import { readSnapshotIdleState } from "../src/idle.ts";
import { formatDuration, Ui } from "../src/ui.ts";

function capture() {
  const lines: string[] = [];
  const stream = { isTTY: false, write: (chunk: string) => { lines.push(chunk); return true; } };
  return { ui: new Ui(stream, stream), text: () => lines.join("") };
}

test("health reason codes become sentences", () => {
  expect(describeHealthReason("port-not-listening", 3773)).toBe("nothing is listening on port 3773 yet");
  expect(describeHealthReason("health-request=The operation timed out.")).toBe("the server is not answering requests yet");
  expect(describeHealthReason("health-request=connect ECONNREFUSED")).toBe("the server could not be reached (connect ECONNREFUSED)");
  expect(describeHealthReason("listener-outside-service-cgroup=42", 3773)).toBe("port 3773 is held by PID 42, which is not part of the service");
  expect(describeHealthReason("active-version=1.2.3")).toBe("the service is still on 1.2.3");
  expect(describeHealthReason("something-new")).toBe("something-new");
});

test("idle results carry a readable summary next to the diagnostic code", () => {
  const snapshot = (threads: any[]) => ({ schemaVersion: 2, threads, archivedThreads: [] });
  expect(readSnapshotIdleState(snapshot([{ status: "completed" }])).summary).toBe("no agent work is running");
  expect(readSnapshotIdleState(snapshot([{ status: "running" }])).summary).toBe("1 thread is still working");
  expect(readSnapshotIdleState(snapshot([{ status: "running" }, { status: "queued" }])).summary).toBe("2 threads are still working");
  expect(readSnapshotIdleState(snapshot([{ status: "mystery" }])).summary).toBe("1 thread is in a state t3codectl does not recognize");
});

test("non-terminal output is plain, grouped, and logs wait progress once per change", async () => {
  const { ui, text } = capture();
  ui.section("T3 Code", "nightly channel");
  await ui.wait("Waiting for the new server to start", async (progress) => {
    progress("nothing is listening on port 3773 yet");
    progress("nothing is listening on port 3773 yet");
    progress("the server is not answering requests yet");
  });
  ui.ok("The server is healthy");
  ui.verdict("ok", "Updated T3 Code to 2.0.0.");
  expect(text()).toBe([
    "T3 Code  nightly channel",
    "  › Waiting for the new server to start",
    "    nothing is listening on port 3773 yet",
    "    the server is not answering requests yet",
    "  ✓ The server is healthy",
    "✓ Updated T3 Code to 2.0.0.",
    "",
  ].join("\n"));
  expect(text()).not.toContain("\u001b");
});

test("durations are short and human", () => {
  expect(formatDuration(4_200)).toBe("4s");
  expect(formatDuration(65_000)).toBe("1m 05s");
});
