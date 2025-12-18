export type GroupSkinOption = {
  skinId: number;
  chromaId: number; // 0 = base
  auraColor: string | null; // e.g. "#6248FF"
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
};
