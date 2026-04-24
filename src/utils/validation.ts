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

const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 128;
const MAX_ENTITY_ID = 1_000_000_000;
const MAX_TOKEN_LENGTH = 256;

/**
 * Validates that a value is a non-empty, bounded string.
 */
function isNonEmptyString(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/**
 * Validates that a value is a finite, non-negative integer bounded by max.
 */
function isBoundedInt(value: unknown, max = MAX_ENTITY_ID): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
  );
}

/**
 * Validates a memberToken: non-empty bounded string (content verified later with assertMemberAuth).
 */
function isMemberToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;
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

  if (
    !isNonEmptyString(p.roomId) ||
    !isNonEmptyString(p.memberId) ||
    !isMemberToken(p.memberToken)
  ) {
    logger.warn(`[${eventName}] Invalid payload: missing roomId, memberId or memberToken`);
    return { valid: false };
  }

  return {
    valid: true,
    payload: { roomId: p.roomId, memberId: p.memberId, memberToken: p.memberToken },
  };
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
    !isMemberToken(p.memberToken) ||
    !isBoundedInt(p.championId) ||
    !isBoundedInt(p.skinId) ||
    !isBoundedInt(p.chromaId)
  ) {
    logger.warn(`[${eventName}] Invalid payload: missing or out-of-range required fields`);
    return { valid: false };
  }

  return {
    valid: true,
    payload: {
      roomId: p.roomId,
      memberId: p.memberId,
      memberToken: p.memberToken,
      championId: p.championId,
      championAlias:
        typeof p.championAlias === "string" && p.championAlias.length <= MAX_NAME_LENGTH
          ? p.championAlias
          : undefined,
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
    !isMemberToken(p.memberToken) ||
    !isBoundedInt(p.championId) ||
    !Array.isArray(p.options) ||
    p.options.length > 10_000
  ) {
    logger.warn(`[${eventName}] Invalid payload: missing or out-of-range required fields`);
    return { valid: false };
  }

  return {
    valid: true,
    payload: {
      roomId: p.roomId,
      memberId: p.memberId,
      memberToken: p.memberToken,
      championId: p.championId,
      championAlias:
        typeof p.championAlias === "string" && p.championAlias.length <= MAX_NAME_LENGTH
          ? p.championAlias
          : undefined,
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
    !isMemberToken(p.memberToken) ||
    p.type !== "sameColor" ||
    !isNonEmptyString(p.color, 64)
  ) {
    logger.warn(`[${eventName}] Invalid payload: missing required fields`);
    return { valid: false };
  }

  return {
    valid: true,
    payload: {
      roomId: p.roomId,
      memberId: p.memberId,
      memberToken: p.memberToken,
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
    !isMemberToken(p.memberToken) ||
    !isBoundedInt(p.skinId) ||
    !isBoundedInt(p.chromaId)
  ) {
    logger.warn(`[${eventName}] Invalid payload: missing or out-of-range required fields`);
    return { valid: false };
  }

  return {
    valid: true,
    payload: {
      roomId: p.roomId,
      memberId: p.memberId,
      memberToken: p.memberToken,
      skinId: p.skinId,
      chromaId: p.chromaId,
    },
  };
}
