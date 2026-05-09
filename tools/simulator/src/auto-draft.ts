/**
 * Coordinated auto-draft: pick N champions whose skin lines maximize the
 * skin-line synergy potential of the room — optionally anchored on a
 * "target" champion the user is going to play.
 *
 * Why skin-line overlap as the proxy: skin-line groupings (Project, Star
 * Guardian, Arcade, Battle Academia, etc.) are strongly correlated with
 * shared chroma palettes — champions in the same Project line all have
 * cyan/black/red metallic chromas, etc. So maximizing line overlap also
 * maximizes color-overlap *in expectation*, without us having to fetch
 * chroma colors for ~170 champions up front (which would be 170+ API calls).
 *
 * Algorithm: greedy with anchor expansion.
 *  1. Anchor set = lines(target) if a target is given, else empty.
 *  2. Loop count times:
 *     - Score each candidate by `|lines(c) ∩ anchor| × 1000 + |lines(c)| + jitter`.
 *       The jitter (random ε) gives variety across runs when several
 *       candidates are equally good.
 *     - Pick the highest-scoring candidate, exclude it from future picks.
 *     - Expand `anchor ← anchor ∪ lines(picked)` so the next pick converges
 *       on the same skin-line cluster (so all fakes end up in overlapping
 *       lines, not just paired with the target).
 */

import { fetchChampionSkinLineMap } from "./cdragon.service";

export interface AutoDraftPick {
  championId: number;
  /** Number of skin lines this champion shares with the anchor at pick time. */
  sharedLines: number;
  /** Total themed (non-Base) skin lines this champion is part of. */
  totalLines: number;
}

export interface AutoDraftOptions {
  /** Target champion (e.g. the user's pick). Anchors the optimization. */
  target?: number;
  /** Champion IDs that must NOT be returned (e.g. already-picked in the room). */
  excludeIds?: Iterable<number>;
}

/**
 * Pick `count` champions optimized for skin-line overlap with each other
 * (and optionally with `target`). Returns fewer entries than `count` if
 * the candidate pool runs out (which would only happen with absurd counts).
 */
export async function pickOptimalChampions(
  count: number,
  opts: AutoDraftOptions = {}
): Promise<AutoDraftPick[]> {
  if (count <= 0) return [];

  const championInfo = await fetchChampionSkinLineMap();
  const { target, excludeIds = [] } = opts;

  const exclude = new Set<number>();
  for (const id of excludeIds) exclude.add(id);
  if (target !== undefined) exclude.add(target);

  // Anchor = lines we want subsequent picks to overlap with.
  const anchor = new Set<number>();
  if (target !== undefined) {
    const targetLines = championInfo.get(target)?.lines;
    if (targetLines) for (const l of targetLines) anchor.add(l);
  }

  const chosen: AutoDraftPick[] = [];

  while (chosen.length < count) {
    let bestId = -1;
    let bestScore = -Infinity;
    let bestShared = 0;
    let bestTotal = 0;

    for (const [championId, info] of championInfo.entries()) {
      if (exclude.has(championId)) continue;
      if (info.lines.size === 0) continue; // skip champions with no themed lines

      let shared = 0;
      for (const l of info.lines) if (anchor.has(l)) shared++;

      // shared overlap dominates; total-lines breaks ties; jitter adds
      // variety on equally-scored candidates so re-running gives different
      // valid drafts.
      const score = shared * 1000 + info.lines.size + Math.random() * 0.999;

      if (score > bestScore) {
        bestScore = score;
        bestId = championId;
        bestShared = shared;
        bestTotal = info.lines.size;
      }
    }

    if (bestId === -1) break; // pool exhausted

    chosen.push({
      championId: bestId,
      sharedLines: bestShared,
      totalLines: bestTotal,
    });
    exclude.add(bestId);

    // Expand anchor with the new champion's lines so the next iteration
    // tries to stay in the same cluster (or starts a cluster from scratch
    // if there was no target).
    const lines = championInfo.get(bestId)?.lines;
    if (lines) for (const l of lines) anchor.add(l);
  }

  return chosen;
}

/**
 * Single-client auto-pick: choose ONE optimal champion for a fake that's
 * still in lobby, given the current room state's already-locked champions.
 *
 *  - `target`: explicit anchor (overrides inference). Use this when the
 *    operator types "I'm going to play Yasuo".
 *  - Otherwise we infer the target as "the first non-self member with
 *    championId > 0" — usually the real user who just locked.
 *
 * Members with championId > 0 are also added to the exclude set so two
 * fakes don't all converge on the same champion.
 */
export async function pickOneOptimalChampion(opts: {
  selfMemberId: string;
  roomMembers: Array<{ id: string; championId: number }>;
  explicitTarget?: number;
}): Promise<AutoDraftPick | null> {
  const { selfMemberId, roomMembers, explicitTarget } = opts;

  let target = explicitTarget;
  if (target === undefined) {
    const firstOther = roomMembers.find(
      (m) => m.id !== selfMemberId && m.championId > 0
    );
    if (firstOther) target = firstOther.championId;
  }

  const exclude = new Set<number>();
  for (const m of roomMembers) {
    if (m.id !== selfMemberId && m.championId > 0) {
      exclude.add(m.championId);
    }
  }

  const picks = await pickOptimalChampions(1, { target, excludeIds: exclude });
  return picks[0] ?? null;
}
