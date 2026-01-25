/**
 * Version Adapter Utilities
 *
 * Handles transforming payloads between different event versions
 * to maintain backwards compatibility with older clients.
 */

import type {
  EventVersion,
  ColorSuggestionV1,
  ColorSuggestionV2,
  RoomStateV1,
  RoomStateV2,
  GroupApplyComboV1,
  GroupApplyComboV2,
  RoomMember,
  SynergyInfo,
  ComboPick,
} from "../types";
import { CURRENT_EVENT_VERSION } from "../types";

// ============================================
// Socket Version Registry
// ============================================

const socketVersions = new Map<string, EventVersion>();

/**
 * Register a client's supported version
 */
export function registerClientVersion(socketId: string, version: number): EventVersion {
  const safeVersion = Math.max(1, Math.min(version, CURRENT_EVENT_VERSION)) as EventVersion;
  socketVersions.set(socketId, safeVersion);
  return safeVersion;
}

/**
 * Get a client's registered version (default to v1 for backwards compat)
 */
export function getClientVersion(socketId: string): EventVersion {
  return socketVersions.get(socketId) ?? 1;
}

/**
 * Remove client version on disconnect
 */
export function removeClientVersion(socketId: string): void {
  socketVersions.delete(socketId);
}

// ============================================
// Color Suggestion Adapters
// ============================================

interface ColorSuggestionData {
  memberId: string;
  memberName: string;
  skinId: number;
  chromaId: number;
}

export function createColorSuggestionPayload(
  data: ColorSuggestionData,
  clientVersion: EventVersion
): ColorSuggestionV1 | ColorSuggestionV2 {
  if (clientVersion >= 2) {
    return {
      version: 2,
      memberId: data.memberId,
      memberName: data.memberName,
      skinId: data.skinId,
      chromaId: data.chromaId,
    };
  }

  // V1 format (legacy) - uses senderName instead of memberName
  return {
    memberId: data.memberId,
    senderName: data.memberName,
    skinId: data.skinId,
    chromaId: data.chromaId,
  };
}

// ============================================
// Room State Adapters
// ============================================

interface RoomStateData {
  id: string;
  code: string;
  ownerId: string;
  members: RoomMember[];
  synergy?: SynergyInfo;
  activeSynergy?: {
    type: string;
    color: string;
    timestamp: number;
  };
  activeColor?: string;
}

export function createRoomStatePayload(
  data: RoomStateData,
  clientVersion: EventVersion
): RoomStateV1 | RoomStateV2 {
  if (clientVersion >= 2) {
    return {
      version: 2,
      ...data,
    };
  }

  // V1 format (legacy) - no version field
  return { ...data };
}

// ============================================
// Group Apply Combo Adapters
// ============================================

interface GroupApplyComboData {
  type: "sameColor";
  color: string;
  picks: ComboPick[];
  sourceMemberId?: string;
  autoApplied?: boolean;
}

export function createGroupApplyComboPayload(
  data: GroupApplyComboData,
  clientVersion: EventVersion
): GroupApplyComboV1 | GroupApplyComboV2 {
  if (clientVersion >= 2) {
    return {
      version: 2,
      ...data,
    };
  }

  // V1 format (legacy) - no version field
  return { ...data };
}

// ============================================
// Broadcast Helper for Version-aware Emission
// ============================================

import type { Server, Socket } from "socket.io";

/**
 * Emit an event to a room with version-appropriate payloads
 * Each client in the room receives the payload in their supported version
 */
export async function emitVersionedToRoom<T>(
  io: Server,
  roomId: string,
  event: string,
  createPayload: (version: EventVersion) => T
): Promise<void> {
  const sockets = await io.in(roomId).fetchSockets();

  for (const socket of sockets) {
    const version = getClientVersion(socket.id);
    const payload = createPayload(version);
    socket.emit(event, payload);
  }
}
