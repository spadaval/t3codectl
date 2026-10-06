/** Plain-language explanations for health check reason codes. The codes stay
 * stable for `status --json`; people see these sentences instead. */
export function describeHealthReason(reason: string, port?: number): string {
  const portText = port === undefined ? "the T3 Code port" : `port ${port}`;
  const [code, value = ""] = splitReason(reason);
  switch (code) {
    case "healthy": return "healthy";
    case "health-check-not-run": return "the health check did not run";
    case "service-inactive": return "the systemd service is not running";
    case "invalid-or-missing-service-state": return "T3 Code's service-state.json is missing or invalid";
    case "active-version": return `the service is still on ${value}`;
    case "update-pending": return "T3 Code reports an update in progress";
    case "missing-service-cgroup": return "systemd did not report the service's process group";
    case "socket-inspection-failed": return "could not list listening ports (ss failed)";
    case "port-not-listening": return `nothing is listening on ${portText} yet`;
    case "listener-outside-service-cgroup": return `${portText} is held by PID ${value}, which is not part of the service`;
    case "listener-process-unreadable": return `could not inspect PID ${value} listening on ${portText}`;
    case "health-http": return `the server answered with HTTP ${value}`;
    case "health-request": return /timed? ?out|timeout|aborted/i.test(value) ? "the server is not answering requests yet" : `the server could not be reached (${value})`;
    case "server-runtime-mismatch": return "the server is running with a different host or port than configured";
    case "missing-or-invalid-server-runtime": return "the server has not written its runtime information yet";
    case "active-version-changed": return "the installed version changed unexpectedly";
    case "service-restart-failed": return value ? `systemd could not restart the service (${value})` : "systemd could not restart the service";
    default: return reason;
  }
}

function splitReason(reason: string): [string, string?] {
  const match = reason.match(/^([a-z-]+)(?:=|: )(.*)$/s);
  return match ? [match[1], match[2]] : [reason];
}
