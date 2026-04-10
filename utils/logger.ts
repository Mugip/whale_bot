// ─────────────────────────────────────────────────────────────
// utils/logger.ts
// Structured console logger with log levels.
// ─────────────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error" | "debug";

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  timestamp: string;
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const entry: LogEntry = {
    level,
    message,
    context,
    timestamp: new Date().toISOString(),
  };

  const line = JSON.stringify(entry);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) =>
    emit("info", message, context),

  warn: (message: string, context?: Record<string, unknown>) =>
    emit("warn", message, context),

  error: (message: string, context?: Record<string, unknown>) =>
    emit("error", message, context),

  debug: (message: string, context?: Record<string, unknown>) => {
    if (process.env.NODE_ENV !== "production") {
      emit("debug", message, context);
    }
  },
};
