#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import { existsSync, accessSync, constants, mkdirSync, readFileSync, renameSync, statfsSync, unlinkSync, writeFileSync, chmodSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { cancel, confirm, intro, isCancel, note, outro, select, text } from "@clack/prompts";
import { mergeManagedConfig, resolveConnectionUrl } from "./config.ts";
import { readIdleState, readSnapshotIdleState } from "./idle.ts";
import { parseServiceState, VERSION_RE } from "./service-state.ts";
import { renderStatus } from "./status-output.ts";
import { readUpdateAttempt, writeUpdateAttempt, type UpdateAttempt, type UpdateAttemptResult } from "./update-state.ts";
import { selfUpdate } from "./self-update.ts";
import { writePending, readPending, pendingConnection, needsNativeRepair, type PendingPhase } from "./pending-config.ts";
import { belongsToService, configureService, withConfigurationLock } from "./service-setup.ts";
import { T3Client } from "./t3-client.ts";
import { recoverThreads } from "./recovery.ts";
import packageJson from "../package.json";

const CONFIG_PATH = process.env.T3CODECTL_CONFIG ?? "/etc/t3codectl/config.env";
const INSTALL_PATH = "/usr/local/bin/t3codectl";
const UPDATE_STATE_PATH = "/var/lib/t3codectl/update-state.json";
const PENDING_CONFIG_PATH = "/var/lib/t3codectl/pending-configuration.json";
const RECOVERY_STATE_PATH = "/var/lib/t3codectl/recovery-state.json";
const DEFAULT_SERVICE_UNIT = "t3code.service";
const DEFAULT_UPDATE_UNIT = "t3codectl-update.service";
const DEFAULT_TIMER_UNIT = "t3codectl-update.timer";
const T3CODE_DROPIN_NAME = "10-t3codectl.conf";
const MIN_FREE_BYTES = 5 * 1024 ** 3;
const MIN_FREE_INODES = 100_000;

type Config = {
  configPath: string;
  home: string;
  host: string;
  port: number;
  mode: string;
  packageTag: string;
  node: string;
  npx: string;
  npm: string;
  schedule: string;
  serviceUnit: string;
  updateUnit: string;
  timerUnit: string;
  stateDb: string;
  idleCheck: string;
  lockFile: string;
  healthUrl: string;
  baseUrl: string;
  path: string;
  user: string;
};

type CommandResult = { code: number; stdout: string; stderr: string };
type HealthResult = { ok: boolean; reason: string };
type PortListener = { pid: number; name: string; command: string; cgroup: string; inConfiguredService: boolean; looksLikeT3: boolean };
type UpdateExecution = { code: number; result: Exclude<UpdateAttemptResult, "running">; error: string | null };

function die(message: string, code = 1): never {
  console.error(`t3codectl: ${message}`);
  process.exit(code);
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) die(`invalid config line in ${path}: ${raw}`);
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function value(values: Record<string, string>, key: string, fallback: string): string {
  return values[key] ?? process.env[key] ?? fallback;
}

function resolveExecutable(command: string, fallback: string): string {
  if (command.includes("/")) return command;
  for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return fallback;
}

function loadConfig(overrides: Record<string, string> = {}): Config {
  const fileValues = parseEnvFile(CONFIG_PATH);
  const values = { ...fileValues, ...overrides };
  const user = value(values, "T3CODE_USER", process.env.USER ?? "root");
  const home = value(values, "T3CODE_HOME", homedir() + "/.t3");
  const host = value(values, "T3CODE_HOST", "127.0.0.1");
  const port = Number(value(values, "T3CODE_PORT", "3773"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) die(`invalid port: ${port}`, 2);
  const path = value(values, "T3CODE_PATH", process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin");
  const node = value(values, "T3CODE_NODE", resolveExecutable("node", "/usr/bin/node"));
  const npx = value(values, "T3CODE_NPX", resolveExecutable("npx", "/usr/bin/npx"));
  const npm = value(values, "T3CODE_NPM", resolveExecutable("npm", "/usr/bin/npm"));
  return {
    configPath: CONFIG_PATH,
    home,
    host,
    port,
    mode: value(values, "T3CODE_MODE", "web"),
    packageTag: value(values, "T3CODE_PACKAGE", "nightly"),
    node,
    npx,
    npm,
    schedule: value(values, "T3CODE_UPDATE_SCHEDULE", "hourly"),
    serviceUnit: value(values, "T3CODE_SERVICE_UNIT", DEFAULT_SERVICE_UNIT),
    updateUnit: value(values, "T3CODE_UPDATE_UNIT", DEFAULT_UPDATE_UNIT),
    timerUnit: value(values, "T3CODE_TIMER_UNIT", DEFAULT_TIMER_UNIT),
    stateDb: value(values, "T3CODE_STATE_DB", join(home, "userdata/state.sqlite")),
    idleCheck: value(values, "T3CODE_IDLE_CHECK", ""),
    lockFile: value(values, "T3CODE_LOCK_FILE", `/run/user/${process.getuid?.() ?? 0}/t3codectl-update.lock`),
    healthUrl: resolveConnectionUrl(values.T3CODE_HEALTH_URL ?? process.env.T3CODE_HEALTH_URL, fileValues.T3CODE_HOST ?? host, fileValues.T3CODE_PORT ?? String(port), host, port, "/.well-known/t3/environment"),
    baseUrl: resolveConnectionUrl(values.T3CODE_BASE_URL ?? process.env.T3CODE_BASE_URL, fileValues.T3CODE_HOST ?? host, fileValues.T3CODE_PORT ?? String(port), host, port, ""),
    path,
    user,
  };
}

function configValues(config: Config): Record<string, string> {
  return {
    T3CODE_HOME: config.home,
    T3CODE_HOST: config.host,
    T3CODE_PORT: String(config.port),
    T3CODE_MODE: config.mode,
    T3CODE_PACKAGE: config.packageTag,
    T3CODE_NODE: config.node,
    T3CODE_NPX: config.npx,
    T3CODE_NPM: config.npm,
    T3CODE_UPDATE_SCHEDULE: config.schedule,
    T3CODE_SERVICE_UNIT: config.serviceUnit,
    T3CODE_UPDATE_UNIT: config.updateUnit,
    T3CODE_TIMER_UNIT: config.timerUnit,
    T3CODE_STATE_DB: config.stateDb,
    T3CODE_IDLE_CHECK: config.idleCheck,
    T3CODE_LOCK_FILE: config.lockFile,
    T3CODE_HEALTH_URL: config.healthUrl,
    T3CODE_BASE_URL: config.baseUrl,
    T3CODE_PATH: config.path,
    T3CODE_USER: config.user,
  };
}

function writeConfig(config: Config): boolean {
  const existing = existsSync(config.configPath) ? readFileSync(config.configPath, "utf8") : undefined;
  const content = mergeManagedConfig(existing, configValues(config));
  if (content === existing) return false;
  mkdirSync(dirname(config.configPath), { recursive: true, mode: 0o755 });
  const temp = `${config.configPath}.tmp.${process.pid}`;
  writeFileSync(temp, content, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, config.configPath);
  return true;
}

function systemdEnv(config: Config): NodeJS.ProcessEnv {
  const uid = process.getuid?.() ?? 0;
  return {
    ...process.env,
    HOME: process.env.HOME ?? homedir(),
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${uid}/bus`,
    PATH: config.path,
  };
}

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string; inherit?: boolean; timeoutMs?: number } = {}): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      env: options.env ?? process.env,
      stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!options.inherit) {
      child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    }
    if (options.input !== undefined) child.stdin?.end(options.input);
    child.on("error", (error) => resolveResult({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code, signal) => resolveResult({ code: code ?? 128, stdout, stderr: signal ? `${stderr}signal=${signal}` : stderr }));
  });
}

async function systemctl(config: Config, args: string[], inherit = false): Promise<CommandResult> {
  return run("/usr/bin/systemctl", ["--user", ...args], { env: systemdEnv(config), inherit });
}

async function t3Service(config: Config, command: "install" | "update", version = config.packageTag): Promise<CommandResult> {
  const env = { ...process.env, HOME: homedir(), PATH: config.path, T3CODE_HOST: config.host, T3CODE_PORT: String(config.port), T3CODE_MODE: config.mode, npm_config_cache: join(config.home, "runtime/npm-cache") };
  return run(config.npx, ["-y", `t3@${version}`, "service", command, "--base-dir", config.home], { env, cwd: command === "install" ? homedir() : config.home, inherit: true });
}

function requireRoot(): void {
  if ((process.getuid?.() ?? 0) !== 0) die("this command must run as root", 2);
}

function validateExecutable(path: string, label: string): void {
  try { accessSync(path, constants.X_OK); } catch { die(`${label} is not executable: ${path}`); }
}

async function prerequisiteFailures(config: Config): Promise<string[]> {
  const failures: string[] = [];
  const executables = [
    [config.node, "Node"],
    [config.npx, "npx"],
    [config.npm, "npm"],
    ["/usr/bin/systemctl", "systemctl"],
    ["/usr/bin/loginctl", "loginctl"],
    ["/usr/bin/flock", "flock"],
    ["/usr/sbin/ss", "ss"],
  ] as const;
  for (const [path, label] of executables) {
    try { accessSync(path, constants.X_OK); } catch { failures.push(`${label} is not executable: ${path}`); }
  }
  validateExecutable(INSTALL_PATH, "t3codectl");

  const env = { ...process.env, PATH: config.path };
  if (!failures.some((failure) => failure.startsWith("Node "))) {
    const node = await run(config.node, ["--version"], { env });
    const version = node.stdout.trim();
    const match = version.match(/^v(\d+)\./);
    if (node.code !== 0 || !match) failures.push(`Node could not report its version (${version || node.stderr.trim() || "unknown error"})`);
    else if (Number(match[1]) < 22) failures.push(`Node 22 or newer is required (found ${version})`);
  }
  for (const [path, label] of [[config.npm, "npm"], [config.npx, "npx"]] as const) {
    if (failures.some((failure) => failure.startsWith(`${label} `))) continue;
    const result = await run(path, ["--version"], { env });
    if (result.code !== 0) failures.push(`${label} could not run (${result.stderr.trim() || "unknown error"})`);
  }
  const gh = await run("gh", ["--version"], { env: systemdEnv(config) });
  if (gh.code !== 0) failures.push(`GitHub CLI (gh) could not run (${gh.stderr.trim() || "not found in configured PATH"})`);
  return failures;
}

function writeManagedFile(path: string, content: string, mode: number): boolean {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (existing === content) return false;
  const temp = `${path}.tmp.${process.pid}`;
  writeFileSync(temp, content, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
  return true;
}

async function withProgress<T>(message: string, operation: () => Promise<T>): Promise<T> {
  console.log(message);
  const started = Date.now();
  const heartbeat = setInterval(() => {
    const elapsed = Math.floor((Date.now() - started) / 1000);
    console.log(`${message} (${elapsed}s elapsed)`);
  }, 15000);
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
  }
}

function readProcFile(pid: number, file: string): string {
  try { return readFileSync(`/proc/${pid}/${file}`, "utf8"); } catch { return ""; }
}

function processLooksLikeT3(name: string, command: string): boolean {
  const valueToCheck = `${name} ${command}`.toLowerCase();
  return valueToCheck.includes("t3code") || valueToCheck.includes("node_modules/t3/") || valueToCheck.includes("/t3/dist/");
}

async function portListeners(config: Config): Promise<PortListener[]> {
  const sockets = await run("/usr/sbin/ss", ["-H", "-ltnp"]);
  if (sockets.code !== 0) return [];
  const pids = new Set<number>();
  for (const line of sockets.stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    const localEndpoint = columns[3] ?? "";
    if (!localEndpoint.endsWith(`:${config.port}`)) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
  }
  return [...pids].map((pid) => {
    const name = readProcFile(pid, "comm").trim() || "unknown";
    const command = readProcFile(pid, "cmdline").replaceAll("\0", " ").trim() || name;
    const cgroup = readProcFile(pid, "cgroup").trim();
    const inConfiguredService = belongsToService(cgroup, config.serviceUnit);
    return { pid, name, command, cgroup, inConfiguredService, looksLikeT3: processLooksLikeT3(name, command) };
  });
}

function shortenCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ");
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function serviceUnitFromCgroup(cgroup: string): string | undefined {
  const unit = cgroup.match(/\/([A-Za-z0-9_.@:-]+\.service)$/)?.[1];
  return unit && /^[A-Za-z0-9_.@:-]+\.service$/.test(unit) ? unit : undefined;
}

function formatPortListeners(config: Config, listeners: PortListener[]): string {
  if (listeners.length === 0) return `No process is currently reported as listening on port ${config.port}.`;
  return [
    `Processes currently listening on port ${config.port}:`,
    ...listeners.map((listener) => [
      `  PID ${listener.pid}${listener.inConfiguredService ? " (configured systemd service)" : ""}${listener.looksLikeT3 ? " (looks like T3 Code)" : ""}`,
      `    command: ${shortenCommand(listener.command)}`,
      listener.cgroup ? `    cgroup: ${listener.cgroup}` : "    cgroup: unavailable",
      serviceUnitFromCgroup(listener.cgroup) ? `    systemd unit: ${serviceUnitFromCgroup(listener.cgroup)}` : "",
    ].join("\n")),
  ].join("\n");
}

async function printStartupDiagnostics(config: Config, result: HealthResult, restartFailure?: string): Promise<PortListener[]> {
  console.error(`T3 Code did not become healthy: ${result.reason}`);
  if (restartFailure) console.error(`systemd restart error: ${restartFailure}`);
  const listeners = await portListeners(config);
  console.error(formatPortListeners(config, listeners));
  const journal = await run("/usr/bin/journalctl", ["--user", "-u", config.serviceUnit, "-n", "40", "--no-pager"], { env: systemdEnv(config) });
  if (journal.stdout.trim()) console.error(`Recent ${config.serviceUnit} logs:\n${journal.stdout.trim()}`);
  else if (journal.stderr.trim()) console.error(`Could not read ${config.serviceUnit} logs: ${journal.stderr.trim()}`);
  console.error(`For more detail: journalctl --user -u ${config.serviceUnit} -n 100 --no-pager`);
  return listeners;
}

function startupFailureMessage(config: Config, result: HealthResult, restartFailure?: string): string {
  const detail = restartFailure ? `; systemd reported: ${restartFailure}` : "";
  return `T3 Code startup failed (${result.reason})${detail}. See the diagnostics above.`;
}

async function stopConflictingT3Processes(config: Config, listeners: PortListener[]): Promise<boolean> {
  const candidates = listeners.filter((listener) => listener.looksLikeT3 && !listener.inConfiguredService);
  if (candidates.length === 0) return false;
  console.error("T3 Code processes outside the configured systemd service are blocking the port:");
  for (const candidate of candidates) console.error(`  PID ${candidate.pid}: ${shortenCommand(candidate.command)}`);
  const shouldStop = await confirm({ message: "Stop these conflicting T3 Code processes and retry?", initialValue: false });
  if (isCancel(shouldStop) || !shouldStop) return false;
  await stopT3Processes(config, candidates);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  return true;
}

async function stopT3Processes(config: Config, candidates: PortListener[]): Promise<void> {
  const stoppedUnits = new Set<string>();
  for (const candidate of candidates) {
    const unit = serviceUnitFromCgroup(candidate.cgroup);
    if (unit && unit !== config.serviceUnit && !stoppedUnits.has(unit)) {
      const stopped = await systemctl(config, ["stop", unit]);
      if (stopped.code === 0) {
        stoppedUnits.add(unit);
        console.log(`stopped conflicting T3 Code systemd unit ${unit}`);
        continue;
      }
      console.error(`could not stop conflicting systemd unit ${unit}: ${stopped.stderr.trim() || `exit ${stopped.code}`}`);
    }
    try {
      process.kill(candidate.pid, "SIGTERM");
      console.log(`sent SIGTERM to conflicting T3 Code process ${candidate.pid}`);
    } catch (error) {
      console.error(`could not stop PID ${candidate.pid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function resolvePreexistingPortConflict(config: Config, options: { interactive?: boolean; stopConflicting?: boolean }): Promise<void> {
  const listeners = await portListeners(config);
  const conflicts = listeners.filter((listener) => !listener.inConfiguredService);
  if (conflicts.length === 0) return;
  console.error(`Before changing T3 Code, port ${config.port} is already occupied.`);
  console.error(formatPortListeners(config, listeners));
  const candidates = conflicts.filter((listener) => listener.looksLikeT3);
  if (candidates.length === 0) {
    die(`setup aborted before changing service configuration: another application owns port ${config.port}. Stop it or choose a different port and run setup again.`, 1);
  }
  if (options.stopConflicting) {
    await stopT3Processes(config, candidates);
  } else if (options.interactive) {
    if (!(await stopConflictingT3Processes(config, conflicts))) die("setup cancelled before changing service configuration; no processes were stopped", 1);
  } else {
    die(`setup aborted before changing service configuration: an older T3 Code process owns port ${config.port}. Run \'t3codectl repair --stop-conflicting\' after reviewing the process details above.`, 1);
  }
  const remaining = await portListeners(config);
  if (remaining.length > 0 && !remaining.some((listener) => listener.inConfiguredService)) {
    console.error(formatPortListeners(config, remaining));
    die(`port ${config.port} is still occupied; no service configuration was changed`, 1);
  }
}

async function recoverStartupFailure(config: Config, version: string | undefined, failure: HealthResult, options: { interactive: boolean; stopConflicting: boolean; restartFailure?: string }): Promise<HealthResult> {
  const listeners = await printStartupDiagnostics(config, failure, options.restartFailure);
  const candidates = listeners.filter((listener) => listener.looksLikeT3 && !listener.inConfiguredService);
  if (candidates.length === 0) {
    console.error(`No safe automatic recovery is available. If another application owns port ${config.port}, stop it or choose a different port and run setup again.`);
    return failure;
  }
  if (!options.stopConflicting && !options.interactive) {
    console.error(`To stop only these identified T3 Code processes and retry, run: t3codectl repair --stop-conflicting`);
    return failure;
  }
  if (options.stopConflicting) {
    await stopT3Processes(config, candidates);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  } else if (!(await stopConflictingT3Processes(config, listeners))) {
    console.error("Recovery cancelled; no processes were stopped.");
    return failure;
  }
  console.log("Retrying T3 Code service startup...");
  const restarted = await systemctl(config, ["restart", config.serviceUnit]);
  if (restarted.code !== 0) {
    return { ok: false, reason: `service-restart-failed: ${restarted.stderr.trim() || "systemd restart failed"}` };
  }
  const recovered = await withProgress("Waiting for T3 Code to become healthy after recovery...", () => waitForHealth(config, version));
  if (!recovered.ok) await printStartupDiagnostics(config, recovered);
  return recovered;
}

function unitDirectory(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user");
}

function unitPath(unit: string): string {
  return join(unitDirectory(), unit);
}

function dropinDirectory(unit: string): string {
  return join(unitDirectory(), `${unit}.d`);
}

function dropinPath(unit: string): string {
  return join(dropinDirectory(unit), T3CODE_DROPIN_NAME);
}

function unitSafe(valueToCheck: string): void {
  if (!valueToCheck || /[\r\n]/.test(valueToCheck)) die("configuration contains a newline or empty value", 2);
}

function quoteSystemdValue(valueToQuote: string): string {
  const escaped = valueToQuote.replaceAll("%", "%%");
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

function renderT3Dropin(config: Config): string {
  for (const item of [homedir(), config.host, config.path]) unitSafe(item);
  return `[Service]
Environment=HOME=${quoteSystemdValue(homedir())}
Environment=PATH=${quoteSystemdValue(config.path)}
Environment=T3CODE_MODE=${quoteSystemdValue(config.mode)}
Environment=T3CODE_HOST=${quoteSystemdValue(config.host)}
Environment=T3CODE_PORT=${config.port}
Environment=T3CODE_NO_BROWSER=true
`;
}

function renderUnits(config: Config): { update: string; timer: string } {
  for (const item of [config.node, config.npx, config.schedule, config.healthUrl]) unitSafe(item);
  const environment = join(config.configPath);
  const update = `[Unit]
Description=Idle-aware T3 Code updater
After=network-online.target ${config.serviceUnit}
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=${environment}
Environment=HOME=${homedir()}
Environment=XDG_RUNTIME_DIR=/run/user/${process.getuid?.() ?? 0}
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${process.getuid?.() ?? 0}/bus
Environment=PATH=${config.path}
ExecStart=${INSTALL_PATH} update
Nice=10
IOSchedulingClass=idle
UMask=0077
TimeoutStartSec=20min
`;
  const timer = `[Unit]
Description=Automatic T3 Code update check

[Timer]
OnCalendar=${config.schedule}
Persistent=true
RandomizedDelaySec=5min
AccuracySec=1min
Unit=${config.updateUnit}

[Install]
WantedBy=timers.target
`;
  return { update, timer };
}

async function applyConfiguration(config: Config, options: { interactive?: boolean; stopConflicting?: boolean; forceRestart?: boolean } = {}): Promise<void> {
  console.log("Checking host prerequisites...");
  const failures = await prerequisiteFailures(config);
  if (failures.length > 0) die(`setup prerequisites are not ready:\n${failures.map((failure) => `- ${failure}`).join("\n")}`, 2);
  await resolvePreexistingPortConflict(config, options);
  const dropin = renderT3Dropin(config);
  const units = renderUnits(config);
  const previous = readPendingConfiguration(config) ?? loadConfig();
  const service = await systemctl(config, ["show", config.serviceUnit, "-p", "LoadState", "-p", "FragmentPath"]);
  const fields = parseKeyValueOutput(service.stdout);
  if (service.code !== 0) die("could not inspect the existing T3 Code service");
  const installed = fields.LoadState === "loaded" && Boolean(fields.FragmentPath);
  if (fields.LoadState !== "loaded" && fields.LoadState !== "not-found") die(`cannot configure service in state ${fields.LoadState ?? "unknown"}`);
  const wasActive = (await systemctl(config, ["is-active", "--quiet", config.serviceUnit])).code === 0;
  if (installed && config.home !== previous.home) die("changing an installed service's T3 home requires an explicit migration; existing service left unchanged", 2);
  let configChanged = false, dropinChanged = false, updateUnitChanged = false, timerUnitChanged = false;
  const pendingRecord = readPendingRecord(config);
  const pending = pendingRecord !== null;
  const alreadyApplied = pendingRecord?.restartCompleted === true;
  const nativeRepair = needsNativeRepair(pendingRecord, options.forceRestart === true);
  const lifecycle = await configureService({
    installed,
    forceRestart: nativeRepair,
    install: async () => {
      const result = await withProgress("Installing T3 Code's native service...", () => t3Service(config, "install"));
      if (result.code !== 0) throw new Error(`T3 Code service installation failed (exit ${result.code})`);
    },
    write: async () => {
      // Record the old endpoint before writing changed server settings.
      const serverChanged = !existsSync(dropinPath(config.serviceUnit)) || readFileSync(dropinPath(config.serviceUnit), "utf8") !== dropin;
      if (wasActive && (serverChanged || (pending && !alreadyApplied) || options.forceRestart)) writePendingConfiguration(previous, { nativeRepair });
      console.log("Writing t3codectl configuration and management units...");
      configChanged = writeConfig(config);
      mkdirSync(unitDirectory(), { recursive: true, mode: 0o700 });
      mkdirSync(dropinDirectory(config.serviceUnit), { recursive: true, mode: 0o700 });
      dropinChanged = writeManagedFile(dropinPath(config.serviceUnit), dropin, 0o644);
      updateUnitChanged = writeManagedFile(unitPath(config.updateUnit), units.update, 0o644);
      timerUnitChanged = writeManagedFile(unitPath(config.timerUnit), units.timer, 0o644);
      if (dropinChanged || updateUnitChanged || timerUnitChanged) {
        const reloaded = await systemctl(config, ["daemon-reload"]);
        if (reloaded.code !== 0) throw new Error("systemd daemon-reload failed");
      }
      const enabled = await systemctl(config, ["enable", "--now", config.timerUnit]);
      if (enabled.code !== 0) throw new Error("could not enable the update timer");
      if (timerUnitChanged) {
        const restarted = await systemctl(config, ["restart", config.timerUnit]);
        if (restarted.code !== 0) throw new Error("could not apply the update timer schedule");
      }
      return { serverChanged: dropinChanged, restartPending: pending && !alreadyApplied };
    },
    active: async () => (await systemctl(config, ["is-active", "--quiet", config.serviceUnit])).code === 0,
    idle: async () => (await runtimeIdleState(previous)).state === "IDLE",
    markPending: () => writePendingConfiguration(previous, { nativeRepair }),
    start: async () => {
      const result = await systemctl(config, ["start", config.serviceUnit]);
      if (result.code !== 0) throw new Error("T3 Code service failed to start");
      writePendingConfiguration(previous, { restartCompleted: true, applied: config });
    },
    restart: async () => {
      const result = await systemctl(config, ["restart", config.serviceUnit]);
      if (result.code !== 0) throw new Error("T3 Code service failed to restart");
      writePendingConfiguration(previous, { restartCompleted: true, applied: config });
    },
    ...(nativeRepair ? { repairExisting: () => repairNativeService(config, previous) } : {}),
  });
  if (lifecycle === "deferred") {
    console.log("Server settings saved; restart pending until T3 Code is idle. The running server was left in place.");
    console.log(`configured and enabled ${config.timerUnit} (${config.schedule})`);
    return;
  }
  let restartFailure: string | undefined;
  const serviceState = readServiceState(config);
  let healthy: HealthResult = restartFailure
    ? { ok: false, reason: "service-restart-failed" }
    : await withProgress(
      "Waiting for T3 Code to become healthy...",
      () => waitForHealth(config, serviceState?.activeVersion),
    );
  if (!healthy.ok) {
    healthy = await recoverStartupFailure(config, serviceState?.activeVersion, healthy, {
      interactive: options.interactive === true,
      stopConflicting: options.stopConflicting === true,
      restartFailure,
    });
  }
  if (!healthy.ok) die(startupFailureMessage(config, healthy, restartFailure), 1);
  if (existsSync(PENDING_CONFIG_PATH)) unlinkSync(PENDING_CONFIG_PATH);
  if (!configChanged && !dropinChanged && !updateUnitChanged && !timerUnitChanged && lifecycle === "unchanged") console.log("configuration already applied; no service restart needed");
  console.log(`configured ${config.serviceUnit} through T3 Code`);
  console.log(`configured ${dropinPath(config.serviceUnit)}`);
  console.log(`configured and enabled ${config.timerUnit} (${config.schedule})`);
  console.log(`using ${INSTALL_PATH}`);
}

async function setup(args: string[]): Promise<void> {
  requireRoot();
  const overrides: Record<string, string> = {};
  const provided = new Set<string>();
  let nonInteractive = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i] ?? die(`${arg} requires a value`, 2);
    if (arg === "--home") { overrides.T3CODE_HOME = next(); provided.add("T3CODE_HOME"); }
    else if (arg === "--host") { overrides.T3CODE_HOST = next(); provided.add("T3CODE_HOST"); }
    else if (arg === "--port") { overrides.T3CODE_PORT = next(); provided.add("T3CODE_PORT"); }
    else if (arg === "--package") { overrides.T3CODE_PACKAGE = next(); provided.add("T3CODE_PACKAGE"); }
    else if (arg === "--schedule") { overrides.T3CODE_UPDATE_SCHEDULE = next(); provided.add("T3CODE_UPDATE_SCHEDULE"); }
    else if (arg === "--node") { overrides.T3CODE_NODE = next(); provided.add("T3CODE_NODE"); }
    else if (arg === "--npx") { overrides.T3CODE_NPX = next(); provided.add("T3CODE_NPX"); }
    else if (arg === "--npm") { overrides.T3CODE_NPM = next(); provided.add("T3CODE_NPM"); }
    else if (arg === "--path") { overrides.T3CODE_PATH = next(); provided.add("T3CODE_PATH"); }
    else if (arg === "--non-interactive") nonInteractive = true;
    else if (arg === "--help") { printHelp(); return; }
    else die(`unknown setup option: ${arg}`, 2);
  }
  let config = loadConfig(overrides);
  const configFileValues = parseEnvFile(CONFIG_PATH);
  const hasConfiguredHost = Boolean(overrides.T3CODE_HOST ?? configFileValues.T3CODE_HOST ?? process.env.T3CODE_HOST);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !nonInteractive;
  if (!interactive) {
    if (!hasConfiguredHost) die("setup requires --host when no interactive terminal is available", 2);
  } else {
    intro("T3 Code setup");
    const guided: Record<string, string> = {};
    if (!provided.has("T3CODE_HOME")) guided.T3CODE_HOME = await promptText("Where should T3 Code store its home?", config.home, (valueToCheck) => valueToCheck.trim() ? undefined : "A T3 Code home is required");
    if (!provided.has("T3CODE_HOST")) guided.T3CODE_HOST = await promptText("What hostname or IP should T3 Code listen on?", hasConfiguredHost ? config.host : undefined, (valueToCheck) => {
      if (!valueToCheck.trim()) return "A reachable hostname or IP is required";
      if (/\s|[\r\n/]/.test(valueToCheck)) return "Enter a hostname or IP address, without a scheme or path";
      return undefined;
    });
    if (!provided.has("T3CODE_PORT")) guided.T3CODE_PORT = await promptText("Which port should T3 Code use?", String(config.port), (valueToCheck) => {
      const port = Number(valueToCheck);
      return Number.isInteger(port) && port >= 1 && port <= 65535 ? undefined : "Enter a port from 1 to 65535";
    });
    if (!provided.has("T3CODE_PACKAGE")) {
      const packageChoices = [
        { value: "latest", label: "Stable (latest)" },
        { value: "nightly", label: "Nightly", hint: "latest development build" },
        ...(config.packageTag !== "latest" && config.packageTag !== "nightly" ? [{ value: config.packageTag, label: config.packageTag, hint: "current configuration" }] : []),
      ];
      guided.T3CODE_PACKAGE = promptValue(await select({ message: "Which T3 Code release channel should updates use?", options: packageChoices, initialValue: packageChoices.some((option) => option.value === config.packageTag) ? config.packageTag : "nightly" }));
    }
    if (!provided.has("T3CODE_UPDATE_SCHEDULE")) guided.T3CODE_UPDATE_SCHEDULE = await promptText("When should updates run?", config.schedule, (valueToCheck) => valueToCheck.trim() ? undefined : "An update schedule is required");
    config = loadConfig({ ...overrides, ...guided });
    note([
      `T3 Code home: ${config.home}`,
      `Listen address: ${config.host}:${config.port}`,
      `Release channel: ${config.packageTag}`,
      `Update schedule: ${config.schedule}`,
      "",
      "Existing services will be reconfigured; missing services will be installed.",
      "t3codectl will install the updater timer and service drop-in.",
    ].join("\n"), "Configuration");
    const proceed = promptValue(await confirm({ message: "Apply this configuration?", initialValue: true }));
    if (!proceed) cancelSetup();
  }
  await withConfigurationLock(config.lockFile, () => applyConfiguration(config, { interactive }));
  if (interactive) outro("T3 Code setup complete");
}

async function repair(args: string[]): Promise<void> {
  requireRoot();
  if (args.includes("--help")) { printHelp(); return; }
  const stopConflicting = args.includes("--stop-conflicting");
  const nonInteractive = args.includes("--non-interactive");
  if (args.some((arg) => !["--stop-conflicting", "--non-interactive"].includes(arg))) die(`unknown repair option: ${args.find((arg) => !["--stop-conflicting", "--non-interactive"].includes(arg))}`, 2);
  const configFileValues = parseEnvFile(CONFIG_PATH);
  if (!configFileValues.T3CODE_HOST && !process.env.T3CODE_HOST) die("no existing T3 Code configuration found; run `t3codectl setup` first", 2);
  console.log("Repairing the existing T3 Code installation...");
  const config = loadConfig();
  await withConfigurationLock(config.lockFile, () => applyConfiguration(config, { interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) && !nonInteractive, stopConflicting, forceRestart: true }));
  console.log("T3 Code repair configuration applied");
}

function promptValue<T>(valueToCheck: T | symbol): T {
  if (isCancel(valueToCheck)) cancelSetup();
  return valueToCheck as T;
}

async function promptText(message: string, initialValue: string | undefined, validate: (valueToCheck: string) => string | undefined): Promise<string> {
  return promptValue(await text({ message, ...(initialValue === undefined ? {} : { initialValue }), validate }));
}

function cancelSetup(): never {
  cancel("Setup cancelled.");
  process.exit(0);
}

function parseKeyValueOutput(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

function readServiceState(config: Config): { activeVersion: string; updateStatus: string } | null {
  const path = join(config.home, "runtime/service-state.json");
  try {
    return parseServiceState(readFileSync(path, "utf8"));
  } catch { return null; }
}

async function latestVersion(config: Config): Promise<string> {
  const result = await run(config.npm, ["view", `t3@${config.packageTag}`, "version", "--json"], { env: { ...process.env, PATH: config.path } });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "npm view failed");
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error("npm view returned invalid JSON"); }
  if (typeof parsed !== "string" || !VERSION_RE.test(parsed)) throw new Error("package tag did not resolve to an exact SemVer");
  return parsed;
}

function compareVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const noBuild = version.split("+", 1)[0];
    const separator = noBuild.indexOf("-");
    const core = (separator < 0 ? noBuild : noBuild.slice(0, separator)).split(".").map(BigInt);
    const pre = separator < 0 ? [] : noBuild.slice(separator + 1).split(".");
    return { core, pre };
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

async function health(config: Config, expectedVersion?: string): Promise<HealthResult> {
  const active = await systemctl(config, ["is-active", "--quiet", config.serviceUnit]);
  if (active.code !== 0) return { ok: false, reason: "service-inactive" };
  const state = readServiceState(config);
  if (!state) return { ok: false, reason: "invalid-or-missing-service-state" };
  if (expectedVersion && state.activeVersion !== expectedVersion) return { ok: false, reason: `active-version=${state.activeVersion}` };
  if (state.updateStatus === "pending") return { ok: false, reason: "update-pending" };
  const control = await systemctl(config, ["show", config.serviceUnit, "-p", "ControlGroup", "--value"]);
  const cgroup = control.stdout.trim();
  if (control.code !== 0 || !cgroup) return { ok: false, reason: "missing-service-cgroup" };
  const sockets = await run("/usr/sbin/ss", ["-H", "-ltnp"]);
  if (sockets.code !== 0) return { ok: false, reason: "socket-inspection-failed" };
  const pids = new Set<string>();
  for (const line of sockets.stdout.split(/\r?\n/)) {
    if (!line.includes(`:${config.port}`)) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) pids.add(match[1]);
  }
  if (pids.size === 0) return { ok: false, reason: "port-not-listening" };
  for (const pid of pids) {
    try {
      const groups = readFileSync(`/proc/${pid}/cgroup`, "utf8");
      if (!groups.split(/\r?\n/).some((line) => line.endsWith(`:${cgroup}`))) return { ok: false, reason: `listener-outside-service-cgroup=${pid}` };
    } catch { return { ok: false, reason: `listener-process-unreadable=${pid}` }; }
  }
  try {
    const response = await fetch(config.healthUrl, { headers: { Host: `${config.host}:${config.port}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { ok: false, reason: `health-http=${response.status}` };
  } catch (error) { return { ok: false, reason: `health-request=${error instanceof Error ? error.message : String(error)}` }; }
  const runtimePath = join(config.home, "userdata/server-runtime.json");
  try {
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as { host?: string; port?: number; origin?: string };
    if (runtime.host !== config.host || runtime.port !== config.port || runtime.origin !== `http://${config.host}:${config.port}`) return { ok: false, reason: "server-runtime-mismatch" };
  } catch { return { ok: false, reason: "missing-or-invalid-server-runtime" }; }
  return { ok: true, reason: "healthy" };
}

async function timerStatus(config: Config): Promise<Record<string, string>> {
  const result = await systemctl(config, ["show", config.timerUnit, "-p", "ActiveState", "-p", "NextElapseUSecRealtime", "-p", "LastTriggerUSec"]);
  return result.code === 0 ? parseKeyValueOutput(result.stdout) : { ActiveState: "not-found" };
}

async function status(args: string[]): Promise<void> {
  const json = args.includes("--json");
  if (args.some((arg) => arg !== "--json" && arg !== "--help")) die(`unknown status option: ${args.find((arg) => arg !== "--json" && arg !== "--help")}`, 2);
  if (args.includes("--help")) { printHelp(); return; }
  const config = loadConfig();
  const state = readServiceState(config);
  const timer = await timerStatus(config);
  const service = await systemctl(config, ["show", config.serviceUnit, "-p", "ActiveState", "-p", "SubState", "-p", "MainPID", "-p", "ExecMainStartTimestamp"]);
  const updateService = await systemctl(config, ["show", config.updateUnit, "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus"]);
  const serviceFields = parseKeyValueOutput(service.stdout);
  const updateServiceFields = parseKeyValueOutput(updateService.stdout);
  let latest: string | null = null;
  let latestError: string | null = null;
  try { latest = await latestVersion(config); } catch (error) { latestError = error instanceof Error ? error.message : String(error); }
  const serviceHealth = await health(config);
  const listeners = serviceHealth.ok ? [] : await portListeners(config);
  const trackedUpdate = readUpdateAttempt(UPDATE_STATE_PATH);
  const legacyAttempt = timer.LastTriggerUSec && timer.LastTriggerUSec !== "n/a" ? timer.LastTriggerUSec : null;
  const systemdFailure = updateServiceFields.Result && updateServiceFields.Result !== "success"
    ? `systemd result: ${updateServiceFields.Result}${updateServiceFields.ExecMainStatus ? `, exit status ${updateServiceFields.ExecMainStatus}` : ""}`
    : null;
  let lastUpdate: { startedAt: string | null; finishedAt: string | null; result: string; error: string | null } = trackedUpdate
    ? {
      startedAt: trackedUpdate.startedAt,
      finishedAt: trackedUpdate.finishedAt,
      result: trackedUpdate.result,
      error: trackedUpdate.error,
    }
    : {
      startedAt: legacyAttempt,
      finishedAt: null,
      result: legacyAttempt ? (systemdFailure ? "failed" : "unknown") : "never",
      error: legacyAttempt ? (systemdFailure ?? "attempt predates detailed update tracking; inspect the systemd journal") : null,
    };
  const updaterRunning = ["active", "activating", "reloading"].includes(updateServiceFields.ActiveState ?? "");
  if (trackedUpdate?.result === "running" && updateService.code === 0 && !updaterRunning) {
    lastUpdate = {
      ...lastUpdate,
      result: "failed",
      error: `update process ended before recording a result${systemdFailure ? ` (${systemdFailure})` : "; inspect the systemd journal"}`,
    };
  }
  const result = {
    service: config.serviceUnit,
    active: serviceFields.ActiveState === "active" && serviceFields.SubState === "running",
    health: serviceHealth.ok,
    healthReason: serviceHealth.reason,
    pid: serviceFields.MainPID ? Number(serviceFields.MainPID) : null,
    started: serviceFields.ExecMainStartTimestamp || null,
    runningVersion: state?.activeVersion ?? null,
    updateStatus: state?.updateStatus ?? null,
    latestVersion: latest,
    latestError,
    portListeners: listeners,
    updateTimer: {
      unit: config.timerUnit,
      state: timer.ActiveState ?? "unknown",
      schedule: config.schedule,
      next: timer.NextElapseUSecRealtime ?? null,
      last: timer.LastTriggerUSec ?? null,
    },
    lastUpdate,
  };
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(renderStatus(result));
    if (!result.health) {
      console.log(formatPortListeners(config, listeners));
      console.log("next: t3codectl repair (or t3codectl repair --stop-conflicting if an old T3 Code process owns the port)");
    }
  }
  if (!result.health) process.exitCode = 1;
}

async function pair(args: string[]): Promise<void> {
  if (args.includes("--help")) { printHelp(); return; }
  let baseUrl: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url") baseUrl = args[++i] ?? die("--base-url requires a value", 2);
    else die(`unknown pair option: ${args[i]}`, 2);
  }
  const config = loadConfig();
  const active = await systemctl(config, ["is-active", "--quiet", config.serviceUnit]);
  if (active.code !== 0) die("T3 Code service is not active; run `t3codectl repair`");
  const state = readServiceState(config);
  if (!state) die("service state is missing or invalid");
  const target = baseUrl ?? config.baseUrl;
  try {
    const parsed = new URL(target);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("base URL must use http or https");
  } catch (error) {
    die(`invalid base URL: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  const env = { ...process.env, HOME: homedir(), PATH: config.path, npm_config_cache: join(config.home, "runtime/npm-cache") };
  const result = await run(config.npx, ["-y", `t3@${state.activeVersion}`, "auth", "pairing", "create", "--base-dir", config.home, "--base-url", target, "--json", "--log-level", "none"], { env, cwd: config.home });
  if (result.code !== 0) die(result.stderr.trim() || "T3 Code pairing failed");
  let output: unknown;
  try { output = JSON.parse(result.stdout); } catch { die("T3 Code pairing returned invalid JSON"); }
  if (!output || typeof output !== "object" || typeof (output as { pairUrl?: unknown }).pairUrl !== "string") die("T3 Code did not return a pairing URL");
  console.log((output as { pairUrl: string }).pairUrl);
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${Number(value.toFixed(2))} ${unit}`;
}

function capacitySufficient(config: Config): { ok: boolean; error: string | null } {
  try {
    const fs = statfsSync(config.home);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    const freeInodes = Number(fs.ffree);
    const failures: string[] = [];
    if (freeBytes < MIN_FREE_BYTES) failures.push(`disk space: ${formatBytes(freeBytes)} available, ${formatBytes(MIN_FREE_BYTES)} required`);
    if (freeInodes < MIN_FREE_INODES) failures.push(`inodes: ${freeInodes.toLocaleString("en-US")} available, ${MIN_FREE_INODES.toLocaleString("en-US")} required`);
    if (failures.length > 0) {
      return { ok: false, error: `insufficient capacity (${failures.join("; ")})` };
    }
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: "unable to inspect filesystem capacity" };
  }
}

async function reconcile(config: Config, cliVersion: string, targetVersion: string, allowDowngrade = false): Promise<number> {
  const env = {
    ...process.env,
    HOME: homedir(),
    PATH: config.path,
    npm_config_cache: join(config.home, "runtime/npm-cache"),
    NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? "1",
  };
  const args = ["-y", `t3@${cliVersion}`, "update", targetVersion, "--base-dir", config.home, "--yes"];
  if (allowDowngrade) args.push("--allow-downgrade");
  const result = await run(config.npx, args, { env, cwd: config.home, inherit: true });
  return result.code;
}

function pruneRuntimeVersions(config: Config, activeVersion: string): void {
  const versionsDir = resolve(config.home, "runtime/versions");
  if (!existsSync(versionsDir)) return;
  const candidates = readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && VERSION_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => compareVersions(right, left));
  const keep = new Set([activeVersion, ...candidates.slice(0, 2)]);
  for (const version of candidates) {
    if (keep.has(version)) continue;
    const target = resolve(versionsDir, version);
    if (dirname(target) !== versionsDir) die("refusing to prune a path outside the runtime versions directory");
    rmSync(target, { recursive: true, force: true });
    console.log(`pruned old T3 Code runtime: ${version}`);
  }
  const cache = join(config.home, "runtime/npm-cache");
  const result = spawnSync(config.npm, ["cache", "clean", "--force"], { env: { ...process.env, HOME: homedir(), PATH: config.path, npm_config_cache: cache }, encoding: "utf8" });
  if (result.status !== 0) console.error("t3codectl: warning: npm cache cleanup failed");
}

async function waitForHealth(config: Config, version?: string): Promise<HealthResult> {
  let last: HealthResult = { ok: false, reason: "health-check-not-run" };
  let previousReason = "";
  for (let attempt = 0; attempt < 18; attempt++) {
    last = await health(config, version);
    if (last.ok) return last;
    if (last.reason !== previousReason) {
      console.log(`health check: ${last.reason}`);
      previousReason = last.reason;
    }
    if (last.reason === "service-inactive" && attempt >= 1) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
  }
  return last;
}

function updateExecution(code: number, result: UpdateExecution["result"], error: string | null = null): UpdateExecution {
  return { code, result, error };
}

function persistUpdateAttempt(attempt: UpdateAttempt): void {
  try {
    writeUpdateAttempt(UPDATE_STATE_PATH, attempt);
  } catch (error) {
    console.error(`t3codectl: warning: unable to record update status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function installedCli(): boolean {
  try { return resolve(process.execPath) === INSTALL_PATH; } catch { return false; }
}

async function updateCli(config: Config): Promise<"current" | "updated"> {
  const result = await selfUpdate({
    installPath: INSTALL_PATH,
    currentVersion: `v${packageJson.version}`,
    runGh: (args) => run("gh", args, { env: systemdEnv(config) }),
  });
  console.log(result === "updated" ? `t3codectl updated to the latest release` : `t3codectl is current (v${packageJson.version})`);
  return result;
}

async function selfUpdateCommand(args: string[]): Promise<void> {
  if (args.includes("--help")) { printHelp(); return; }
  if (args.some((arg) => arg !== "--internal-locked")) die(`unknown self-update option: ${args.find((arg) => arg !== "--internal-locked")}`, 2);
  requireRoot();
  if (!installedCli()) die(`self-update requires the installed executable at ${INSTALL_PATH}`, 2);
  const config = loadConfig();
  if (args.includes("--internal-locked")) { await updateCli(config); return; }
  mkdirSync(dirname(config.lockFile), { recursive: true, mode: 0o700 });
  const result = await run("/usr/bin/flock", ["-n", "-E", "75", config.lockFile, INSTALL_PATH, "self-update", "--internal-locked"], { env: systemdEnv(config), inherit: true });
  if (result.code === 75) console.error("t3codectl: another update is already running");
  process.exitCode = result.code;
}

function writePendingConfiguration(previous: Config, phase: PendingPhase<Config> = {}): void {
  writePending(PENDING_CONFIG_PATH, previous, phase);
}

function readPendingRecord(config: Config) {
  return readPending(PENDING_CONFIG_PATH, config);
}

function readPendingConfiguration(config: Config): Config | null {
  return pendingConnection(readPendingRecord(config));
}

async function repairNativeService(config: Config, previous: Config): Promise<void> {
  const state = readServiceState(previous);
  if (!state) throw new Error("cannot repair native service without a valid installed runtime");
  writePendingConfiguration(previous, { nativeRepair: true });
  const stopped = await systemctl(config, ["stop", config.serviceUnit]);
  if (stopped.code !== 0) throw new Error("could not stop the idle service for native repair");
  const result = await withProgress("Repairing the installed native T3 Code service...", () => t3Service(config, "install", state.activeVersion));
  if (result.code !== 0) throw new Error("native T3 Code service repair failed");
  writePendingConfiguration(previous, { restartCompleted: true, applied: config });
}

async function runtimeIdleState(config: Config) {
  return existsSync(join(dirname(config.stateDb), "statev2.sqlite"))
    ? withT3Client(config, async (client) => readSnapshotIdleState(await client.get("/api/orchestration/shell")))
    : readIdleState(config.stateDb);
}

async function applyPendingConfiguration(config: Config): Promise<Config> {
  const previous = readPendingConfiguration(config);
  if (!previous) return config;
  const record = readPendingRecord(config)!;
  if (record.restartCompleted === true) {
    if (renderT3Dropin(record.applied!) !== renderT3Dropin(config)) throw new Error("server settings changed after restart; run setup again");
    const verified = await waitForHealth(record.applied!);
    if (!verified.ok) throw new Error(`pending server configuration failed verification: ${verified.reason}`);
    unlinkSync(PENDING_CONFIG_PATH);
    return config;
  }
  const stoppedForRepair = record.nativeRepair && (await systemctl(config, ["is-active", "--quiet", config.serviceUnit])).code !== 0;
  const idle = stoppedForRepair ? { state: "IDLE", detail: "native repair service stopped" } : await runtimeIdleState(previous);
  if (idle.state !== "IDLE") {
    console.log(`server configuration restart deferred: ${idle.detail}`);
    return previous;
  }
  if (readFileSync(dropinPath(config.serviceUnit), "utf8") !== renderT3Dropin(config)) throw new Error("pending server settings differ from configuration; run setup again");
  await resolvePreexistingPortConflict(config, { interactive: false });
  if (record.nativeRepair) await repairNativeService(config, previous);
  else {
    const result = await systemctl(config, ["restart", config.serviceUnit]);
    if (result.code !== 0) throw new Error("pending server configuration restart failed");
    writePendingConfiguration(previous, { restartCompleted: true, applied: config });
  }
  const verified = await waitForHealth(config);
  if (!verified.ok) throw new Error(`pending server configuration failed verification: ${verified.reason}`);
  unlinkSync(PENDING_CONFIG_PATH);
  console.log("pending server configuration applied");
  return config;
}

async function updateLocked(config: Config): Promise<UpdateExecution> {
  const active = await systemctl(config, ["is-active", "--quiet", config.serviceUnit]);
  if (active.code !== 0) {
    const error = "T3 Code service is not active; run `t3codectl repair`";
    console.error(`t3codectl: update refused: ${error}`);
    return updateExecution(1, "failed", error);
  }
  const capacity = capacitySufficient(config);
  if (!capacity.ok) {
    console.error(`t3codectl: update deferred: ${capacity.error}`);
    return updateExecution(0, "deferred", capacity.error);
  }
  let target: string;
  try {
    target = await latestVersion(config);
  } catch (error) {
    const detail = `unable to resolve latest version: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`t3codectl: ${detail}`);
    return updateExecution(1, "failed", detail);
  }
  const before = readServiceState(config);
  if (!before) {
    const error = "service state is missing or invalid";
    console.error(`t3codectl: update refused: ${error}`);
    return updateExecution(1, "failed", error);
  }
  if (before.updateStatus === "pending") {
    const error = "T3 Code reports a pending update";
    console.error(`t3codectl: update refused: ${error}`);
    return updateExecution(1, "failed", error);
  }
  if (before.activeVersion === target) {
    console.log(`already up to date: ${target}`);
    return updateExecution(0, "up-to-date");
  }
  if (compareVersions(target, before.activeVersion) !== 1) {
    const error = `refusing non-forward update (${before.activeVersion} → ${target})`;
    console.error(`t3codectl: ${error}`);
    return updateExecution(1, "failed", error);
  }
  const idleResult = await runtimeIdleState(config);
  console.log(`idle check: ${idleResult.detail}`);
  if (idleResult.state === "BUSY") {
    const error = `T3 Code is busy (${idleResult.detail})`;
    console.log(`update deferred: ${error}`);
    return updateExecution(0, "deferred", error);
  }
  if (idleResult.state !== "IDLE") {
    const error = `idle state is unknown (${idleResult.detail})`;
    console.error(`t3codectl: update refused: ${error}`);
    return updateExecution(1, "failed", error);
  }
  const recheck = readServiceState(config);
  if (!recheck || recheck.activeVersion !== before.activeVersion || recheck.updateStatus !== before.updateStatus) {
    const error = "service state changed during idle check";
    console.error(`t3codectl: update refused: ${error}`);
    return updateExecution(1, "failed", error);
  }
  console.log(`updating T3 Code: ${before.activeVersion} → ${target}`);
  const updateCode = await reconcile(config, target, target);
  let verification: HealthResult = { ok: false, reason: `update command failed (exit ${updateCode})` };
  if (updateCode === 0) verification = await waitForHealth(config, target);
  if (updateCode === 0 && verification.ok) {
    pruneRuntimeVersions(config, target);
    console.log(`update complete: ${target}`);
    return updateExecution(0, "updated");
  }
  if (updateCode !== 0) {
    const afterFailure = readServiceState(config);
    const unchangedHealth = afterFailure?.activeVersion === before.activeVersion
      ? await health(config, before.activeVersion)
      : { ok: false, reason: "active-version-changed" };
    if (unchangedHealth.ok) {
      const error = `${verification.reason}; active runtime was unchanged and is still running ${before.activeVersion}`;
      console.error(`t3codectl: ${error}`);
      return updateExecution(1, "failed", error);
    }
  }
  console.error(`t3codectl: update failed: ${verification.reason}; attempting rollback`);
  if (updateCode === 0) await printStartupDiagnostics(config, verification);
  const rollbackCode = await reconcile(config, target, before.activeVersion, true);
  let rollbackVerification: HealthResult = { ok: false, reason: `rollback command failed (exit ${rollbackCode})` };
  if (rollbackCode === 0) rollbackVerification = await waitForHealth(config, before.activeVersion);
  if (rollbackCode === 0 && rollbackVerification.ok) {
    const error = `update failed: ${verification.reason}; rollback complete; still running ${before.activeVersion}`;
    console.error(`t3codectl: ${error}`);
    return updateExecution(1, "failed", error);
  }
  const error = `update failed: ${verification.reason}; rollback failed: ${rollbackVerification.reason}; manual intervention required`;
  console.error(`t3codectl: ${error}`);
  if (rollbackCode === 0) await printStartupDiagnostics(config, rollbackVerification);
  return updateExecution(1, "failed", error);
}

async function withT3Client<T>(config: Config, action: (client: T3Client) => Promise<T>): Promise<T> {
  const state = readServiceState(config);
  if (!state || state.updateStatus === "pending") throw new Error("T3 runtime is unavailable or updating");
  // Use the installed runtime: recovery must not require npm or a model call.
  const cli = join(config.home, "runtime/versions", state.activeVersion, "t3");
  if (!existsSync(cli)) throw new Error("installed T3 CLI is unavailable");
  const auth = await run(cli, ["auth", "session", "issue", "--base-dir", config.home, "--label", "t3codectl-recovery", "--ttl", "5m", "--json"], { env: systemdEnv(config), timeoutMs: 30000 });
  if (auth.code !== 0) throw new Error("could not issue a T3 recovery credential");
  let credential: { token: string; sessionId: string };
  try { credential = JSON.parse(auth.stdout); } catch { throw new Error("invalid T3 credential response"); }
  if (typeof credential?.token !== "string" || typeof credential?.sessionId !== "string") throw new Error("invalid T3 credential fields");
  let client: T3Client | undefined;
  try {
    client = new T3Client(config.baseUrl, credential.token);
    return await action(client);
  } finally {
    client?.close();
    const revoked = await run(cli, ["auth", "session", "revoke", "--base-dir", config.home, credential.sessionId], { env: systemdEnv(config), timeoutMs: 30000 });
    if (revoked.code !== 0) console.error("t3codectl: recovery credential revocation failed; it expires within five minutes");
  }
}

async function recoverCapacityFailures(config: Config): Promise<void> {
  const result = await withT3Client(config, (client) => recoverThreads({ client, statePath: RECOVERY_STATE_PATH }));
  if (result.errors) process.exitCode = 1;
}

async function update(args: string[]): Promise<void> {
  if (args.includes("--help")) { printHelp(); return; }
  const internal = args.includes("--internal-locked");
  if (args.some((arg) => arg !== "--internal-locked")) die(`unknown update option: ${args.find((arg) => arg !== "--internal-locked")}`, 2);
  let config = loadConfig();
  if (internal) {
    const attempt: UpdateAttempt = { protocol: 1, startedAt: new Date().toISOString(), finishedAt: null, result: "running", error: null };
    persistUpdateAttempt(attempt);
    try {
      config = await applyPendingConfiguration(config);
      const execution = await updateLocked(config);
      persistUpdateAttempt({ ...attempt, finishedAt: new Date().toISOString(), result: execution.result, error: execution.error });
      process.exitCode = execution.code;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      persistUpdateAttempt({ ...attempt, finishedAt: new Date().toISOString(), result: "failed", error: detail });
      process.exitCode = 1;
      console.error(`t3codectl: update failed: ${detail}`);
    }
    try {
      await recoverCapacityFailures(readPendingConfiguration(config) ?? config);
    } catch (error) {
      console.error(`t3codectl: recovery sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    if (installedCli()) {
      try {
        await updateCli(config);
      } catch (error) {
        console.error(`t3codectl: self-update failed; will retry at the next scheduled run: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return;
  }
  mkdirSync(dirname(config.lockFile), { recursive: true, mode: 0o700 });
  const entry = process.argv[1];
  const bundledBun = process.versions.bun !== undefined && entry?.startsWith("/$bunfs/");
  const invocation = bundledBun
    ? { command: process.execPath, args: [] }
    : entry && existsSync(entry)
    ? { command: process.execPath, args: [entry] }
    : { command: process.execPath, args: [] };
  const result = await run("/usr/bin/flock", ["-n", "-E", "75", config.lockFile, invocation.command, ...invocation.args, "update", "--internal-locked"], { env: systemdEnv(config), inherit: true });
  if (result.code === 75) {
    console.log("update deferred: another update is already running");
    process.exitCode = 0;
  } else process.exitCode = result.code;
}

async function uninstall(args: string[]): Promise<void> {
  requireRoot();
  if (args.includes("--help")) { printHelp(); return; }
  const yes = args.includes("--yes");
  if (args.some((arg) => arg !== "--yes")) die(`unknown uninstall option: ${args.find((arg) => arg !== "--yes")}`, 2);
  if (!yes) {
    console.error("This removes the T3 Code systemd units and t3codectl configuration, but never T3 Code data.");
    console.error("Re-run with --yes to continue.");
    return;
  }
  const config = loadConfig();
  for (const unit of [config.timerUnit, config.updateUnit]) {
    await systemctl(config, ["disable", "--now", unit]);
  }
  await systemctl(config, ["daemon-reload"]);
  const allowed = [unitPath(config.timerUnit), unitPath(config.updateUnit), dropinPath(config.serviceUnit), config.configPath, UPDATE_STATE_PATH, RECOVERY_STATE_PATH, PENDING_CONFIG_PATH, INSTALL_PATH];
  for (const path of allowed) if (existsSync(path)) unlinkSync(path);
  console.log("removed t3codectl updater units, service drop-in, and configuration");
  console.log(`left ${config.serviceUnit} under T3 Code ownership`);
  console.log(`preserved T3 Code data at ${config.home}`);
}

function printHelp(): void {
  console.log(`Usage: t3codectl <command> [options]

Commands:
  setup       Install the CLI, configure systemd, and enable hourly updates
  repair      Reconcile the existing installation and restart T3 Code
  status      Show service health, versions, update schedule, and last attempt
  pair        Generate a fresh T3 Code pairing URL
  update      Update when idle and recover provider capacity failures
  self-update Update the t3codectl executable from its latest GitHub release
  uninstall   Remove management units and config; never removes T3 Code data

Options:
  status --json
  setup [--non-interactive] [--home PATH] [--host HOST] [--port PORT] [--package TAG] [--schedule CALENDAR] [--path PATH]
  repair [--stop-conflicting] [--non-interactive]
  pair --base-url URL
  uninstall --yes
`);
}

async function main(): Promise<void> {
  const bundledBun = process.versions.bun !== undefined && process.argv[1]?.startsWith("/$bunfs/");
  const [command = "help", ...args] = process.argv.slice(bundledBun ? 2 : 1);
  if (command === "help" || command === "--help" || command === "-h") { printHelp(); return; }
  if (command === "--version" || command === "-V") { console.log(`t3codectl v${packageJson.version}`); return; }
  if (command === "setup") return setup(args);
  if (command === "repair") return repair(args);
  if (command === "status") return status(args);
  if (command === "pair") return pair(args);
  if (command === "update") return update(args);
  if (command === "self-update") return selfUpdateCommand(args);
  if (command === "uninstall") return uninstall(args);
  die(`unknown command: ${command}`, 2);
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)));
