import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("compiled CLI exposes the four-command surface", async () => {
  const source = await readFile(new URL("../dist/main.js", import.meta.url), "utf8");
  for (const command of ["setup", "status", "update", "uninstall"]) {
    assert.match(source, new RegExp(`command === \\"${command}\\"`));
  }
});

test("uninstall is limited to explicit management paths", async () => {
  const source = await readFile(new URL("../dist/main.js", import.meta.url), "utf8");
  const uninstall = source.slice(source.indexOf("async function uninstall"), source.indexOf("function printHelp"));
  assert.match(uninstall, /const allowed = \[/);
  assert.doesNotMatch(uninstall, /rmSync|recursive|T3CODE_HOME/);
  assert.match(uninstall, /preserved T3 Code data/);
});
