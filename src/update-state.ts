import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type UpdateAttemptResult = "running" | "updated" | "up-to-date" | "deferred" | "failed";

export type UpdateAttempt = {
  protocol: 1;
  startedAt: string;
  finishedAt: string | null;
  result: UpdateAttemptResult;
  error: string | null;
};

const RESULTS = new Set<UpdateAttemptResult>(["running", "updated", "up-to-date", "deferred", "failed"]);

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function readUpdateAttempt(path: string): UpdateAttempt | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateAttempt>;
    if (value.protocol !== 1 || !validTimestamp(value.startedAt)) return null;
    if (value.finishedAt !== null && !validTimestamp(value.finishedAt)) return null;
    if (typeof value.result !== "string" || !RESULTS.has(value.result as UpdateAttemptResult)) return null;
    if (value.error !== null && typeof value.error !== "string") return null;
    if (value.result === "running" ? value.finishedAt !== null : value.finishedAt === null) return null;
    return value as UpdateAttempt;
  } catch {
    return null;
  }
}

export function writeUpdateAttempt(path: string, attempt: UpdateAttempt): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp.${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(attempt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}
