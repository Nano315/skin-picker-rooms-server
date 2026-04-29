/**
 * Socket.io Event Versioning Types
 *
 * Version History:
 * - v1 (legacy): Original format, no version field
 * - v2: Added version field, standardized naming
 * - v3 (current): Added per-member `lockedSkin` to room-state members
 *
 * Breaking Changes v1 → v2:
 * - All versioned events now include `version` field
 * - color-suggestion-received: field names standardized (senderName → memberName for clarity)
 * - room-state: added version field
 * - group-apply-combo: added version field
 *
 * Breaking Changes v2 → v3:
 * - room-state.members[].lockedSkin (boolean) added
 */

// Current version - clients should declare this or higher
export const CURRENT_EVENT_VERSION = 3;

// Minimum supported version (for backwards compat)
export const MIN_SUPPORTED_VERSION = 1;

// ============================================
// Base Versioned Payload
// ============================================

export interface VersionedPayload {
  version: number;
}

// ============================================
// color-suggestion-received Event Versions
// ============================================

/**
 * V1 (legacy) - No version field
 * Used by clients that don't send clientVersion
 */
export interface ColorSuggestionV1 {
  memberId: string;
  senderName: string;
  skinId: number;
  chromaId: number;
}

/**
 * V2 (current) - With version field and standardized naming
 */
export interface ColorSuggestionV2 extends VersionedPayload {
  version: 2;
  memberId: string;
  memberName: string; // Renamed from senderName for clarity
  skinId: number;
  chromaId: number;
}

export type ColorSuggestionPayload = ColorSuggestionV1 | ColorSuggestionV2;

// ============================================
// room-state Event Versions
// ============================================

export interface RoomMember {
  id: string;
  name: string;
  championId: number;
  championAlias: string;
  skinId: number;
  chromaId: number;
  isReady?: boolean;
  /** v3+: when true the member's skin is held for this match. Stripped on v2/v1 emits. */
  lockedSkin?: boolean;
}

export interface SynergyInfo {
  colors: Array<{
    type: "sameColor";
    color: string;
    members: string[];
    coverage: number;
    combinationCount: number;
  }>;
  skinLines: Array<{
    type: "skinLine";
    skinLineId: number;
    skinLineName: string;
    members: string[];
    coverage: number;
    combinationCount: number;
  }>; // Story 6.2
}

/**
 * V1 (legacy) - No version field
 */
export interface RoomStateV1 {
  id: string;
  code: string;
  ownerId: string;
  members: RoomMember[];
  synergy?: SynergyInfo;
  activeSynergy?: {
    type: string;
    color?: string;
    skinLineId?: number;
    skinLineName?: string;
    timestamp: number;
  };
  activeColor?: string;
  syncMode?: string; // Story 6.2
}

/**
 * V2 (current) - With version field
 */
export interface RoomStateV2 extends VersionedPayload {
  version: 2;
  id: string;
  code: string;
  ownerId: string;
  members: RoomMember[];
  synergy?: SynergyInfo;
  activeSynergy?: {
    type: string;
    color?: string;
    skinLineId?: number;
    skinLineName?: string;
    timestamp: number;
  };
  activeColor?: string;
  syncMode?: string; // Story 6.2
}

/**
 * V3 (current) - members include lockedSkin
 */
export interface RoomStateV3 extends VersionedPayload {
  version: 3;
  id: string;
  code: string;
  ownerId: string;
  members: RoomMember[];
  synergy?: SynergyInfo;
  activeSynergy?: {
    type: string;
    color?: string;
    skinLineId?: number;
    skinLineName?: string;
    timestamp: number;
  };
  activeColor?: string;
  syncMode?: string;
}

export type VersionedRoomStatePayload = RoomStateV1 | RoomStateV2 | RoomStateV3;

// ============================================
// group-apply-combo Event Versions
// ============================================

export interface ComboPick {
  memberId: string;
  skinId: number;
  chromaId: number;
}

/**
 * V1 (legacy) - No version field
 */
export interface GroupApplyComboV1 {
  type: "sameColor" | "skinLine";
  color?: string;
  skinLineId?: number;
  skinLineName?: string;
  picks: ComboPick[];
  sourceMemberId?: string;
  autoApplied?: boolean;
}

/**
 * V2 (current) - With version field
 */
export interface GroupApplyComboV2 extends VersionedPayload {
  version: 2;
  type: "sameColor" | "skinLine";
  color?: string;
  skinLineId?: number;
  skinLineName?: string;
  picks: ComboPick[];
  sourceMemberId?: string;
  autoApplied?: boolean;
}

export type VersionedGroupApplyComboPayload = GroupApplyComboV1 | GroupApplyComboV2;

// ============================================
// room-closed Event (no versioning needed - simple payload)
// ============================================

// Note: RoomClosedPayload is defined in socket-events.ts, not versioned here

// ============================================
// Helper Types
// ============================================

export type EventVersion = 1 | 2 | 3;

export function isV2Payload(payload: unknown): payload is VersionedPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "version" in payload &&
    (payload as VersionedPayload).version >= 2
  );
}
