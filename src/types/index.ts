export type GroupSkinOption = {
  skinId: number;
  chromaId: number; // 0 = base
  auraColor: string | null; // e.g. "#6248FF"
  skinLineId?: number; // Story 6.2: skin line ID for synergy matching
  skinLineName?: string; // Story 6.2: skin line name for display
};

// --- Presence System Types (Story 4.2) ---

export type ConnectionInfo = {
  socketId: string;
  summonerName: string;
  connectedAt: Date;
};

// Payload for 'identify' event (C->S)
export type IdentifyPayload = {
  puuid: string;
  summonerName: string;
  friends: string[];
};

// Payload for 'identity-confirmed' event (S->C)
export type IdentityConfirmedPayload = {
  onlineFriends: string[];
};

// Payload for 'friend-online' event (S->C)
export type FriendOnlinePayload = {
  puuid: string;
  summonerName: string;
};

// Payload for 'friend-offline' event (S->C)
export type FriendOfflinePayload = {
  puuid: string;
};

// --- Room Invitation Types (Story 4.5) ---

// Payload for 'send-room-invite' event (C->S)
export type SendRoomInvitePayload = {
  targetPuuid: string;
  roomCode: string;
};

// Payload for 'room-invite-received' event (S->C)
export type RoomInviteReceivedPayload = {
  fromPuuid: string;
  fromName: string;
  roomCode: string;
};

// Payload for 'invite-sent' event (S->C)
export type InviteSentPayload = {
  targetPuuid: string;
};

// Payload for 'invite-failed' event (S->C)
export type InviteFailedPayload = {
  reason: "not_identified" | "not_friend" | "rate_limited" | "friend_offline" | "already_in_room";
};

export type ChromaCombination = {
  color: string;
  members: Array<{ memberId: string; skinId: number; chromaId: number }>;
  timestamp: number;
};

export type Member = {
  id: string;
  name: string;
  championId: number;
  championAlias: string;
  skinId: number;
  chromaId: number;

  // New info for group feature
  options?: GroupSkinOption[];
  isReady: boolean;
};

export type ColorSynergy = {
  type: "sameColor";
  color: string;
  members: string[]; // ids of members who have at least one option of this color
  coverage: number; // members.length / totalMembers
  combinationCount: number; // total possible combinations
};

// Story 6.2: Skin line synergy type
export type SkinLineSynergy = {
  type: "skinLine";
  skinLineId: number;
  skinLineName: string;
  members: string[]; // memberIds who have this skin line
  coverage: number; // % of members (0-1)
  combinationCount: number; // total possible combinations
};

export type SynergySummary = {
  colors: ColorSynergy[];
  skinLines: SkinLineSynergy[]; // Story 6.2: skin line synergies
};

 // Story 6.2: Active synergy applied to the room
export type ActiveSynergy = {
  type: "sameColor" | "skinLine" | "custom";
  color?: string; // For type "sameColor"
  skinLineId?: number; // For type "skinLine"
  skinLineName?: string; // For type "skinLine"
  timestamp: number;
  // Note: "custom" = manual picks via the Builder (Story 6.7)
};

// Story 6.2: Skin line combination for history
export type SkinLineCombination = {
  skinLineId: number;
  skinLineName: string;
  members: Array<{ memberId: string; skinId: number; chromaId: number }>;
  timestamp: number;
};

export type Room = {
  id: string;
  code: string;
  ownerId: string;
  members: Map<string, Member>;
  synergy?: SynergySummary;
  // Active synergy applied
  activeSynergy?: ActiveSynergy;
  activeColor?: string;
  // Group history - stores recent color combinations to avoid repetition
  history: ChromaCombination[];
  // Story 6.2: skin line history
  skinLineHistory: SkinLineCombination[];
};

// Re-export socket event types for convenience
export * from "./socket-events";

// Re-export event version types
export * from "./event-versions";
