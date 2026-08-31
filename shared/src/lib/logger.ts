import pino from "pino";

// =============================================================================
// Shared Logger
//
// Structured JSON logging via pino. All services use the same format.
// LOG_LEVEL defaults to 'info' in production, overridable via env.
//
// Usage:
//   import logger from '@platform-pub/shared/lib/logger'
//   logger.info({ readerId, amountPence }, 'Gate pass recorded')
// =============================================================================

export const pinoConfig: Record<string, unknown> = {
  level: process.env.LOG_LEVEL ?? "info",
  ...(process.env.NODE_ENV !== "production" && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true },
    },
  }),
};

// pino v8 types use `export =` (CJS); TypeScript NodeNext ESM treats the default
// import as a namespace rather than a callable — cast via any to call the factory.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logger = (pino as any)(pinoConfig);

export default logger;
