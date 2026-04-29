import type { GroupSkinOption } from "./index";

// ============================================
// Client → Server Events (Incoming Payloads)
// ============================================

export interface JoinRoomPayload {
  roomId: string;
  memberId: string;
  memberToken: string;
}

export interface LeaveRoomPayload {
  roomId: string;
  memberId: string;
  memberToken: string;
}

export interface UpdateSelectionPayload {
  roomId: string;
  memberId: string;
  memberToken: string;
  championId: number;
  championAlias?: string;
  skinId: number;
  chromaId: number;
}

export interface OwnedOptionsPayload {
  roomId: string;
  memberId: string;
  memberToken: string;
  championId: number;
  championAlias?: string;
  options: GroupSkinOption[];
}

export interface RequestGroupRerollPayload {
  roomId: string;
  memberId: string;
  memberToken: string;
  type: "sameColor";
  color: string;
  skinLineId?: number;
  sourceMemberId?: string;
}

export interface SuggestColorPayload {
  roomId: string;
  memberId: string;
  memberToken: string;
  skinId: number;
  chromaId: number;
}

// Story 6.6: Apply a specific skin line synergy (owner only)
export interface ApplySkinLineSynergyPayload {
  roomId: string;
  memberId: string;
  memberToken: string;
  skinLineId: number;
}

// Per-match skin lock — broadcast by a member to declare they don't want
// auto-apply / owner-applied changes to touch their skin this game.
export interface SetSkinLockPayload {
  roomId: string;
  memberId: string;
  memberToken: string;
  locked: boolean;
}

// ============================================
// Server → Client Events (Outgoing Payloads)
// ============================================

export interface RoomStatePayload {
  id: string;
  code: string;
  ownerId: string;
  members: Array<{
    id: string;
    name: string;
    championId: number;
    championAlias: string;
    skinId: number;
    chromaId: number;
    ready?: boolean;
  }>;
  synergy?: {
    colors: Array<{
      type: "sameColor";
      color: string;
      members: string[];
      coverage: number;
      combinationCount: number;
    }>;
  };
}

export interface RoomClosedPayload {
  reason?: string;
}

export interface GroupApplyComboPayload {
  type: "sameColor";
  color: string;
  picks: Array<{
    memberId: string;
    skinId: number;
    chromaId: number;
  }>;
}

export interface ColorSuggestionReceivedPayload {
  memberId: string;
  senderName: string;
  skinId: number;
  chromaId: number;
}

// ============================================
// Socket.io Event Maps for Type Safety
// ============================================

export interface ClientToServerEvents {
  "join-room": (payload: JoinRoomPayload) => void;
  "leave-room": (payload: LeaveRoomPayload) => void;
  "update-selection": (payload: UpdateSelectionPayload) => void;
  "owned-options": (payload: OwnedOptionsPayload) => void;
  "request-group-reroll": (payload: RequestGroupRerollPayload) => void;
  "suggest-color": (payload: SuggestColorPayload) => void;
  "apply-skin-line-synergy": (payload: ApplySkinLineSynergyPayload) => void;
  "set-skin-lock": (payload: SetSkinLockPayload) => void;
}

export interface ServerToClientEvents {
  "room-state": (payload: RoomStatePayload) => void;
  "room-closed": (payload: RoomClosedPayload) => void;
  "group-apply-combo": (payload: GroupApplyComboPayload) => void;
  "color-suggestion-received": (payload: ColorSuggestionReceivedPayload) => void;
}
