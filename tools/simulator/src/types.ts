// Mirror of backend GroupSkinOption — kept in sync manually
export type GroupSkinOption = {
  skinId: number;
  chromaId: number; // 0 = base
  auraColor: string | null;
  skinLineId?: number;
  skinLineName?: string;
};

// --- Simulator-specific types ---

/**
 * Lifecycle state of a fake client, mirroring the real LCU player flow:
 *
 * - "lobby":    member of the room but **not** in champion select. championId=0,
 *               skinId=0, no `owned-options` uploaded. Counts as 0 toward
 *               synergy. This is the default state right after creating /
 *               joining a room — same as a real player who is in the
 *               pre-game lobby in League.
 *
 * - "in-draft": in champion select. champion + default skin + owned-options
 *               uploaded. The server will compute synergy from this member's
 *               options and may auto-apply once **every** member of the room
 *               is in this state.
 */
export type ClientLifecycle = "lobby" | "in-draft";

export interface FakeClientConfig {
  puuid: string;
  summonerName: string;
  championId: number;
  role: "owner" | "guest";
  friendPuuids: string[];
}

export interface SimulatorState {
  clients: Map<string, FakeClientConfig>;
  nextClientId: number;
}

// --- Server room-state payload (mirror of backend v3, used for the
//     locally-cached snapshot the pilot menu reads from) ---

export interface RoomStateMember {
  id: string;
  name: string;
  championId: number;
  championAlias: string;
  skinId: number;
  chromaId: number;
  isReady?: boolean;
  /** v3+: per-match skin lock. Stripped on v2/v1 emits. */
  lockedSkin?: boolean;
}

export interface RoomStateColorSynergy {
  type: "sameColor";
  color: string;
  members: string[];
  coverage: number;
  combinationCount: number;
}

export interface RoomStateSkinLineSynergy {
  type: "skinLine";
  skinLineId: number;
  skinLineName: string;
  members: string[];
  coverage: number;
  combinationCount: number;
}

export interface RoomStatePayload {
  id: string;
  code: string;
  ownerId: string;
  members: RoomStateMember[];
  synergy?: {
    colors: RoomStateColorSynergy[];
    skinLines?: RoomStateSkinLineSynergy[];
  };
  activeSynergy?: {
    type: string;
    color?: string;
    skinLineId?: number;
    skinLineName?: string;
    timestamp: number;
  };
  activeColor?: string;
  version?: number;
}

// --- Community Dragon API response types ---

export interface CDragonChroma {
  id: number;
  name: string;
  chromaPath: string;
  colors: string[];
}

export interface CDragonSkin {
  id: number;
  name: string;
  isBase: boolean;
  chromas: CDragonChroma[];
  skinLines?: Array<{ id: number }>;
}

export interface CDragonChampionData {
  id: number;
  name: string;
  alias: string;
  skins: CDragonSkin[];
}

export interface CDragonSkinLine {
  id: number;
  name: string;
}

export interface CDragonChromaDetail {
  id: number;
  name: string;
  colorsHexPrefixed?: string[];
  colors?: string[];
}

export interface CDragonChampionSummaryEntry {
  id: number;
  name: string;
  alias: string;
}
