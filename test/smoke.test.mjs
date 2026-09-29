import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("compiled CLI exposes the command surface", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  for (const command of ["setup", "repair", "status", "pair", "update", "uninstall"]) {
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
  assert.match(uninstall, /UPDATE_STATE_PATH/);
  assert.match(uninstall, /preserved T3 Code data/);
});

test("T3 owns the server unit and t3codectl uses a drop-in for server settings", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const apply = source.slice(source.indexOf("async function applyConfiguration"), source.indexOf("async function setup"));
  assert.match(source, /t3Service\(config, "install"\)/);
  assert.match(apply, /renderT3Dropin\(config\)/);
  assert.match(apply, /dropinPath\(config\.serviceUnit\)/);
  assert.doesNotMatch(apply, /writeFileSync\(unitPath\(config\.serviceUnit\)/);
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

test("repair reconciles and verifies an existing installation", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const repair = source.slice(source.indexOf("async function repair"), source.indexOf("function promptValue"));
  assert.match(repair, /applyConfiguration\(loadConfig\(\),/);
  assert.match(repair, /no existing T3 Code configuration found/);
  assert.match(source, /T3 Code did not become healthy/);
});

test("startup failures explain the port owner and offer explicit recovery", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(source, /journalctl.*--user.*-u/);
  assert.match(source, /Processes currently listening on port/);
  assert.match(source, /command:/);
  assert.match(source, /repair --stop-conflicting/);
  assert.match(source, /process\.kill\(candidate\.pid, "SIGTERM"\)/);
  assert.match(source, /Stop these conflicting T3 Code processes and retry\?/);
});

test("setup preserves unmanaged config content and avoids needless restarts", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const config = await readFile(new URL("../src/config.ts", import.meta.url), "utf8");
  assert.match(config, /Comments, ordering, and unknown keys/);
  assert.match(config, /mergeManagedConfig/);
  assert.match(source, /if \(content === existing\) return false/);
  assert.match(source, /if \(dropinChanged \|\| active\.code !== 0\)/);
  assert.match(source, /setup prerequisites are not ready/);
  assert.match(source, /Node 22 or newer is required/);
  assert.match(source, /Waiting for T3 Code to become healthy/);
});

test("setup defaults to an hourly update schedule", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(source, /T3CODE_UPDATE_SCHEDULE\", \"hourly\"/);
  assert.doesNotMatch(source, /T3CODE_UPDATE_SCHEDULE\", \"\*-\*-\* \*:00:00\"/);
});

test("capacity deferrals show human-readable available and required values", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const capacityCheck = source.slice(source.indexOf("function capacitySufficient"), source.indexOf("async function reconcile"));
  assert.match(capacityCheck, /formatBytes\(freeBytes\)/);
  assert.match(capacityCheck, /formatBytes\(MIN_FREE_BYTES\)/);
  assert.match(capacityCheck, /available/);
  assert.match(capacityCheck, /required/);
});

test("updates use the supported native command and only roll back changed state", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const reconcile = source.slice(source.indexOf("async function reconcile"), source.indexOf("function pruneRuntimeVersions"));
  const update = source.slice(source.indexOf("async function updateLocked"), source.indexOf("async function update(args"));
  assert.match(reconcile, /`t3@\$\{cliVersion\}`/);
  assert.match(reconcile, /"update", targetVersion/);
  assert.match(reconcile, /"--yes"/);
  assert.match(reconcile, /NODE_USE_ENV_PROXY: process\.env\.NODE_USE_ENV_PROXY \?\? "1"/);
  assert.match(reconcile, /allowDowngrade.*"--allow-downgrade"/s);
  assert.doesNotMatch(reconcile, /"service", "update"/);
  assert.match(update, /update command failed/);
  assert.match(update, /const afterFailure = readServiceState\(config\)/);
  assert.match(update, /if \(unchangedHealth\.ok\).*active runtime was unchanged and is still running.*return updateExecution/s);
  assert.match(update, /reconcile\(config, target, target\)/);
  assert.match(update, /reconcile\(config, target, before\.activeVersion, true\)/);
});

test("status uses the grouped terminal renderer and preserves detailed tracking", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const status = source.slice(source.indexOf("async function status"), source.indexOf("async function pair"));
  assert.match(source, /const UPDATE_STATE_PATH = "\/var\/lib\/t3codectl\/update-state\.json"/);
  assert.match(status, /renderStatus\(result\)/);
  assert.match(status, /readUpdateAttempt/);
  assert.match(status, /ended before recording a result/);
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
