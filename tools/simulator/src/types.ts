// Mirror of backend GroupSkinOption — kept in sync manually
export type GroupSkinOption = {
  skinId: number;
  chromaId: number; // 0 = base
  auraColor: string | null;
  skinLineId?: number;
  skinLineName?: string;
};

// --- Simulator-specific types ---

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
