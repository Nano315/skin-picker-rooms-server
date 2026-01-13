import winston from "winston";

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const colors = {
  error: "red",
  warn: "yellow",
  info: "green",
  http: "magenta",
  debug: "white",
};

winston.addColors(colors);

/**
 * Custom format that includes metadata for structured logging.
 * Logs include timestamp, level, message, and any additional context.
 */
const format = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss:ms" }),
  winston.format.colorize({ all: true }),
  winston.format.printf((info) => {
    // Extract known fields
    const { timestamp, level, message, ...meta } = info;

    // Format base message
    let log = `[${timestamp}] [${level}]: ${message}`;

    // Add metadata if present (for structured logging)
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta)}`;
    }

    return log;
  })
);

const transports = [
  new winston.transports.Console(),
  // Add file transport here for production if needed
];

export const logger = winston.createLogger({
  level: "debug",
  levels,
  format,
  transports,
});
