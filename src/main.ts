#!/usr/bin/node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, accessSync, constants, mkdirSync, readFileSync, renameSync, statfsSync, unlinkSync, writeFileSync, chmodSync, copyFileSync, realpathSync, readdirSync, rmSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = process.env.T3CODECTL_CONFIG ?? "/etc/t3codectl/config.env";
const INSTALL_PATH = "/usr/local/bin/t3codectl";
const DEFAULT_SERVICE_UNIT = "t3code.service";
const DEFAULT_UPDATE_UNIT = "t3codectl-update.service";
const DEFAULT_TIMER_UNIT = "t3codectl-update.timer";
const T3CODE_DROPIN_NAME = "10-t3codectl.conf";
const VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

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
  sqlite3: string;
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

function loadConfig(overrides: Record<string, string> = {}): Config {
  const fileValues = parseEnvFile(CONFIG_PATH);
  const values = { ...fileValues, ...overrides };
  const user = value(values, "T3CODE_USER", process.env.USER ?? "root");
  const home = value(values, "T3CODE_HOME", homedir() + "/.t3");
  const host = value(values, "T3CODE_HOST", "127.0.0.1");
  const port = Number(value(values, "T3CODE_PORT", "3773"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) die(`invalid port: ${port}`, 2);
  const node = value(values, "T3CODE_NODE", "/usr/bin/node");
  const npx = value(values, "T3CODE_NPX", "/usr/bin/npx");
  const npm = value(values, "T3CODE_NPM", "/usr/bin/npm");
  const sqlite3 = value(values, "T3CODE_SQLITE3", "/usr/bin/sqlite3");
  const path = value(values, "T3CODE_PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin");
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
    sqlite3,
    schedule: value(values, "T3CODE_UPDATE_SCHEDULE", "*-*-* 03:00:00"),
    serviceUnit: value(values, "T3CODE_SERVICE_UNIT", DEFAULT_SERVICE_UNIT),
    updateUnit: value(values, "T3CODE_UPDATE_UNIT", DEFAULT_UPDATE_UNIT),
    timerUnit: value(values, "T3CODE_TIMER_UNIT", DEFAULT_TIMER_UNIT),
    stateDb: value(values, "T3CODE_STATE_DB", join(home, "userdata/state.sqlite")),
    idleCheck: value(values, "T3CODE_IDLE_CHECK", ""),
    lockFile: value(values, "T3CODE_LOCK_FILE", `/run/user/${process.getuid?.() ?? 0}/t3codectl-update.lock`),
    healthUrl: value(values, "T3CODE_HEALTH_URL", `http://${host}:${port}/.well-known/t3/environment`),
    baseUrl: value(values, "T3CODE_BASE_URL", `http://${host}:${port}`),
    path,
    user,
  };
}

function writeConfig(config: Config): void {
  mkdirSync(dirname(config.configPath), { recursive: true, mode: 0o755 });
  const content = [
    "# Managed by t3codectl. Values are deployment configuration, not T3 Code data.",
    `T3CODE_HOME=${config.home}`,
    `T3CODE_HOST=${config.host}`,
    `T3CODE_PORT=${config.port}`,
    `T3CODE_MODE=${config.mode}`,
    `T3CODE_PACKAGE=${config.packageTag}`,
    `T3CODE_NODE=${config.node}`,
    `T3CODE_NPX=${config.npx}`,
    `T3CODE_NPM=${config.npm}`,
    `T3CODE_SQLITE3=${config.sqlite3}`,
    `T3CODE_UPDATE_SCHEDULE=${config.schedule}`,
    `T3CODE_SERVICE_UNIT=${config.serviceUnit}`,
    `T3CODE_UPDATE_UNIT=${config.updateUnit}`,
    `T3CODE_TIMER_UNIT=${config.timerUnit}`,
    `T3CODE_STATE_DB=${config.stateDb}`,
    `T3CODE_LOCK_FILE=${config.lockFile}`,
    `T3CODE_HEALTH_URL=${config.healthUrl}`,
    `T3CODE_BASE_URL=${config.baseUrl}`,
    `T3CODE_PATH=${config.path}`,
    `T3CODE_USER=${config.user}`,
    "",
  ].join("\n");
  const temp = `${config.configPath}.tmp.${process.pid}`;
  writeFileSync(temp, content, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, config.configPath);
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

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string; inherit?: boolean } = {}): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
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
  const env = { ...process.env, HOME: homedir(), PATH: config.path, npm_config_cache: join(config.home, "runtime/npm-cache") };
  return run(config.npx, ["-y", `t3@${version}`, "service", command, "--base-dir", config.home], { env, cwd: command === "install" ? homedir() : config.home, inherit: true });
}

function requireRoot(): void {
  if ((process.getuid?.() ?? 0) !== 0) die("this command must run as root", 2);
}

function validateExecutable(path: string, label: string): void {
  try { accessSync(path, constants.X_OK); } catch { die(`${label} is not executable: ${path}`); }
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

function installSelf(): void {
  requireRoot();
  const source = realpathSync(process.argv[1]);
  mkdirSync(dirname(INSTALL_PATH), { recursive: true });
  try {
    if (lstatSync(INSTALL_PATH).isSymbolicLink()) {
      if (realpathSync(INSTALL_PATH) !== source) die(`${INSTALL_PATH} is managed by a different installation; reinstall t3codectl before running setup`);
      return;
    }
  } catch {
    // The fixed installation path does not exist yet.
  }
  if (source !== INSTALL_PATH) copyFileSync(source, INSTALL_PATH);
  chmodSync(INSTALL_PATH, 0o755);
}

async function setup(args: string[]): Promise<void> {
  requireRoot();
  const overrides: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i] ?? die(`${arg} requires a value`, 2);
    if (arg === "--home") overrides.T3CODE_HOME = next();
    else if (arg === "--host") overrides.T3CODE_HOST = next();
    else if (arg === "--port") overrides.T3CODE_PORT = next();
    else if (arg === "--package") overrides.T3CODE_PACKAGE = next();
    else if (arg === "--schedule") overrides.T3CODE_UPDATE_SCHEDULE = next();
    else if (arg === "--node") overrides.T3CODE_NODE = next();
    else if (arg === "--npx") overrides.T3CODE_NPX = next();
    else if (arg === "--npm") overrides.T3CODE_NPM = next();
    else if (arg === "--path") overrides.T3CODE_PATH = next();
    else if (arg === "--help") { printHelp(); return; }
    else die(`unknown setup option: ${arg}`, 2);
  }
  const config = loadConfig(overrides);
  validateExecutable(config.node, "Node");
  validateExecutable(config.npx, "npx");
  validateExecutable(config.npm, "npm");
  validateExecutable(config.sqlite3, "sqlite3");
  installSelf();
  writeConfig(config);
  mkdirSync(unitDirectory(), { recursive: true, mode: 0o700 });
  const nativeInstall = await t3Service(config, "install");
  if (nativeInstall.code !== 0) die(nativeInstall.stderr.trim() || "T3 Code service installation failed");
  mkdirSync(dropinDirectory(config.serviceUnit), { recursive: true, mode: 0o700 });
  writeFileSync(dropinPath(config.serviceUnit), renderT3Dropin(config), { mode: 0o644 });
  chmodSync(dropinPath(config.serviceUnit), 0o644);
  const units = renderUnits(config);
  writeFileSync(unitPath(config.updateUnit), units.update, { mode: 0o644 });
  writeFileSync(unitPath(config.timerUnit), units.timer, { mode: 0o644 });
  for (const unit of [config.updateUnit, config.timerUnit]) chmodSync(unitPath(unit), 0o644);
  for (const result of [await systemctl(config, ["daemon-reload"]), await systemctl(config, ["enable", "--now", config.timerUnit])]) {
    if (result.code !== 0) die(result.stderr.trim() || "systemd setup failed");
  }
  const started = await systemctl(config, ["restart", config.serviceUnit]);
  if (started.code !== 0) die(started.stderr.trim() || "T3 Code service failed to start");
  console.log(`configured ${config.serviceUnit} through T3 Code`);
  console.log(`configured ${dropinPath(config.serviceUnit)}`);
  console.log(`configured and enabled ${config.timerUnit} (${config.schedule})`);
  console.log(`installed ${INSTALL_PATH}`);
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
    const state = JSON.parse(readFileSync(path, "utf8")) as { protocol?: number; activeVersion?: string; update?: { status?: string } };
    if (state.protocol !== 2 || typeof state.activeVersion !== "string" || !VERSION_RE.test(state.activeVersion)) return null;
    const updateStatus = state.update?.status ?? "none";
    if (!["none", "committed", "rolled-back", "failed", "pending"].includes(updateStatus)) return null;
    return { activeVersion: state.activeVersion, updateStatus };
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

async function health(config: Config, expectedVersion?: string): Promise<{ ok: boolean; reason: string }> {
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
  const serviceFields = parseKeyValueOutput(service.stdout);
  let latest: string | null = null;
  let latestError: string | null = null;
  try { latest = await latestVersion(config); } catch (error) { latestError = error instanceof Error ? error.message : String(error); }
  const serviceHealth = await health(config);
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
    updateTimer: {
      unit: config.timerUnit,
      state: timer.ActiveState ?? "unknown",
      next: timer.NextElapseUSecRealtime ?? null,
      last: timer.LastTriggerUSec ?? null,
    },
  };
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`service: ${result.active ? "running" : "not running"}`);
    console.log(`health: ${result.health ? "healthy" : `unhealthy (${result.healthReason})`}`);
    console.log(`running version: ${result.runningVersion ?? "unknown"}`);
    console.log(`latest version: ${result.latestVersion ?? `unknown${result.latestError ? ` (${result.latestError})` : ""}`}`);
    console.log(`automatic updates: ${result.updateTimer.state === "active" ? "enabled" : result.updateTimer.state}`);
    console.log(`next update: ${result.updateTimer.next ?? "unknown"}`);
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
  if (active.code !== 0) die("T3 Code service is not active");
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

const IDLE_QUERY = `PRAGMA query_only=ON;
BEGIN;
WITH unknown_counts AS (
  SELECT
    (SELECT COUNT(*) FROM projection_thread_sessions WHERE status IS NULL OR lower(status) NOT IN ('idle','starting','connecting','running','ready','interrupted','stopped','error')) AS unknown_sessions,
    (SELECT COUNT(*) FROM projection_turns WHERE state IS NULL OR lower(state) NOT IN ('pending','queued','starting','connecting','running','in_progress','interrupted','completed','error')) AS unknown_turns
), busy_counts AS (
  SELECT
    (SELECT COUNT(*) FROM projection_thread_sessions WHERE active_turn_id IS NOT NULL OR lower(status) IN ('starting','connecting','running')) AS busy_sessions,
    (SELECT COUNT(*) FROM projection_turns WHERE completed_at IS NULL OR lower(state) IN ('pending','queued','starting','connecting','running','in_progress')) AS busy_turns
)
SELECT CASE WHEN unknown_sessions + unknown_turns > 0 THEN 'UNKNOWN' WHEN busy_sessions + busy_turns > 0 THEN 'BUSY' ELSE 'IDLE' END || '|' || unknown_sessions || '|' || unknown_turns || '|' || busy_sessions || '|' || busy_turns FROM unknown_counts, busy_counts;
COMMIT;`;

async function idle(config: Config): Promise<{ state: "IDLE" | "BUSY" | "UNKNOWN"; detail: string }> {
  if (!existsSync(config.stateDb)) return { state: "UNKNOWN", detail: "state-db-unreadable" };
  const result = await run(config.sqlite3, ["-readonly", "-noheader", "-separator", "|", config.stateDb, IDLE_QUERY]);
  if (result.code !== 0) return { state: "UNKNOWN", detail: "state-query-failed" };
  const detail = result.stdout.trim();
  const state = detail.split("|", 1)[0];
  if (state === "IDLE") return { state, detail };
  if (state === "BUSY") return { state, detail };
  return { state: "UNKNOWN", detail: detail || "unexpected-query-result" };
}

function capacitySufficient(config: Config): boolean {
  try {
    const fs = statfsSync(config.home);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    const freeInodes = Number(fs.ffree);
    if (freeBytes < 5 * 1024 * 1024 * 1024 || freeInodes < 100000) {
      console.error(`t3codectl: update deferred: insufficient capacity (free bytes=${freeBytes}, free inodes=${freeInodes})`);
      return false;
    }
    return true;
  } catch {
    console.error("t3codectl: unable to inspect filesystem capacity");
    return false;
  }
}

async function reconcile(config: Config, version: string): Promise<number> {
  const env = { ...process.env, HOME: homedir(), PATH: config.path, npm_config_cache: join(config.home, "runtime/npm-cache") };
  const result = await run(config.npx, ["-y", `t3@${version}`, "service", "update", "--base-dir", config.home], { env, cwd: config.home, inherit: true });
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

async function waitForHealth(config: Config, version: string): Promise<boolean> {
  for (let attempt = 0; attempt < 18; attempt++) {
    const result = await health(config, version);
    if (result.ok) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
  }
  return false;
}

async function updateLocked(config: Config): Promise<number> {
  const active = await systemctl(config, ["is-active", "--quiet", config.serviceUnit]);
  if (active.code !== 0) { console.error("t3codectl: update refused: T3 Code service is not active"); return 1; }
  if (!capacitySufficient(config)) return 0;
  let target: string;
  try { target = await latestVersion(config); } catch (error) { console.error(`t3codectl: unable to resolve latest version: ${error instanceof Error ? error.message : String(error)}`); return 1; }
  const before = readServiceState(config);
  if (!before) { console.error("t3codectl: update refused: service state is missing or invalid"); return 1; }
  if (before.updateStatus === "pending") { console.error("t3codectl: update refused: T3 Code reports a pending update"); return 1; }
  if (before.activeVersion === target) { console.log(`already up to date: ${target}`); return 0; }
  if (compareVersions(target, before.activeVersion) !== 1) { console.error(`t3codectl: refusing non-forward update (${before.activeVersion} → ${target})`); return 1; }
  const idleResult = await idle(config);
  console.log(`idle check: ${idleResult.detail}`);
  if (idleResult.state === "BUSY") { console.log("update deferred: T3 Code is busy"); return 0; }
  if (idleResult.state !== "IDLE") { console.error("t3codectl: update refused: idle state is unknown"); return 1; }
  const recheck = readServiceState(config);
  if (!recheck || recheck.activeVersion !== before.activeVersion || recheck.updateStatus !== before.updateStatus) { console.error("t3codectl: update refused: service state changed during idle check"); return 1; }
  console.log(`updating T3 Code: ${before.activeVersion} → ${target}`);
  let code = await reconcile(config, target);
  if (code === 0 && await waitForHealth(config, target)) {
    pruneRuntimeVersions(config, target);
    console.log(`update complete: ${target}`);
    return 0;
  }
  console.error("t3codectl: update failed health verification; attempting rollback");
  code = await reconcile(config, before.activeVersion);
  if (code === 0 && await waitForHealth(config, before.activeVersion)) {
    console.error(`t3codectl: rollback complete; still running ${before.activeVersion}`);
    return 1;
  }
  console.error("t3codectl: rollback failed; manual intervention required");
  return 1;
}

async function update(args: string[]): Promise<void> {
  if (args.includes("--help")) { printHelp(); return; }
  const internal = args.includes("--internal-locked");
  if (args.some((arg) => arg !== "--internal-locked")) die(`unknown update option: ${args.find((arg) => arg !== "--internal-locked")}`, 2);
  const config = loadConfig();
  if (internal) { process.exitCode = await updateLocked(config); return; }
  mkdirSync(dirname(config.lockFile), { recursive: true, mode: 0o700 });
  const self = resolve(process.argv[1]);
  const result = await run("/usr/bin/flock", ["-n", "-E", "75", config.lockFile, process.execPath, self, "update", "--internal-locked"], { env: systemdEnv(config), inherit: true });
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
  const allowed = [unitPath(config.timerUnit), unitPath(config.updateUnit), dropinPath(config.serviceUnit), config.configPath, INSTALL_PATH];
  for (const path of allowed) if (existsSync(path)) unlinkSync(path);
  console.log("removed t3codectl updater units, service drop-in, and configuration");
  console.log(`left ${config.serviceUnit} under T3 Code ownership`);
  console.log(`preserved T3 Code data at ${config.home}`);
}

function printHelp(): void {
  console.log(`Usage: t3codectl <command> [options]

Commands:
  setup       Install the CLI, configure systemd, and enable nightly updates
  status      Show service health, running/latest versions, and timer state
  pair        Generate a fresh T3 Code pairing URL
  update      Apply the latest version when T3 Code is idle
  uninstall   Remove management units and config; never removes T3 Code data

Options:
  status --json
  setup --home PATH --host HOST --port PORT --package TAG --schedule CALENDAR --path PATH
  pair --base-url URL
  uninstall --yes
`);
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") { printHelp(); return; }
  if (command === "setup") return setup(args);
  if (command === "status") return status(args);
  if (command === "pair") return pair(args);
  if (command === "update") return update(args);
  if (command === "uninstall") return uninstall(args);
  die(`unknown command: ${command}`, 2);
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)));
