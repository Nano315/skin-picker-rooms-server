export type GroupSkinOption = {
  skinId: number;
  chromaId: number; // 0 = base
  auraColor: string | null; // e.g. "#6248FF"
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

export type SynergySummary = {
  colors: ColorSynergy[];
};

export type Room = {
  id: string;
  code: string;
  ownerId: string;
  members: Map<string, Member>;
  synergy?: SynergySummary;
  // Active synergy applied
  activeSynergy?: {
    type: string;
    color: string;
    timestamp: number;
  };
  activeColor?: string;
  // Group history - stores recent color combinations to avoid repetition
  history: ChromaCombination[];
};

// Re-export socket event types for convenience
export * from "./socket-events";

// Re-export event version types
export * from "./event-versions";
