export const VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type ServiceUpdateStatus = "committed" | "rolled-back" | "failed" | "pending";

const UPDATE_STATUSES: ReadonlySet<string> = new Set<ServiceUpdateStatus>(["committed", "rolled-back", "failed", "pending"]);

export type ServiceStateSummary = {
  activeVersion: string;
  updateStatus: "none" | ServiceUpdateStatus;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUpdateStatus(value: unknown): value is ServiceUpdateStatus {
  return typeof value === "string" && UPDATE_STATUSES.has(value);
}

export function parseServiceState(text: string): ServiceStateSummary | null {
  try {
    const state: unknown = JSON.parse(text);
    if (!isRecord(state) || typeof state.activeVersion !== "string" || !VERSION_RE.test(state.activeVersion)) return null;

    // These fields are intentionally read across launcher protocol revisions,
    // matching the compatibility behavior used by T3 itself.
    if (state.update === undefined) return { activeVersion: state.activeVersion, updateStatus: "none" };
    if (!isRecord(state.update) || !isUpdateStatus(state.update.status)) return null;
    return { activeVersion: state.activeVersion, updateStatus: state.update.status };
  } catch {
    return null;
  }
}
