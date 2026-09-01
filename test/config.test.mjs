import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("managed config merge preserves comments and unknown keys", () => {
  const script = `
    import { mergeManagedConfig } from "./src/config.ts";
    const existing = "# keep this comment\\nCUSTOM_SETTING=untouched\\nT3CODE_HOST=old.example\\n";
    const result = mergeManagedConfig(existing, { T3CODE_HOST: "new.example", T3CODE_PORT: "3773" });
    if (!result.includes("# keep this comment")) throw new Error("comment was lost");
    if (!result.includes("CUSTOM_SETTING=untouched")) throw new Error("custom setting was lost");
    if (!result.includes("T3CODE_HOST=new.example")) throw new Error("managed value was not updated");
    if (!result.includes("T3CODE_PORT=3773")) throw new Error("missing managed value was not added");
    if (mergeManagedConfig(result, { T3CODE_HOST: "new.example", T3CODE_PORT: "3773" }) !== result) throw new Error("merge was not idempotent");
  `;
  const result = spawnSync("bun", ["-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
