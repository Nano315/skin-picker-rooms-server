import { logger } from "./logger";
import type {
  JoinRoomPayload,
  LeaveRoomPayload,
  UpdateSelectionPayload,
  OwnedOptionsPayload,
  RequestGroupRerollPayload,
  SuggestColorPayload,
  ApplySkinLineSynergyPayload,
  SetSkinLockPayload,
  KickMemberPayload,
  GroupSkinOption,
} from "../types";

/**
 * Validation result type.
 */
export type ValidationResult<T> = { valid: true; payload: T } | { valid: false };

const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 128;
const MAX_ENTITY_ID = 1_000_000_000;
const MAX_TOKEN_LENGTH = 256;
const MAX_COLOR_LENGTH = 64;
/**
 * Borne le nombre d'options par membre. Chaque `room-state` rediffuse les
 * options de tous les membres a tous les membres : la valeur plafonne autant
 * l'amplification reseau que le cout de `recomputeSynergy`.
 */
const MAX_OPTIONS = 2000;

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
 * Formats acceptes pour `auraColor`.
 *
 * Le client ne produit qu'une seule forme : `hexToRgba()` (lcu.ipc.ts) renvoie
 * toujours `rgba(r,g,b,a)`. On tolere aussi `#RRGGBB` par robustesse si la
 * source de couleur evolue. Les deux regex sont constantes et lineaires
 * (quantificateurs bornes, aucune alternance imbriquee) : pas de ReDoS.
 *
 * L'interet est double : borner l'espace de valeurs cote serveur, et empecher
 * qu'une chaine arbitraire d'un pair (`red;background:url(...)`) ne se retrouve
 * injectee dans un style inline cote renderer.
 */
const AURA_COLOR_RGBA_RE =
  /^rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})(,(0|1|0?\.\d{1,4}))?\)$/;
const AURA_COLOR_HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isValidAuraColor(value: string): boolean {
  if (AURA_COLOR_HEX_RE.test(value)) return true;
  const m = AURA_COLOR_RGBA_RE.exec(value);
  if (!m) return false;
  // Les composantes doivent tenir dans 0-255 : la regex ne borne que le nombre
  // de chiffres.
  return [m[1], m[2], m[3]].every((c) => Number(c) <= 255);
}

/**
 * Valide un element de `options[]`.
 *
 * Indispensable : `recomputeSynergy` deferences `opt.auraColor` et
 * `opt.skinLineId` sans garde. Un seul `null` dans le tableau suffisait a lever
 * une TypeError, capturee dans les handlers mais PAS dans `disconnect` — donc a
 * tuer le process. Valider le conteneur ne suffit pas, il faut valider chaque
 * element.
 */
function isGroupSkinOption(value: unknown): value is GroupSkinOption {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const o = value as Record<string, unknown>;

  if (!isBoundedInt(o.skinId) || !isBoundedInt(o.chromaId)) return false;

  // auraColor : `null` est legitime (skin sans aura), mais pas `undefined`
  // ni un objet. Le format est verifie strictement — la valeur alimente la
  // cardinalite de la boucle externe de recomputeSynergy cote serveur, et un
  // style inline cote renderer.
  if (o.auraColor !== null) {
    if (
      typeof o.auraColor !== "string" ||
      o.auraColor.length > MAX_COLOR_LENGTH ||
      !isValidAuraColor(o.auraColor)
    ) {
      return false;
    }
  }

  if (o.skinLineId !== undefined && !isBoundedInt(o.skinLineId)) return false;
  if (
    o.skinLineName !== undefined &&
    !(typeof o.skinLineName === "string" && o.skinLineName.length <= MAX_NAME_LENGTH)
  ) {
    return false;
  }

  return true;
}

/**
 * Valide le triplet d'identification present sur tous les payloads authentifies.
 */
function hasValidIdentity(
  p: Record<string, unknown>
): p is Record<string, unknown> & {
  roomId: string;
  memberId: string;
  memberToken: string;
} {
  return (
    isNonEmptyString(p.roomId) &&
    isNonEmptyString(p.memberId) &&
    isMemberToken(p.memberToken)
  );
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
    !hasValidIdentity(p) ||
    !isBoundedInt(p.championId) ||
    !Array.isArray(p.options) ||
    p.options.length > MAX_OPTIONS
  ) {
    logger.warn(`[${eventName}] Invalid payload: missing or out-of-range required fields`);
    return { valid: false };
  }

  // Valider CHAQUE element : c'est la garde qui empeche un `null` (ou tout
  // objet malforme) d'atteindre recomputeSynergy et de tuer le process.
  const badIndex = p.options.findIndex((opt) => !isGroupSkinOption(opt));
  if (badIndex !== -1) {
    logger.warn(`[${eventName}] Invalid payload: malformed option at index ${badIndex}`);
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
      options: p.options as GroupSkinOption[],
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
    !hasValidIdentity(p) ||
    p.type !== "sameColor" ||
    !isNonEmptyString(p.color, MAX_COLOR_LENGTH)
  ) {
    logger.warn(`[${eventName}] Invalid payload: missing required fields`);
    return { valid: false };
  }

  // `skinLineId` et `sourceMemberId` sont optionnels mais REELLEMENT utilises
  // par le handler (applyColorSynergy + payload group-apply-combo) : les
  // laisser passer, sous peine de casser les rerolls de skin line.
  if (p.skinLineId !== undefined && !isBoundedInt(p.skinLineId)) {
    logger.warn(`[${eventName}] Invalid payload: bad skinLineId`);
    return { valid: false };
  }
  if (p.sourceMemberId !== undefined && !isNonEmptyString(p.sourceMemberId)) {
    logger.warn(`[${eventName}] Invalid payload: bad sourceMemberId`);
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
      skinLineId: p.skinLineId as number | undefined,
      sourceMemberId: p.sourceMemberId as string | undefined,
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
    !hasValidIdentity(p) ||
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

/**
 * Validates ApplySkinLineSynergyPayload.
 */
export function validateApplySkinLineSynergyPayload(
  payload: unknown,
  eventName = "apply-skin-line-synergy"
): ValidationResult<ApplySkinLineSynergyPayload> {
  if (!payload || typeof payload !== "object") {
    logger.warn(`[${eventName}] Invalid payload: not an object`);
    return { valid: false };
  }

  const p = payload as Record<string, unknown>;

  if (!hasValidIdentity(p) || !isBoundedInt(p.skinLineId)) {
    logger.warn(`[${eventName}] Invalid payload: missing or out-of-range required fields`);
    return { valid: false };
  }

  return {
    valid: true,
    payload: {
      roomId: p.roomId,
      memberId: p.memberId,
      memberToken: p.memberToken,
      skinLineId: p.skinLineId,
    },
  };
}

/**
 * Validates SetSkinLockPayload.
 */
export function validateSetSkinLockPayload(
  payload: unknown,
  eventName = "set-skin-lock"
): ValidationResult<SetSkinLockPayload> {
  if (!payload || typeof payload !== "object") {
    logger.warn(`[${eventName}] Invalid payload: not an object`);
    return { valid: false };
  }

  const p = payload as Record<string, unknown>;

  if (!hasValidIdentity(p) || typeof p.locked !== "boolean") {
    logger.warn(`[${eventName}] Invalid payload: missing required fields`);
    return { valid: false };
  }

  return {
    valid: true,
    payload: {
      roomId: p.roomId,
      memberId: p.memberId,
      memberToken: p.memberToken,
      locked: p.locked,
    },
  };
}

/**
 * Validates KickMemberPayload.
 */
export function validateKickMemberPayload(
  payload: unknown,
  eventName = "kick-member"
): ValidationResult<KickMemberPayload> {
  if (!payload || typeof payload !== "object") {
    logger.warn(`[${eventName}] Invalid payload: not an object`);
    return { valid: false };
  }

  const p = payload as Record<string, unknown>;

  if (!hasValidIdentity(p) || !isNonEmptyString(p.targetMemberId)) {
    logger.warn(`[${eventName}] Invalid payload: missing required fields`);
    return { valid: false };
  }

  return {
    valid: true,
    payload: {
      roomId: p.roomId,
      memberId: p.memberId,
      memberToken: p.memberToken,
      targetMemberId: p.targetMemberId,
    },
  };
}
