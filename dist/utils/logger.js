"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const winston_1 = __importDefault(require("winston"));
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
winston_1.default.addColors(colors);
/**
 * Custom format that includes metadata for structured logging.
 * Logs include timestamp, level, message, and any additional context.
 */
const format = winston_1.default.format.combine(winston_1.default.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss:ms" }), winston_1.default.format.colorize({ all: true }), winston_1.default.format.printf((info) => {
    // Extract known fields
    const { timestamp, level, message, ...meta } = info;
    // Format base message
    let log = `[${timestamp}] [${level}]: ${message}`;
    // Add metadata if present (for structured logging)
    if (Object.keys(meta).length > 0) {
        log += ` ${JSON.stringify(meta)}`;
    }
    return log;
}));
const transports = [
    new winston_1.default.transports.Console(),
    // Add file transport here for production if needed
];
exports.logger = winston_1.default.createLogger({
    level: "debug",
    levels,
    format,
    transports,
});
