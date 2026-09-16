export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  level: LogLevel;
  msg: string;
  at: string;
  [key: string]: unknown;
}

/**
 * Structured JSON-lines logger. Every line carries the run id so a run can be
 * reconstructed from stdout alone (spec section 10: structured logs per run).
 */
export class Logger {
  private readonly entries: LogEntry[] = [];

  constructor(
    private readonly level: LogLevel = "info",
    private readonly context: Record<string, unknown> = {},
    private readonly sink: (line: string) => void = (l) => process.stdout.write(l + "\n"),
    private readonly capture = false,
  ) {}

  child(context: Record<string, unknown>): Logger {
    return new Logger(this.level, { ...this.context, ...context }, this.sink, this.capture);
  }

  debug(msg: string, data: Record<string, unknown> = {}): void {
    this.log("debug", msg, data);
  }
  info(msg: string, data: Record<string, unknown> = {}): void {
    this.log("info", msg, data);
  }
  warn(msg: string, data: Record<string, unknown> = {}): void {
    this.log("warn", msg, data);
  }
  error(msg: string, data: Record<string, unknown> = {}): void {
    this.log("error", msg, data);
  }

  captured(): LogEntry[] {
    return this.entries;
  }

  private log(level: LogLevel, msg: string, data: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const entry: LogEntry = { level, msg, at: new Date().toISOString(), ...this.context, ...data };
    if (this.capture) this.entries.push(entry);
    this.sink(JSON.stringify(entry));
  }
}

export function levelFromEnv(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const v = (env.LOG_LEVEL ?? "info").toLowerCase();
  return (["debug", "info", "warn", "error"] as LogLevel[]).includes(v as LogLevel)
    ? (v as LogLevel)
    : "info";
}

export const silentLogger = new Logger("error", {}, () => undefined);
