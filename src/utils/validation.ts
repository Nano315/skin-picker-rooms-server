import { logger } from "./logger";
import type {
  JoinRoomPayload,
  LeaveRoomPayload,
  UpdateSelectionPayload,
  OwnedOptionsPayload,
  RequestGroupRerollPayload,
  SuggestColorPayload,
} from "../types";

/**
 * Validation result type.
 */
type ValidationResult<T> = { valid: true; payload: T } | { valid: false };

/**
 * Validates that a value is a non-empty string.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validates that a value is a number (including 0).
 */
function isNumber(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

/**
 * Validates JoinRoomPayload.
 */
export function validateJoinRoomPayload(
  payload: unknown,
  eventName = "join-room"
): ValidationResult<JoinRoomPayload> {
  if (!payload || typeof payload !== "object") {
    logger.warn(`[${eventName}] Invalid payload: not an object`);
    return { valid: false };
  }

  const p = payload as Record<string, unknown>;

  if (!isNonEmptyString(p.roomId) || !isNonEmptyString(p.memberId)) {
    logger.warn(`[${eventName}] Invalid payload: missing roomId or memberId`);
    return { valid: false };
  }

  return { valid: true, payload: { roomId: p.roomId, memberId: p.memberId } };
}

/**
 * Validates LeaveRoomPayload (same structure as JoinRoomPayload).
 */
export function validateLeaveRoomPayload(
  payload: unknown,
  eventName = "leave-room"
): ValidationResult<LeaveRoomPayload> {
  return validateJoinRoomPayload(payload, eventName) as ValidationResult<LeaveRoomPayload>;
}

/**
 * Validates UpdateSelectionPayload.
 */
export function validateUpdateSelectionPayload(
  payload: unknown,
  eventName = "update-selection"
): ValidationResult<UpdateSelectionPayload> {
  if (!payload || typeof payload !== "object") {
    logger.warn(`[${eventName}] Invalid payload: not an object`);
    return { valid: false };
  }

  const p = payload as Record<string, unknown>;

  if (
    !isNonEmptyString(p.roomId) ||
    !isNonEmptyString(p.memberId) ||
    !isNumber(p.championId) ||
    !isNumber(p.skinId) ||
    !isNumber(p.chromaId)
  ) {
    logger.warn(`[${eventName}] Invalid payload: missing required fields`);
    return { valid: false };
  }

  return {
    valid: true,
    payload: {
      roomId: p.roomId,
      memberId: p.memberId,
      championId: p.championId,
      championAlias: typeof p.championAlias === "string" ? p.championAlias : undefined,
      skinId: p.skinId,
      chromaId: p.chromaId,
    },
  };
}

/**
 * Validates OwnedOptionsPayload.
 */
export function validateOwnedOptionsPayload(
  payload: unknown,
  eventName = "owned-options"
): ValidationResult<OwnedOptionsPayload> {
  if (!payload || typeof payload !== "object") {
    logger.warn(`[${eventName}] Invalid payload: not an object`);
    return { valid: false };
  }

  const p = payload as Record<string, unknown>;

  if (
    !isNonEmptyString(p.roomId) ||
    !isNonEmptyString(p.memberId) ||
    !isNumber(p.championId) ||
    !Array.isArray(p.options)
  ) {
    logger.warn(`[${eventName}] Invalid payload: missing required fields`);
    return { valid: false };
  }

  return {
    valid: true,
    payload: {
      roomId: p.roomId,
      memberId: p.memberId,
      championId: p.championId,
      championAlias: typeof p.championAlias === "string" ? p.championAlias : undefined,
      options: p.options,
    },
  };
}

/**
 * Validates RequestGroupRerollPayload.
 */
export function validateRequestGroupRerollPayload(
  payload: unknown,
  eventName = "request-group-reroll"
): ValidationResult<RequestGroupRerollPayload> {
  if (!payload || typeof payload !== "object") {
    logger.warn(`[${eventName}] Invalid payload: not an object`);
    return { valid: false };
  }

  const p = payload as Record<string, unknown>;

  if (
    !isNonEmptyString(p.roomId) ||
    !isNonEmptyString(p.memberId) ||
    p.type !== "sameColor" ||
    !isNonEmptyString(p.color)
  ) {
    logger.warn(`[${eventName}] Invalid payload: missing required fields`);
    return { valid: false };
  }

  return {
    valid: true,
    payload: {
      roomId: p.roomId,
      memberId: p.memberId,
      type: p.type,
      color: p.color,
    },
  };
}

/**
 * Validates SuggestColorPayload.
 */
export function validateSuggestColorPayload(
  payload: unknown,
  eventName = "suggest-color"
): ValidationResult<SuggestColorPayload> {
  if (!payload || typeof payload !== "object") {
    logger.warn(`[${eventName}] Invalid payload: not an object`);
    return { valid: false };
  }

  const p = payload as Record<string, unknown>;

  if (
    !isNonEmptyString(p.roomId) ||
    !isNonEmptyString(p.memberId) ||
    !isNumber(p.skinId) ||
    !isNumber(p.chromaId)
  ) {
    logger.warn(`[${eventName}] Invalid payload: missing required fields`);
    return { valid: false };
  }

  return {
    valid: true,
    payload: {
      roomId: p.roomId,
      memberId: p.memberId,
      skinId: p.skinId,
      chromaId: p.chromaId,
    },
  };
}
