/**
 * Standard error codes for the application.
 */
export const ErrorCodes = {
  ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
  MEMBER_NOT_FOUND: "MEMBER_NOT_FOUND",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  UNAUTHORIZED: "UNAUTHORIZED",
  ROOM_FULL: "ROOM_FULL",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Application error class for operational errors.
 * Operational errors are expected errors (validation failures, not found, etc.)
 * vs programming errors (bugs, unexpected exceptions).
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly isOperational: boolean;
  public readonly context?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    isOperational: boolean = true,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.code = code;
    this.isOperational = isOperational;
    this.context = context;
    this.name = "AppError";

    // Maintains proper stack trace for where our error was thrown
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * User-friendly error messages for each error code.
 * These are safe to send to clients.
 */
export const UserFriendlyMessages: Record<ErrorCode, string> = {
  [ErrorCodes.ROOM_NOT_FOUND]: "Room not found",
  [ErrorCodes.MEMBER_NOT_FOUND]: "Member not found in room",
  [ErrorCodes.INVALID_PAYLOAD]: "Invalid request data",
  [ErrorCodes.UNAUTHORIZED]: "You are not authorized to perform this action",
  [ErrorCodes.ROOM_FULL]: "Room is full",
  [ErrorCodes.RATE_LIMITED]: "Too many requests, please slow down",
  [ErrorCodes.INTERNAL_ERROR]: "An unexpected error occurred",
};

/**
 * Formats an error for client response.
 * Hides technical details for non-operational errors.
 */
export function formatErrorResponse(error: unknown): {
  code: ErrorCode;
  message: string;
} {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: UserFriendlyMessages[error.code] || error.message,
    };
  }

  // For unexpected errors, return generic message
  return {
    code: ErrorCodes.INTERNAL_ERROR,
    message: UserFriendlyMessages[ErrorCodes.INTERNAL_ERROR],
  };
}

/**
 * Type guard to check if an error is an AppError.
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
