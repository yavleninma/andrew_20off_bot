type LogLevel = "debug" | "info" | "warn" | "error";

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function normalizeLevel(value: string | undefined): LogLevel {
  if (!value) {
    return "info";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  return "info";
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack
    };
  }
  return { value: String(err) };
}

function safeStringify(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "logger.serialize_failed"
    });
  }
}

const minLevel = normalizeLevel(process.env.LOG_LEVEL);

export class Logger {
  constructor(private readonly baseContext: Record<string, unknown> = {}) {}

  child(context: Record<string, unknown>): Logger {
    return new Logger({ ...this.baseContext, ...context });
  }

  debug(event: string, message: string, context?: Record<string, unknown>): void {
    this.log("debug", event, message, context);
  }

  info(event: string, message: string, context?: Record<string, unknown>): void {
    this.log("info", event, message, context);
  }

  warn(event: string, message: string, context?: Record<string, unknown>): void {
    this.log("warn", event, message, context);
  }

  error(event: string, message: string, context?: Record<string, unknown> & { error?: unknown }): void {
    const out: Record<string, unknown> = { ...context };
    if (context?.error !== undefined) {
      out.error = serializeError(context.error);
    }
    this.log("error", event, message, out);
  }

  private log(level: LogLevel, event: string, message: string, context?: Record<string, unknown>): void {
    if (levelWeight[level] < levelWeight[minLevel]) {
      return;
    }
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
      message,
      ...this.baseContext,
      ...(context ?? {})
    };
    const line = safeStringify(payload);
    if (level === "error") {
      process.stderr.write(`${line}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  }
}

export const logger = new Logger({ service: "andrew_20off_bot" });
