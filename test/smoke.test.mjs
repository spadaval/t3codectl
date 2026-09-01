import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("compiled CLI exposes the command surface", async () => {
  const source = await readFile(new URL("../dist/main.js", import.meta.url), "utf8");
  for (const command of ["setup", "status", "pair", "update", "uninstall"]) {
    assert.match(source, new RegExp(`command === \\"${command}\\"`));
  }
});

test("pair delegates URL creation to T3 Code", async () => {
  const source = await readFile(new URL("../dist/main.js", import.meta.url), "utf8");
  assert.match(source, /auth.*pairing.*create/);
  assert.match(source, /--base-url/);
  assert.match(source, /--json/);
  assert.match(source, /pairUrl/);
});

test("uninstall is limited to explicit management paths", async () => {
  const source = await readFile(new URL("../dist/main.js", import.meta.url), "utf8");
  const uninstall = source.slice(source.indexOf("async function uninstall"), source.indexOf("function printHelp"));
  assert.match(uninstall, /const allowed = \[/);
  assert.doesNotMatch(uninstall, /rmSync|recursive|T3CODE_HOME/);
  assert.doesNotMatch(uninstall, /config\.serviceUnit\]\)/);
  assert.match(uninstall, /dropinPath\(config\.serviceUnit\)/);
  assert.match(uninstall, /preserved T3 Code data/);
});

test("T3 owns the server unit and t3codectl uses a drop-in for server settings", async () => {
  const source = await readFile(new URL("../dist/main.js", import.meta.url), "utf8");
  const setup = source.slice(source.indexOf("async function setup"), source.indexOf("function parseKeyValueOutput"));
  assert.match(setup, /t3Service\(config, "install"\)/);
  assert.match(setup, /renderT3Dropin\(config\)/);
  assert.match(setup, /dropinPath\(config\.serviceUnit\)/);
  assert.doesNotMatch(setup, /writeFileSync\(unitPath\(config\.serviceUnit\)/);
  assert.match(source, /Environment=T3CODE_HOST=/);
  assert.match(source, /Environment=T3CODE_PORT=/);
});

test("package installs as a real CLI and builds GitHub installs", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.bin.t3codectl, "dist/main.js");
  assert.equal(packageJson.scripts.prepare, "npm run build");
  assert.ok(packageJson.files.includes("dist"));
});

test("setup can bootstrap an empty T3 Code home through T3", async () => {
  const source = await readFile(new URL("../dist/main.js", import.meta.url), "utf8");
  const setup = source.slice(source.indexOf("async function setup"), source.indexOf("function parseKeyValueOutput"));
  assert.doesNotMatch(setup, /if \(!existsSync\(config\.home\)\)/);
  assert.match(source, /command === "install" \? homedir\(\) : config\.home/);
});
