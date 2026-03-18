import {
  CDragonChampionData,
  CDragonSkinLine,
  CDragonChromaDetail,
  CDragonChampionSummaryEntry,
} from "./types";

const CDRAGON_BASE =
  "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1";

// --- In-memory caches ---
const championCache = new Map<number, CDragonChampionData>();
let skinLinesCache: Map<number, CDragonSkinLine> | null = null;
let skinToLineCache: Map<number, CDragonSkinLine> | null = null;
let championSummaryCache: CDragonChampionSummaryEntry[] | null = null;

// --- Helpers ---

const hexToRgba = (h: string, alpha = 0.5): string | null => {
  const res = /^#?([0-9a-f]{6})$/i.exec(h);
  if (!res) return null;
  const int = parseInt(res[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r},${g},${b},${alpha})`;
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

// --- Public API ---

export async function fetchChampionData(
  championId: number
): Promise<CDragonChampionData> {
  const cached = championCache.get(championId);
  if (cached) return cached;

  const url = `${CDRAGON_BASE}/champions/${championId}.json`;
  const data = await fetchJson<CDragonChampionData>(url);
  championCache.set(championId, data);
  return data;
}

export async function fetchChampionAlias(
  championId: number
): Promise<string> {
  if (!championSummaryCache) {
    const url = `${CDRAGON_BASE}/champion-summary.json`;
    championSummaryCache = await fetchJson<CDragonChampionSummaryEntry[]>(url);
  }

  const entry = championSummaryCache.find((c) => c.id === championId);
  return entry?.alias ?? `Champion${championId}`;
}

export async function fetchSkinLines(): Promise<void> {
  if (skinLinesCache && skinToLineCache) return;

  const [skinLinesRaw, skinsRaw] = await Promise.all([
    fetchJson<CDragonSkinLine[]>(`${CDRAGON_BASE}/skinlines.json`),
    fetchJson<Record<string, { id: number; name: string; skinLines?: Array<{ id: number }> }>>(
      `${CDRAGON_BASE}/skins.json`
    ),
  ]);

  // Build skin line lookup
  skinLinesCache = new Map<number, CDragonSkinLine>();
  for (const sl of skinLinesRaw) {
    skinLinesCache.set(sl.id, sl);
  }

  // Build skinId → skinLine mapping
  skinToLineCache = new Map<number, CDragonSkinLine>();
  for (const [skinIdStr, skin] of Object.entries(skinsRaw)) {
    const skinId = parseInt(skinIdStr, 10);
    if (isNaN(skinId)) continue;

    const firstLine = skin.skinLines?.[0];
    if (firstLine) {
      const lineInfo = skinLinesCache.get(firstLine.id);
      if (lineInfo && lineInfo.id !== 1) {
        // Exclude "Base" skin line (id=1)
        skinToLineCache.set(skinId, lineInfo);
      }
    }
  }
}

export function getSkinLineForSkin(
  skinId: number
): { id: number; name: string } | null {
  if (!skinToLineCache) return null;
  return skinToLineCache.get(skinId) ?? null;
}

export async function fetchChromaColor(
  chromaId: number,
  championId: number
): Promise<string | null> {
  // 1) Try direct chroma endpoint
  try {
    const url = `${CDRAGON_BASE}/chromas/${chromaId}.json`;
    const data = await fetchJson<CDragonChromaDetail>(url);

    const pickHex = (arr?: string[]): string | null =>
      Array.isArray(arr) && typeof arr[0] === "string" ? arr[0] : null;

    const hex = pickHex(data.colorsHexPrefixed) ?? pickHex(data.colors);
    if (hex) return hexToRgba(hex);
  } catch {
    // Fallback to champion data
  }

  // 2) Fallback: find chroma color in champion data
  try {
    const champData = await fetchChampionData(championId);
    for (const skin of champData.skins) {
      for (const chroma of skin.chromas ?? []) {
        if (chroma.id === chromaId) {
          const hex =
            Array.isArray(chroma.colors) && typeof chroma.colors[0] === "string"
              ? chroma.colors[0]
              : null;
          if (hex) return hexToRgba(hex);
        }
      }
    }
  } catch {
    // Give up
  }

  return null;
}
