import { GroupSkinOption } from "./types";
import {
  fetchChampionData,
  fetchSkinLines,
  getSkinLineForSkin,
  fetchChromaColor,
} from "./cdragon.service";

const BATCH_SIZE = 10;

interface ProgressCallback {
  (current: number, total: number): void;
}

export async function buildOwnedOptions(
  championId: number,
  onProgress?: ProgressCallback
): Promise<GroupSkinOption[]> {
  // Fetch champion data and skin lines in parallel
  const [champData] = await Promise.all([
    fetchChampionData(championId),
    fetchSkinLines(),
  ]);

  const options: GroupSkinOption[] = [];

  // Collect all chromas that need color fetching
  const chromaJobs: Array<{
    skinId: number;
    chromaId: number;
    skinLineId?: number;
    skinLineName?: string;
  }> = [];

  for (const skin of champData.skins) {
    const skinLine = getSkinLineForSkin(skin.id);

    // Base option for the skin (no chroma)
    options.push({
      skinId: skin.id,
      chromaId: 0,
      auraColor: null,
      skinLineId: skinLine?.id,
      skinLineName: skinLine?.name,
    });

    // Queue chroma color fetches
    for (const chroma of skin.chromas ?? []) {
      chromaJobs.push({
        skinId: skin.id,
        chromaId: chroma.id,
        skinLineId: skinLine?.id,
        skinLineName: skinLine?.name,
      });
    }
  }

  // Fetch chroma colors in batches
  let completed = 0;
  const total = chromaJobs.length;

  for (let i = 0; i < chromaJobs.length; i += BATCH_SIZE) {
    const batch = chromaJobs.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (job) => {
        const auraColor = await fetchChromaColor(job.chromaId, championId);
        return {
          skinId: job.skinId,
          chromaId: job.chromaId,
          auraColor,
          skinLineId: job.skinLineId,
          skinLineName: job.skinLineName,
        } as GroupSkinOption;
      })
    );

    options.push(...results);
    completed += batch.length;

    if (onProgress && total > 0) {
      onProgress(completed, total);
    }
  }

  return options;
}
