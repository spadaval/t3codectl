import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Connection = { configPath: string; port: number };
export type PendingConfiguration<T> = { protocol: 1; previous: T; restartCompleted: boolean; applied?: T; nativeRepair?: boolean };
export type PendingPhase<T> = { restartCompleted?: boolean; applied?: T; nativeRepair?: boolean };

export function writePending<T>(path: string, previous: T, phase: PendingPhase<T> = {}): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp.${process.pid}`;
  writeFileSync(temp, JSON.stringify({ protocol: 1, previous, restartCompleted: false, ...phase }), { mode: 0o600 });
  renameSync(temp, path);
}

export function readPending<T extends Connection>(path: string, desired: T): PendingConfiguration<T> | null {
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, "utf8"));
  const valid = (candidate: any) => candidate && candidate.configPath === desired.configPath &&
    Object.keys(desired).every((key) => typeof candidate[key] === typeof desired[key as keyof T]) &&
    Number.isInteger(candidate.port) && candidate.port > 0 && candidate.port <= 65535;
  if (record?.protocol !== 1 || !valid(record.previous) || typeof record.restartCompleted !== "boolean" ||
    (record.restartCompleted && !valid(record.applied)) || (record.nativeRepair !== undefined && typeof record.nativeRepair !== "boolean")) throw new Error("invalid pending server configuration");
  return record;
}

/** The applied snapshot belongs to the running server, even when desired settings change again. */
export function pendingConnection<T>(record: PendingConfiguration<T> | null): T | null {
  return record ? record.restartCompleted ? record.applied! : record.previous : null;
}

export function needsNativeRepair<T>(record: PendingConfiguration<T> | null, explicitRepair: boolean): boolean {
  return explicitRepair || (record?.nativeRepair === true && !record.restartCompleted);
}
