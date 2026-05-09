/**
 * Interactive pickers used by the CLI to spare the operator from having to
 * remember numeric IDs, hex codes or rgba strings. Every picker here is
 * "show a numbered, contextual list and let the user type a number" —
 * with substring filtering kicking in for big lists (champions, owned skins).
 *
 * Each picker takes the same `ask(question)` callback so the CLI keeps
 * ownership of readline. They return `null` on user cancel (empty input).
 */

import {
  CDragonChampionData,
  GroupSkinOption,
  RoomStateColorSynergy,
  RoomStatePayload,
  RoomStateSkinLineSynergy,
} from "./types";
import {
  fetchChampionData,
  searchChampion,
} from "./cdragon.service";

// --- ANSI ---
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";

export type AskFn = (question: string) => Promise<string>;

// --- Color helpers ---------------------------------------------------------

function parseRgba(s: string): [number, number, number] | null {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/** Returns a colored block char rendered with the rgba color (terminal true-color). */
export function colorSwatch(
  rgba: string | null | undefined,
  char = "███"
): string {
  if (!rgba) return DIM + char + RESET;
  const rgb = parseRgba(rgba);
  if (!rgb) return DIM + char + RESET;
  const [r, g, b] = rgb;
  return `\x1b[38;2;${r};${g};${b}m${char}${RESET}`;
}

/** "rgba(98,72,255,0.5)" -> "#6248FF" — short, copy-pastable. */
export function rgbaToHex(rgba: string | null | undefined): string {
  if (!rgba) return "—";
  const rgb = parseRgba(rgba);
  if (!rgb) return rgba;
  const [r, g, b] = rgb;
  return (
    "#" +
    [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase()
  );
}

// --- Generic numbered picker ----------------------------------------------

interface PickerEntry<T> {
  value: T;
  label: string;
}

/**
 * Show a numbered list, parse the user's pick. Returns null on cancel.
 * If `entries.length > pageSize`, the user is asked for an optional substring
 * filter first to narrow the list down.
 */
export async function pickFromList<T>(
  ask: AskFn,
  entries: PickerEntry<T>[],
  promptLabel: string,
  opts?: { pageSize?: number }
): Promise<T | null> {
  if (entries.length === 0) {
    console.log(`${YELLOW}Aucune option disponible.${RESET}`);
    return null;
  }

  const pageSize = opts?.pageSize ?? 30;
  let active = entries;

  if (entries.length > pageSize) {
    const filter = await ask(
      `${DIM}Filtre (substring, Enter pour tout afficher) : ${RESET}`
    );
    if (filter.trim()) {
      const norm = filter.trim().toLowerCase();
      active = entries.filter((e) =>
        stripAnsi(e.label).toLowerCase().includes(norm)
      );
    }
    if (active.length === 0) {
      console.log(`${YELLOW}Aucun résultat pour "${filter.trim()}".${RESET}`);
      return null;
    }
  }

  const shown = active.slice(0, pageSize);
  console.log(`\n${BOLD}${promptLabel}${RESET}`);
  for (let i = 0; i < shown.length; i++) {
    console.log(`  ${GREEN}[${i + 1}]${RESET} ${shown[i].label}`);
  }
  if (active.length > pageSize) {
    console.log(
      `${DIM}  (${active.length - pageSize} autres masqués — affinez le filtre)${RESET}`
    );
  }

  const pick = await ask(`\n${DIM}Numéro (Enter pour annuler) : ${RESET}`);
  if (!pick.trim()) return null;

  const idx = parseInt(pick, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= shown.length) {
    console.log(`${YELLOW}Sélection invalide.${RESET}`);
    return null;
  }
  return shown[idx].value;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// --- Champion picker (fuzzy + numeric ID) ---------------------------------

/**
 * Champion picker. Accepts:
 *   - empty input (cancel → returns null)
 *   - a numeric champion ID (returned as-is, no validation)
 *   - a name / alias / fuzzy match (CDragon search, may show a numbered list)
 */
export async function pickChampion(ask: AskFn): Promise<number | null> {
  const input = await ask(
    `${DIM}Champion (nom, alias ou ID — fuzzy search) : ${RESET}`
  );
  if (!input.trim()) return null;

  const asId = parseInt(input.trim(), 10);
  if (!isNaN(asId) && String(asId) === input.trim() && asId > 0) {
    return asId;
  }

  console.log(`${DIM}Recherche...${RESET}`);
  const results = await searchChampion(input.trim());

  if (results.length === 0) {
    console.log(`${YELLOW}Aucun champion trouvé pour "${input.trim()}".${RESET}`);
    return null;
  }

  // Auto-pick on a single exact-normalized match (score 0).
  const exact = results.filter((r) => r.score === 0);
  if (exact.length === 1) {
    console.log(
      `${GREEN}→ ${exact[0].name}${RESET} ${DIM}(alias: ${exact[0].alias}, ID: ${exact[0].id})${RESET}`
    );
    return exact[0].id;
  }

  const entries: PickerEntry<number>[] = results.slice(0, 15).map((r) => ({
    value: r.id,
    label: `${r.name} ${DIM}— alias ${r.alias}, ID ${r.id}${RESET}`,
  }));

  return pickFromList(ask, entries, "Résultats :");
}

// --- Synergy pickers (read latest room state) -----------------------------

/**
 * Pick a color synergy from the room's current state.
 * Used by `request-group-reroll`, sorted by best (highest coverage / combos first).
 */
export async function pickColorSynergy(
  ask: AskFn,
  room: RoomStatePayload | null
): Promise<RoomStateColorSynergy | null> {
  const colors = room?.synergy?.colors ?? [];
  if (!colors.length) {
    console.log(
      `${YELLOW}Aucune synergie de couleur dans la room. Au moins 2 membres doivent être en champion select.${RESET}`
    );
    return null;
  }

  const sorted = [...colors].sort(
    (a, b) =>
      b.coverage - a.coverage || b.combinationCount - a.combinationCount
  );

  const entries: PickerEntry<RoomStateColorSynergy>[] = sorted.map((s) => {
    const swatch = colorSwatch(s.color, "■■■");
    const pct = Math.round(s.coverage * 100);
    return {
      value: s,
      label: `${swatch} ${rgbaToHex(s.color)}  ${DIM}— ${s.members.length} membres (${pct}% cov), ${s.combinationCount} combos${RESET}`,
    };
  });

  return pickFromList(ask, entries, "Synergies de couleur disponibles :");
}

/**
 * Pick a skin-line synergy from the room's current state.
 * Used by `apply-skin-line-synergy`, sorted by best first.
 */
export async function pickSkinLineSynergy(
  ask: AskFn,
  room: RoomStatePayload | null
): Promise<RoomStateSkinLineSynergy | null> {
  const lines = room?.synergy?.skinLines ?? [];
  if (!lines.length) {
    console.log(
      `${YELLOW}Aucune synergie de lignée de skin dans la room.${RESET}`
    );
    return null;
  }

  const sorted = [...lines].sort(
    (a, b) =>
      b.coverage - a.coverage || b.combinationCount - a.combinationCount
  );

  const entries: PickerEntry<RoomStateSkinLineSynergy>[] = sorted.map((s) => {
    const pct = Math.round(s.coverage * 100);
    return {
      value: s,
      label: `${MAGENTA}${s.skinLineName}${RESET} ${DIM}(ID ${s.skinLineId}) — ${s.members.length} membres (${pct}% cov), ${s.combinationCount} combos${RESET}`,
    };
  });

  return pickFromList(
    ask,
    entries,
    "Synergies de lignée de skin disponibles :"
  );
}

// --- Owned-options picker (suggest-color, member needs to be in-draft) ----

/**
 * Pick a (skinId, chromaId) from a member's owned-options. Used by guests
 * to suggest a color/chroma to the room. The picker is two-step: first the
 * skin (with a per-skin chroma count), then the chroma (with a true-color
 * swatch preview if the chroma's auraColor is known).
 */
export async function pickSkinAndChromaFromOptions(
  ask: AskFn,
  options: GroupSkinOption[],
  championId: number
): Promise<{ skinId: number; chromaId: number } | null> {
  if (!options.length) {
    console.log(
      `${YELLOW}Pas d'options chargées. Entre en champion select d'abord.${RESET}`
    );
    return null;
  }

  const bySkin = new Map<number, GroupSkinOption[]>();
  for (const o of options) {
    if (!bySkin.has(o.skinId)) bySkin.set(o.skinId, []);
    bySkin.get(o.skinId)!.push(o);
  }

  // Best-effort fetch for human-readable skin names.
  let championData: CDragonChampionData | null = null;
  try {
    championData = await fetchChampionData(championId);
  } catch {
    /* fall through — names degrade to "Skin <id>" */
  }

  const skinName = (skinId: number): string => {
    const s = championData?.skins.find((sk) => sk.id === skinId);
    return s?.name ?? `Skin ${skinId}`;
  };

  // Step 1: pick the skin
  const skinEntries: PickerEntry<number>[] = Array.from(bySkin.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([sid, opts]) => {
      const name = skinName(sid);
      const chromaCount = opts.filter((o) => o.chromaId !== 0).length;
      const lineLbl = opts[0].skinLineName
        ? ` ${DIM}[${opts[0].skinLineName}]${RESET}`
        : "";
      const chromaLbl =
        chromaCount > 0
          ? `${chromaCount} chroma${chromaCount > 1 ? "s" : ""}`
          : "base only";
      return {
        value: sid,
        label: `${name}${lineLbl}  ${DIM}— ${chromaLbl}${RESET}`,
      };
    });

  const skinId = await pickFromList(ask, skinEntries, "Skins disponibles :");
  if (skinId === null) return null;

  // Step 2: pick a chroma (or base)
  const chromaOpts = bySkin
    .get(skinId)!
    .slice()
    .sort((a, b) => a.chromaId - b.chromaId);

  const chromaEntries: PickerEntry<number>[] = chromaOpts.map((o) => {
    const isBase = o.chromaId === 0;
    const swatch = colorSwatch(o.auraColor, "■■");
    const tag = isBase ? `${BOLD}Base${RESET}` : `Chroma ${o.chromaId}`;
    return {
      value: o.chromaId,
      label: `${swatch}  ${tag} ${DIM}${rgbaToHex(o.auraColor)}${RESET}`,
    };
  });

  const chromaId = await pickFromList(
    ask,
    chromaEntries,
    "Choisis un skin/chroma :"
  );
  if (chromaId === null) return null;

  return { skinId, chromaId };
}

// --- Member picker (kick) -------------------------------------------------

/**
 * Pick a member from the room state — used by the owner's kick action.
 * Excludes the operator themselves (the owner can't kick himself).
 */
export async function pickRoomMember(
  ask: AskFn,
  room: RoomStatePayload | null,
  excludeMemberId: string
): Promise<{ id: string; name: string } | null> {
  const members = (room?.members ?? []).filter((m) => m.id !== excludeMemberId);
  if (!members.length) {
    console.log(`${YELLOW}Aucun autre membre à sélectionner.${RESET}`);
    return null;
  }
  const entries: PickerEntry<{ id: string; name: string }>[] = members.map(
    (m) => {
      const champ = m.championAlias || (m.championId > 0 ? `#${m.championId}` : `${DIM}lobby${RESET}`);
      return {
        value: { id: m.id, name: m.name },
        label: `${m.name}  ${DIM}— ${champ}${RESET}`,
      };
    }
  );
  return pickFromList(ask, entries, "Choisis un membre :");
}

// --- Room code picker (join) ----------------------------------------------

/**
 * Show a list of known room codes (from existing simulated owners), plus
 * an option to type a custom code. Lets the user join a real-app room
 * without having to copy-paste the code from another window.
 */
export async function pickRoomCode(
  ask: AskFn,
  knownRooms: Array<{ code: string; ownerName: string }>
): Promise<string | null> {
  if (knownRooms.length === 0) {
    const code = await ask(`${DIM}Code room (8 chars) : ${RESET}`);
    return code.trim() ? code.trim().toUpperCase() : null;
  }

  type Choice = { code: string } | { custom: true };
  const entries: PickerEntry<Choice>[] = knownRooms.map((r) => ({
    value: { code: r.code },
    label: `${CYAN}${r.code}${RESET} ${DIM}(owner: ${r.ownerName})${RESET}`,
  }));
  entries.push({
    value: { custom: true },
    label: `${DIM}Saisir un autre code...${RESET}`,
  });

  const choice = await pickFromList(ask, entries, "Rooms connues :");
  if (!choice) return null;
  if ("code" in choice) return choice.code;

  const code = await ask(`${DIM}Code room (8 chars) : ${RESET}`);
  return code.trim() ? code.trim().toUpperCase() : null;
}
