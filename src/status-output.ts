import { describeHealthReason } from "./health-reason.ts";
import { colorEnabled, paint } from "./ui.ts";

type LastUpdate = {
  startedAt: string | null;
  result: string;
  error: string | null;
};

export type StatusView = {
  active: boolean;
  health: boolean;
  healthReason: string;
  runningVersion: string | null;
  latestVersion: string | null;
  latestError: string | null;
  updateTimer: {
    state: string;
    schedule: string;
    next: string | null;
  };
  lastUpdate: LastUpdate;
};

type RenderOptions = {
  color?: boolean;
  now?: Date;
};

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

export function formatRelativeTime(value: string | null, now = new Date()): string {
  if (!value || value === "n/a") return "unknown";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const deltaSeconds = Math.round((timestamp - now.getTime()) / 1000);
  const absoluteSeconds = Math.abs(deltaSeconds);
  if (absoluteSeconds < 45) return deltaSeconds > 0 ? "in less than a minute" : "just now";

  let amount: number;
  let unit: string;
  if (absoluteSeconds < 60 * 60) {
    amount = Math.round(absoluteSeconds / 60);
    unit = "minute";
  } else if (absoluteSeconds < 24 * 60 * 60) {
    amount = Math.round(absoluteSeconds / (60 * 60));
    unit = "hour";
  } else if (absoluteSeconds < 30 * 24 * 60 * 60) {
    amount = Math.round(absoluteSeconds / (24 * 60 * 60));
    unit = "day";
  } else if (absoluteSeconds < 365 * 24 * 60 * 60) {
    amount = Math.round(absoluteSeconds / (30 * 24 * 60 * 60));
    unit = "month";
  } else {
    amount = Math.round(absoluteSeconds / (365 * 24 * 60 * 60));
    unit = "year";
  }
  const duration = plural(amount, unit);
  return deltaSeconds > 0 ? `in ${duration}` : `${duration} ago`;
}

function formatClock(hourText: string, minute: string, second: string): string {
  const hour = Number(hourText);
  const suffix = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 || 12;
  const seconds = second === "00" ? "" : `:${second}`;
  return `${displayHour}:${minute}${seconds} ${suffix}`;
}

export function formatSchedule(schedule: string): string {
  const daily = schedule.match(/^\*-\*-\*\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (daily) return `daily at ${formatClock(daily[1], daily[2], daily[3])}`;
  if (schedule === "*-*-* *:00:00") return "hourly";
  return schedule;
}

function versionLine(status: StatusView, color: boolean): string {
  const current = status.runningVersion;
  const latest = status.latestVersion;
  if (current && latest && current === latest) return paint(`${current} (up to date)`, "green", color);
  if (current && latest) return paint(`${current} (latest: ${latest})`, "red", color);
  if (!current && latest) return paint(`unknown (latest: ${latest})`, "yellow", color);
  const detail = status.latestError ? `: ${status.latestError}` : "";
  return paint(`${current ?? "unknown"} (latest unavailable${detail})`, "yellow", color);
}

function lastUpdateLine(status: StatusView, color: boolean, now: Date): string {
  if (!status.lastUpdate.startedAt || status.lastUpdate.result === "never") return paint("never", "yellow", color);
  const relativeTime = formatRelativeTime(status.lastUpdate.startedAt, now);
  const label = status.lastUpdate.result.replaceAll("-", " ");
  const resultColor = status.lastUpdate.result === "up-to-date" || status.lastUpdate.result === "updated"
    ? "green"
    : status.lastUpdate.result === "failed"
      ? "red"
      : status.lastUpdate.result === "running"
        ? "cyan"
        : "yellow";
  return `${relativeTime} · ${paint(label, resultColor, color)}`;
}

export function renderStatus(status: StatusView, options: RenderOptions = {}): string {
  const color = options.color ?? colorEnabled();
  const now = options.now ?? new Date();
  const service = paint(status.active ? "running" : "not running", status.active ? "green" : "red", color);
  const health = paint(status.health ? "healthy" : `unhealthy: ${describeHealthReason(status.healthReason)}`, status.health ? "green" : "red", color);
  const timerEnabled = status.updateTimer.state === "active";
  const timerState = timerEnabled ? "enabled" : status.updateTimer.state === "inactive" ? "disabled" : status.updateTimer.state;
  const schedule = `${paint(timerState, timerEnabled ? "green" : "red", color)} · ${formatSchedule(status.updateTimer.schedule)}`;
  const next = timerEnabled ? formatRelativeTime(status.updateTimer.next, now) : "not scheduled";
  const lines = [
    paint("T3 Code", "bold", color),
    `  Service    ${service} · ${health}`,
    `  Version    ${versionLine(status, color)}`,
    "",
    paint("Automatic updates", "bold", color),
    `  Schedule   ${schedule}`,
    `  Next       ${next}`,
    `  Last       ${lastUpdateLine(status, color, now)}`,
  ];
  if (status.lastUpdate.error) {
    const errorColor = status.lastUpdate.result === "failed" ? "red" : "yellow";
    const label = status.lastUpdate.result === "failed" ? "Error " : "Reason";
    lines.push(`  ${label}     ${paint(status.lastUpdate.error, errorColor, color)}`);
  }
  return lines.join("\n");
}
