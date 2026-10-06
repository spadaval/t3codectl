/** Terminal output for t3codectl: grouped sections, status marks, and a live
 * spinner on terminals. Under systemd (no TTY) the same calls produce plain,
 * line-oriented log output without colors or cursor control. */

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
};

export type Color = keyof typeof ANSI;
type Stream = { isTTY?: boolean; columns?: number; write(chunk: string): unknown };

export function colorEnabled(stream: Stream = process.stdout): boolean {
  return Boolean(stream.isTTY) && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb";
}

export function paint(value: string, color: Color, enabled: boolean): string {
  return enabled ? `${ANSI[color]}${value}${ANSI.reset}` : value;
}

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type Verdict = "ok" | "warn" | "fail";

export class Ui {
  readonly color: boolean;
  readonly live: boolean;

  constructor(private readonly out: Stream = process.stdout, private readonly err: Stream = process.stderr) {
    this.color = colorEnabled(out);
    this.live = Boolean(out.isTTY) && process.env.TERM !== "dumb";
  }

  paint(value: string, color: Color): string { return paint(value, color, this.color); }

  private write(line: string, stream: Stream = this.out): void { stream.write(`${line}\n`); }

  blank(): void { this.write(""); }

  /** A section title, optionally followed by dim context on the same line. */
  section(title: string, context?: string): void {
    this.write(`${this.paint(title, "bold")}${context ? `  ${this.paint(context, "dim")}` : ""}`);
  }

  ok(message: string): void { this.write(`  ${this.paint("✓", "green")} ${message}`); }
  warn(message: string): void { this.write(`  ${this.paint("!", "yellow")} ${message}`); }
  fail(message: string): void { this.write(`  ${this.paint("✗", "red")} ${message}`, this.err); }
  step(message: string): void { this.write(`  ${this.paint("›", "cyan")} ${message}`); }
  /** Secondary explanation under the preceding line. */
  hint(message: string): void { this.write(`    ${this.paint(message, "dim")}`); }

  /** The single closing line that answers "did it work?". */
  verdict(kind: Verdict, message: string): void {
    const mark = kind === "ok" ? this.paint("✓", "green") : kind === "warn" ? this.paint("!", "yellow") : this.paint("✗", "red");
    this.write(`${mark} ${this.paint(message, "bold")}`, kind === "fail" ? this.err : this.out);
  }

  /** Show a spinner with elapsed time while `operation` runs. `progress`
   * replaces the dim detail text; on non-TTY output each new detail is logged
   * once so journals keep the history without a line per poll. */
  async wait<T>(label: string, operation: (progress: (detail: string) => void) => Promise<T>): Promise<T> {
    const started = Date.now();
    let detail = "";
    if (!this.live) {
      this.step(label);
      return operation((next) => {
        if (next && next !== detail) this.hint(next);
        detail = next;
      });
    }
    let frame = 0;
    const render = () => {
      // Keep the line narrower than the terminal: a wrapped line cannot be redrawn in place.
      const elapsed = formatDuration(Date.now() - started);
      const room = (this.out.columns ?? 100) - 1 - (4 + label.length + 1 + elapsed.length);
      let extra = detail ? ` · ${detail}` : "";
      if (extra.length > room) extra = room > 4 ? `${extra.slice(0, room - 1)}…` : "";
      const head = room < 0 ? label.slice(0, Math.max(0, label.length + room - 1)) + "…" : label;
      this.out.write(`\r\u001b[2K  ${this.paint(FRAMES[frame++ % FRAMES.length], "cyan")} ${head}${this.paint(extra, "dim")} ${this.paint(elapsed, "dim")}`);
    };
    render();
    const timer = setInterval(render, 100);
    try {
      return await operation((next) => { detail = next; });
    } finally {
      clearInterval(timer);
      this.out.write("\r\u001b[2K");
    }
  }
}
