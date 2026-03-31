/**
 * Structured logging service for Exo.
 *
 * Uses pino (Layer 1, battle-tested) with:
 * - JSON lines to file in all modes (daily rotation, 7-day retention)
 * - Pretty console output in dev mode
 * - Namespaced child loggers per module
 *
 * REDACTION POLICY: Never log email body/subject content.
 * Only log IDs (email_id, account_id, thread_id, caller).
 */
import pino, { type Logger, multistream } from "pino";
import { join } from "path";
import { mkdirSync, readdirSync, unlinkSync, statSync } from "fs";

// Lazy-require Electron modules so this file can be imported in tests
// without Electron being available.
function getLogDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDataDir } = require("../data-dir");
    return join(getDataDir(), "logs");
  } catch {
    // Fallback for tests or non-Electron environments
    return join(process.cwd(), ".dev-data", "logs");
  }
}

function isDev(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { is } = require("@electron-toolkit/utils");
    return is.dev;
  } catch {
    return process.env.NODE_ENV !== "production";
  }
}

const LOG_RETENTION_DAYS = 7;

function cleanOldLogs(logDir: string): void {
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const f of readdirSync(logDir)) {
      if (!f.endsWith(".log")) continue;
      const p = join(logDir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* ignore individual file cleanup errors */
      }
    }
  } catch {
    /* ignore if log dir doesn't exist yet */
  }
}

let _logger: Logger | null = null;

function initLogger(): Logger {
  const logDir = getLogDir();
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* ignore */
  }

  cleanOldLogs(logDir);

  const today = new Date().toISOString().split("T")[0];
  const logFile = join(logDir, `${today}.log`);
  const dev = isDev();

  const streams: pino.StreamEntry[] = [
    // Always write JSON to file
    {
      level: "debug" as const,
      stream: pino.destination({ dest: logFile, sync: false, mkdir: true }),
    },
  ];

  if (dev) {
    // In dev, also write pretty output to stdout
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pinoPretty = require("pino-pretty");
      streams.push({
        level: "debug" as const,
        stream: pinoPretty({ colorize: true }),
      });
    } catch {
      // pino-pretty not available, fall back to raw JSON to stdout
      streams.push({
        level: "debug" as const,
        stream: pino.destination({ dest: 1, sync: true }), // fd 1 = stdout
      });
    }
  }

  return pino(
    {
      level: dev ? "debug" : "info",
      // Redact sensitive paths that might contain email content
      redact: {
        paths: [
          "body",
          "htmlBody",
          "html_body",
          "bodyText",
          "body_text",
          "subject",
          "snippet",
          "emailContent",
          "prompt",
        ],
        censor: "[REDACTED]",
      },
    },
    multistream(streams),
  );
}

/**
 * Create a namespaced logger for a module.
 *
 * Usage:
 *   const log = createLogger("analyzer");
 *   log.info("Email analyzed", { emailId: "abc", needsReply: true });
 */
export function createLogger(namespace: string): Logger {
  if (!_logger) _logger = initLogger();
  return _logger.child({ ns: namespace });
}

/**
 * Get the raw root logger (prefer createLogger for namespacing).
 */
export function getRawLogger(): Logger {
  if (!_logger) _logger = initLogger();
  return _logger;
}

/**
 * Flush all pending log writes. Call before app exit.
 */
export function flushLogs(): void {
  if (_logger) {
    _logger.flush();
  }
}
