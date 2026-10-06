/** Match both cgroup v1 controller paths and cgroup v2 unified paths, including descendants. */
export function belongsToService(cgroup: string, unit: string): boolean {
  return cgroup.split(/\r?\n/).some((line) => {
    const fields = line.split(":");
    return fields.length >= 3 && fields.slice(2).join(":").split("/").includes(unit);
  });
}

/** Own the setup lifecycle; configuration-only work never invokes the native installer. */
export async function configureService(operations: {
  installed: boolean;
  install(): Promise<void>;
  write(): Promise<{ serverChanged: boolean; restartPending: boolean }>;
  active(): Promise<boolean>;
  idle(): Promise<boolean>;
  markPending(): void;
  restart(): Promise<void>;
  start(): Promise<void>;
  forceRestart?: boolean;
  repairExisting?(): Promise<void>;
}): Promise<"unchanged" | "started" | "restarted" | "repaired" | "deferred"> {
  const changes = await operations.write();
  if (!operations.installed) await operations.install();
  const active = await operations.active();
  if (operations.installed && operations.repairExisting) {
    operations.markPending();
    if (active && !(await operations.idle())) return "deferred";
    await operations.repairExisting();
    return "repaired";
  }
  if (!active) {
    await operations.start();
    return "started";
  }
  if (!changes.serverChanged && !changes.restartPending && !operations.forceRestart) return "unchanged";
  // Persist before checking idleness or restarting: failures must retain the old endpoint.
  operations.markPending();
  if (operations.installed && !(await operations.idle())) return "deferred";
  await operations.restart();
  return "restarted";
}

/** Hold the same advisory lock as update while the current process reconciles configuration. */
export async function withConfigurationLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const { spawn } = await import("node:child_process");
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // The child holds flock until stdin closes, including when the parent exits.
  const guard = spawn("/usr/bin/flock", ["-n", "-E", "75", path, "/bin/sh", "-c", "printf 'locked\\n'; cat >/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  let acquired = false;
  const exited = new Promise<void>((resolve, reject) => {
    guard.once("error", reject);
    guard.once("close", (code) => acquired && code !== 0 ? reject(new Error("configuration lock was lost")) : resolve());
  });
  // Observe failures even if acquisition fails before the action starts.
  exited.catch(() => {});
  try {
    await new Promise<void>((resolve, reject) => {
      guard.stdout.once("data", () => { acquired = true; resolve(); });
      guard.once("error", reject);
      guard.once("close", () => { if (!acquired) reject(new Error("another setup, repair, or update is running")); });
    });
    return await action();
  } finally { guard.stdin.end(); await exited; }
}
