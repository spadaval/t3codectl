import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("compiled CLI exposes the command surface", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  for (const command of ["setup", "status", "pair", "update", "uninstall"]) {
    assert.match(source, new RegExp(`command === \\"${command}\\"`));
  }
});

test("pair delegates URL creation to T3 Code", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(source, /auth.*pairing.*create/);
  assert.match(source, /--base-url/);
  assert.match(source, /--json/);
  assert.match(source, /pairUrl/);
});

test("uninstall is limited to explicit management paths", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const uninstall = source.slice(source.indexOf("async function uninstall"), source.indexOf("function printHelp"));
  assert.match(uninstall, /const allowed = \[/);
  assert.doesNotMatch(uninstall, /rmSync|recursive|T3CODE_HOME/);
  assert.doesNotMatch(uninstall, /config\.serviceUnit\]\)/);
  assert.match(uninstall, /dropinPath\(config\.serviceUnit\)/);
  assert.match(uninstall, /preserved T3 Code data/);
});

test("T3 owns the server unit and t3codectl uses a drop-in for server settings", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
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
  assert.match(packageJson.scripts.build, /bun build .*--compile/);
  assert.match(packageJson.scripts.build, /t3codectl-linux-x64/);
  assert.equal(packageJson.bin, undefined);
  assert.match(packageJson.dependencies["@clack/prompts"], /^\^/);
});

test("setup can bootstrap an empty T3 Code home through T3", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const setup = source.slice(source.indexOf("async function setup"), source.indexOf("function parseKeyValueOutput"));
  assert.doesNotMatch(setup, /if \(!existsSync\(config\.home\)\)/);
  assert.match(source, /command === "install" \? homedir\(\) : config\.home/);
  assert.match(setup, /intro\("T3 Code setup"\)/);
  assert.match(setup, /--non-interactive/);
  assert.match(setup, /Apply this configuration\?/);
});

test("compiled release binary is executable", () => {
  const binary = new URL("../dist/t3codectl-linux-x64", import.meta.url).pathname;
  assert.ok(existsSync(binary), `missing release binary: ${binary}`);
  const result = spawnSync(binary, ["--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: t3codectl/);
});

test("compiled update handles Bun's embedded entry marker", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(source, /entry\?\.startsWith\("\/\$bunfs\/"\)/);
  assert.match(source, /process\.argv\.slice\(bundledBun \? 2 : 1\)/);
});
