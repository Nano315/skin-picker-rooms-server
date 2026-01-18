import type { GroupSkinOption } from "./index";

// ============================================
// Client → Server Events (Incoming Payloads)
// ============================================

export interface JoinRoomPayload {
  roomId: string;
  memberId: string;
}

export interface LeaveRoomPayload {
  roomId: string;
  memberId: string;
}

export interface UpdateSelectionPayload {
  roomId: string;
  memberId: string;
  championId: number;
  championAlias?: string;
  skinId: number;
  chromaId: number;
}

export interface OwnedOptionsPayload {
  roomId: string;
  memberId: string;
  championId: number;
  championAlias?: string;
  options: GroupSkinOption[];
}

export interface RequestGroupRerollPayload {
  roomId: string;
  memberId: string;
  type: "sameColor";
  color: string;
  sourceMemberId?: string;
}

export interface SuggestColorPayload {
  roomId: string;
  memberId: string;
  skinId: number;
  chromaId: number;
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
}

export interface ServerToClientEvents {
  "room-state": (payload: RoomStatePayload) => void;
  "room-closed": (payload: RoomClosedPayload) => void;
  "group-apply-combo": (payload: GroupApplyComboPayload) => void;
  "color-suggestion-received": (payload: ColorSuggestionReceivedPayload) => void;
}
