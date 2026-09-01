export const MANAGED_CONFIG_KEYS = [
  "T3CODE_HOME",
  "T3CODE_HOST",
  "T3CODE_PORT",
  "T3CODE_MODE",
  "T3CODE_PACKAGE",
  "T3CODE_NODE",
  "T3CODE_NPX",
  "T3CODE_NPM",
  "T3CODE_UPDATE_SCHEDULE",
  "T3CODE_SERVICE_UNIT",
  "T3CODE_UPDATE_UNIT",
  "T3CODE_TIMER_UNIT",
  "T3CODE_STATE_DB",
  "T3CODE_IDLE_CHECK",
  "T3CODE_LOCK_FILE",
  "T3CODE_HEALTH_URL",
  "T3CODE_BASE_URL",
  "T3CODE_PATH",
  "T3CODE_USER",
] as const;

function configLine(key: string, value: string): string {
  if (/\r|\n/.test(value)) throw new Error(`${key} contains a newline`);
  return `${key}=${value}`;
}

function canonicalConfig(values: Record<string, string>): string {
  return [
    "# Managed by t3codectl. Values are deployment configuration, not T3 Code data.",
    ...MANAGED_CONFIG_KEYS.map((key) => configLine(key, values[key] ?? "")),
    "",
  ].join("\n");
}

/**
 * Update only keys owned by t3codectl. Comments, ordering, and unknown keys
 * are intentionally retained so setup can safely revisit an existing file.
 */
export function mergeManagedConfig(existing: string | undefined, values: Record<string, string>): string {
  if (existing === undefined) return canonicalConfig(values);

  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const managed = new Set<string>(MANAGED_CONFIG_KEYS);
  const seen = new Set<string>();
  const lines = existing.split(/\r?\n/).map((line) => {
    const match = line.match(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/);
    if (!match || !managed.has(match[1])) return line;
    seen.add(match[1]);
    return configLine(match[1], values[match[1]] ?? "");
  });

  const missing = MANAGED_CONFIG_KEYS.filter((key) => !seen.has(key));
  if (missing.length > 0) {
    while (lines.at(-1) === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(...missing.map((key) => configLine(key, values[key] ?? "")));
    lines.push("");
  }

  return lines.join(newline);
}
