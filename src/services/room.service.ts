import { randomUUID, randomInt, randomBytes, timingSafeEqual } from "crypto";
import { Room, Member, ColorSynergy, SkinLineSynergy, ChromaCombination, SkinLineCombination, GroupSkinOption } from "../types";
import { logger } from "../utils/logger";

const GROUP_HISTORY_LIMIT = 3;

function generateMemberToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Constant-time comparison of a provided member token with the stored one.
 * Returns false for any type/length mismatch.
 */
export function verifyMemberToken(stored: string, provided: unknown): boolean {
  if (typeof provided !== "string" || provided.length !== stored.length) {
    return false;
  }
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class RoomService {
  private static instance: RoomService;
  public rooms = new Map<string, Room>();
  public roomsByCode = new Map<string, Room>();

  private constructor() {}

  public static getInstance(): RoomService {
    if (!RoomService.instance) {
      RoomService.instance = new RoomService();
    }
    return RoomService.instance;
  }

  private generateRoomCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const length = 8;
    const maxAttempts = 32;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let code = "";
      for (let i = 0; i < length; i++) {
        code += alphabet[randomInt(0, alphabet.length)];
      }
      if (!this.roomsByCode.has(code)) {
        return code;
      }
    }
    throw new Error("Failed to generate a unique room code after maxAttempts");
  }

  public createRoom(ownerName: string): { room: Room; member: Member } {
    const roomId = randomUUID();
    const code = this.generateRoomCode();
    const ownerId = randomUUID();

    const owner: Member = {
      id: ownerId,
      name: ownerName,
      token: generateMemberToken(),
      championId: 0,
      championAlias: "",
      skinId: 0,
      chromaId: 0,
      isReady: false,
      lockedSkin: false,
    };

    const room: Room = {
      id: roomId,
      code,
      ownerId,
      members: new Map([[ownerId, owner]]),
      history: [],
      skinLineHistory: [],
    };

    this.rooms.set(roomId, room);
    this.roomsByCode.set(code, room);
    
    logger.info(`Room created: ${roomId} (Code: ${code}) by ${ownerName}`);
    return { room, member: owner };
  }

  public createBotRoom(): { room: Room; member: Member } {
    const { room, member } = this.createRoom("Bot Owner");
    
    // Customize the bot
    member.championId = randomInt(1, 160);
    member.skinId = randomInt(26000, 26050); // Just some random range
    member.chromaId = 0;
    member.isReady = true;

    // We could add options if we want to test synergy immediately
    // For now, simple ready bot
    
    return { room, member };
  }

  public getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  public getRoomByCode(code: string): Room | undefined {
    return this.roomsByCode.get(code);
  }

  public joinRoom(code: string, memberName: string): { room: Room; member: Member } | { error: string, status: number } {
    const room = this.roomsByCode.get(code);
    if (!room) {
      return { error: "Room not found", status: 404 };
    }

    if (room.members.size >= 5) {
      return { error: "Room is full", status: 403 };
    }

    const memberId = randomUUID();
    const member: Member = {
      id: memberId,
      name: memberName,
      token: generateMemberToken(),
      championId: 0,
      championAlias: "",
      skinId: 0,
      chromaId: 0,
      isReady: false,
      lockedSkin: false,
    };

    room.members.set(memberId, member);
    // Recalculate synergy immediately? Not necessary as they have no options yet.
    
    logger.info(`Member ${memberName} (${memberId}) joined room ${room.id}`);
    return { room, member };
  }

  /**
   * Set a member's per-match skin lock. Returns true if the value changed,
   * false if the member doesn't exist or the value is already what's set.
   */
  public setMemberSkinLock(room: Room, memberId: string, locked: boolean): boolean {
    const member = room.members.get(memberId);
    if (!member) return false;
    const next = !!locked;
    if (member.lockedSkin === next) return false;
    member.lockedSkin = next;
    return true;
  }

  public removeMember(room: Room, memberId: string): { roomClosed: boolean; reason?: string } {
    const member = room.members.get(memberId);
    if (!member) return { roomClosed: false };

    room.members.delete(memberId);

    if (memberId === room.ownerId) {
      this.closeRoom(room);
      return { roomClosed: true, reason: "owner-left" };
    }

    if (room.members.size === 0) {
      this.closeRoom(room);
      return { roomClosed: true, reason: "empty" };
    }

    this.recomputeSynergy(room);
    return { roomClosed: false };
  }

  private closeRoom(room: Room) {
    this.rooms.delete(room.id);
    this.roomsByCode.delete(room.code);
    logger.info(`Room closed: ${room.id}`);
  }

  public recomputeSynergy(room: Room) {
    const allMembers = Array.from(room.members.values());
    // For synergy purposes, we only care about members who have submitted options.
    const readyMembers = allMembers.filter((m) => m.options && m.options.length > 0);

    if (readyMembers.length < 2) { // Cannot have a synergy with less than 2 people.
      room.synergy = { colors: [], skinLines: [] };
      return;
    }

    const allColors = new Set<string>();
    for (const m of readyMembers) {
      for (const opt of m.options!) {
        if (opt.auraColor) {
          allColors.add(opt.auraColor);
        }
      }
    }

    const synergies: ColorSynergy[] = [];

    for (const color of allColors) {
      const participants: string[] = [];
      let combinationCount = 1;

      for (const member of readyMembers) {
        const memberOptionsWithColor = (member.options ?? []).filter(
          (o) => o.auraColor === color
        );

        if (memberOptionsWithColor.length > 0) {
          participants.push(member.id);
          combinationCount *= memberOptionsWithColor.length;
        }
      }

      if (participants.length > 1) {
        synergies.push({
          type: "sameColor",
          color,
          members: participants,
          coverage: participants.length / allMembers.length,
          combinationCount,
        });
      }
    }

    synergies.sort(
      (a, b) => b.coverage - a.coverage || b.combinationCount - a.combinationCount
    );

    // --- Skin line synergy computation (Story 6.3) ---
    const allSkinLines = new Map<number, { name: string; memberOptions: Map<string, GroupSkinOption[]> }>();

    for (const member of readyMembers) {
      for (const opt of member.options!) {
        if (opt.skinLineId != null) {
          if (!allSkinLines.has(opt.skinLineId)) {
            allSkinLines.set(opt.skinLineId, {
              name: opt.skinLineName || `SkinLine ${opt.skinLineId}`,
              memberOptions: new Map(),
            });
          }
          const lineData = allSkinLines.get(opt.skinLineId)!;
          if (!lineData.memberOptions.has(member.id)) {
            lineData.memberOptions.set(member.id, []);
          }
          lineData.memberOptions.get(member.id)!.push(opt);
        }
      }
    }

    const skinLineSynergies: SkinLineSynergy[] = [];

    for (const [skinLineId, { name, memberOptions }] of allSkinLines) {
      if (memberOptions.size >= 2) {
        const participants = Array.from(memberOptions.keys());
        let combinationCount = 1;
        for (const opts of memberOptions.values()) {
          combinationCount *= opts.length;
        }

        skinLineSynergies.push({
          type: "skinLine",
          skinLineId,
          skinLineName: name,
          members: participants,
          coverage: participants.length / allMembers.length,
          combinationCount,
        });
      }
    }

    // Exclude Base (id=1) unless it's the only skin line synergy
    const nonBaseSynergies = skinLineSynergies.filter((s) => s.skinLineId !== 1);
    const finalSkinLineSynergies = nonBaseSynergies.length > 0 ? nonBaseSynergies : skinLineSynergies;

    finalSkinLineSynergies.sort(
      (a, b) => b.coverage - a.coverage || b.combinationCount - a.combinationCount
    );

    room.synergy = { colors: synergies, skinLines: finalSkinLineSynergies };

    if (synergies.length > 0) {
      logger.debug(`[Synergy] Room ${room.code}: Found ${synergies.length} color synergies (Best: ${synergies[0].color})`);
    }
    if (finalSkinLineSynergies.length > 0) {
      logger.debug(`[Synergy] Room ${room.code}: Found ${finalSkinLineSynergies.length} skin line synergies (Best: ${finalSkinLineSynergies[0].skinLineName}, coverage: ${finalSkinLineSynergies[0].coverage})`);
    }
  }

  /**
   * Get available synergies filtering out recently used colors
   */
  public getAvailableSynergies(room: Room): ColorSynergy[] {
    if (!room.synergy || room.synergy.colors.length === 0) {
      return [];
    }

    const recentColors = room.history.map((h) => h.color);
    const filtered = room.synergy.colors.filter(
      (s) => !recentColors.includes(s.color)
    );

    // Fallback: if all synergies are in history, return all synergies
    return filtered.length > 0 ? filtered : room.synergy.colors;
  }

  /**
   * Add a color combination to room history
   */
  public addToHistory(
    room: Room,
    color: string,
    picks: Array<{ memberId: string; skinId: number; chromaId: number }>
  ): void {
    const combination: ChromaCombination = {
      color,
      members: picks,
      timestamp: Date.now(),
    };

    room.history.push(combination);

    // Keep only the last N combinations (FIFO)
    while (room.history.length > GROUP_HISTORY_LIMIT) {
      room.history.shift();
    }

    logger.debug(
      `[History] Room ${room.code}: Added color ${color} to history (${room.history.length}/${GROUP_HISTORY_LIMIT})`
    );
  }

  /**
   * Get available skin line synergies filtering out recently used skin lines
   */
  public getAvailableSkinLineSynergies(room: Room): SkinLineSynergy[] {
    if (!room.synergy?.skinLines?.length) return [];

    const recentSkinLines = (room.skinLineHistory ?? []).map((h) => h.skinLineId);
    const filtered = room.synergy.skinLines.filter(
      (s) => !recentSkinLines.includes(s.skinLineId)
    );

    return filtered.length > 0 ? filtered : room.synergy.skinLines;
  }

  /**
   * Add a skin line combination to room history
   */
  public addSkinLineToHistory(
    room: Room,
    skinLineId: number,
    skinLineName: string,
    picks: Array<{ memberId: string; skinId: number; chromaId: number }>
  ): void {
    const combination: SkinLineCombination = {
      skinLineId,
      skinLineName,
      members: picks,
      timestamp: Date.now(),
    };

    room.skinLineHistory.push(combination);

    while (room.skinLineHistory.length > GROUP_HISTORY_LIMIT) {
      room.skinLineHistory.shift();
    }

    logger.debug(
      `[History] Room ${room.code}: Added skin line ${skinLineName} to history (${room.skinLineHistory.length}/${GROUP_HISTORY_LIMIT})`
    );
  }

  /**
   * Generate picks based on a random skin line synergy.
   * chromaId is always 0 (base skin, no chroma).
   */
  public generateSkinLinePicks(
    room: Room
  ): { skinLineId: number; skinLineName: string; picks: Array<{ memberId: string; skinId: number; chromaId: number }> } | null {
    const availableSkinLines = this.getAvailableSkinLineSynergies(room);
    if (availableSkinLines.length === 0) return null;

    const idx = randomInt(0, availableSkinLines.length);
    const synergy = availableSkinLines[idx];

    const picks: Array<{ memberId: string; skinId: number; chromaId: number }> = [];

    for (const member of room.members.values()) {
      if (member.lockedSkin) {
        picks.push({ memberId: member.id, skinId: member.skinId, chromaId: member.chromaId });
        continue;
      }
      if (!member.options || member.options.length === 0) {
        picks.push({ memberId: member.id, skinId: member.skinId, chromaId: member.chromaId });
        continue;
      }

      const opts = member.options.filter((o) => o.skinLineId === synergy.skinLineId);
      if (opts.length === 0) {
        picks.push({ memberId: member.id, skinId: member.skinId, chromaId: member.chromaId });
        continue;
      }

      const optIdx = randomInt(0, opts.length);
      const opt = opts[optIdx];

      member.skinId = opt.skinId;
      member.chromaId = 0;

      picks.push({ memberId: member.id, skinId: opt.skinId, chromaId: 0 });
    }

    this.addSkinLineToHistory(room, synergy.skinLineId, synergy.skinLineName, picks);

    room.activeSynergy = {
      type: "skinLine",
      skinLineId: synergy.skinLineId,
      skinLineName: synergy.skinLineName,
      timestamp: Date.now(),
    };

    logger.info(`[AutoApply] Room ${room.code}: Auto-applied skin line ${synergy.skinLineName}`);

    return { skinLineId: synergy.skinLineId, skinLineName: synergy.skinLineName, picks };
  }

  /**
   * Apply a specific color synergy (owner-triggered via `request-group-reroll`).
   * Mirror of `applySkinLineSynergy` for the color path so the locked-member
   * skip and the active-synergy/history bookkeeping live in one place.
   *
   * Optional `skinLineId` narrows the picks to a sub-pool sharing both the
   * given color *and* skin line — used by the chroma-and-line owner action.
   */
  public applyColorSynergy(
    room: Room,
    color: string,
    skinLineId?: number
  ): { color: string; picks: Array<{ memberId: string; skinId: number; chromaId: number }> } | null {
    const entry = room.synergy?.colors.find(
      (c) => c.type === "sameColor" && c.color === color
    );
    if (!entry) return null;

    const picks: Array<{ memberId: string; skinId: number; chromaId: number }> = [];

    for (const m of room.members.values()) {
      if (m.lockedSkin) {
        picks.push({ memberId: m.id, skinId: m.skinId, chromaId: m.chromaId });
        continue;
      }
      if (!m.isReady) continue;

      const opts = (m.options ?? []).filter((o) => {
        let match = o.auraColor === color;
        if (skinLineId !== undefined) {
          match = match && o.skinLineId === skinLineId;
        }
        return match;
      });

      if (!opts.length) {
        picks.push({ memberId: m.id, skinId: m.skinId, chromaId: m.chromaId });
        continue;
      }

      const idx = randomInt(0, opts.length);
      const opt = opts[idx];

      m.skinId = opt.skinId;
      m.chromaId = opt.chromaId;

      picks.push({ memberId: m.id, skinId: opt.skinId, chromaId: opt.chromaId });
    }

    this.addToHistory(room, color, picks);

    room.activeSynergy = { type: "sameColor", color, timestamp: Date.now() };
    room.activeColor = color;

    logger.info(`[ApplyColor] Room ${room.code}: Applied color ${color}`);

    return { color, picks };
  }

  /**
   * Apply a specific skin line synergy (called from UI / Story 6.6).
   */
  public applySkinLineSynergy(
    room: Room,
    skinLineId: number
  ): { skinLineId: number; skinLineName: string; picks: Array<{ memberId: string; skinId: number; chromaId: number }> } | null {
    const synergy = room.synergy?.skinLines?.find((s) => s.skinLineId === skinLineId);
    if (!synergy) return null;

    const picks: Array<{ memberId: string; skinId: number; chromaId: number }> = [];

    for (const member of room.members.values()) {
      if (member.lockedSkin) {
        picks.push({ memberId: member.id, skinId: member.skinId, chromaId: member.chromaId });
        continue;
      }
      if (!member.options || member.options.length === 0) {
        picks.push({ memberId: member.id, skinId: member.skinId, chromaId: member.chromaId });
        continue;
      }

      const opts = member.options.filter((o) => o.skinLineId === skinLineId);
      if (opts.length === 0) {
        picks.push({ memberId: member.id, skinId: member.skinId, chromaId: member.chromaId });
        continue;
      }

      const optIdx = randomInt(0, opts.length);
      const opt = opts[optIdx];

      member.skinId = opt.skinId;
      member.chromaId = 0;

      picks.push({ memberId: member.id, skinId: opt.skinId, chromaId: 0 });
    }

    this.addSkinLineToHistory(room, skinLineId, synergy.skinLineName, picks);

    room.activeSynergy = {
      type: "skinLine",
      skinLineId,
      skinLineName: synergy.skinLineName,
      timestamp: Date.now(),
    };

    logger.info(`[ApplySkinLine] Room ${room.code}: Applied skin line ${synergy.skinLineName}`);

    return { skinLineId, skinLineName: synergy.skinLineName, picks };
  }

  /**
   * Check if all members have picked a champion and return true if auto-apply should trigger
   */
  public shouldAutoApply(room: Room): boolean {
    const allMembers = Array.from(room.members.values());

    // Need at least 2 members
    if (allMembers.length < 2) return false;

    // All members must have a champion selected (championId > 0)
    const allHaveChampion = allMembers.every((m) => m.championId > 0);
    if (!allHaveChampion) return false;

    // All members must have options
    const allHaveOptions = allMembers.every((m) => m.options && m.options.length > 0);
    if (!allHaveOptions) return false;

    // Must have at least one synergy available
    const hasColorSynergies = this.getAvailableSynergies(room).length > 0;
    const hasSkinLineSynergies = this.getAvailableSkinLineSynergies(room).length > 0;

    if (!hasSkinLineSynergies && !hasColorSynergies) return false;

    // Don't auto-apply if already applied recently (within last 5 seconds)
    if (room.activeSynergy && Date.now() - room.activeSynergy.timestamp < 5000) {
      return false;
    }

    return true;
  }

  public generateAutoApplyPicks(
    room: Room
  ): { color?: string; skinLineId?: number; skinLineName?: string; picks: Array<{ memberId: string; skinId: number; chromaId: number }> } | null {
    // Try skin line first, fallback to color
    const skinLineResult = this.generateSkinLinePicks(room);
    if (skinLineResult) return skinLineResult;
    return this.generateColorPicks(room);
  }

  /**
   * Generate picks based on a random color synergy (original behavior).
   */
  private generateColorPicks(
    room: Room
  ): { color: string; picks: Array<{ memberId: string; skinId: number; chromaId: number }> } | null {
    const availableSynergies = this.getAvailableSynergies(room);
    if (availableSynergies.length === 0) return null;

    const idx = randomInt(0, availableSynergies.length);
    const synergy = availableSynergies[idx];
    const color = synergy.color;

    const picks: Array<{ memberId: string; skinId: number; chromaId: number }> = [];

    for (const m of room.members.values()) {
      if (m.lockedSkin) {
        picks.push({ memberId: m.id, skinId: m.skinId, chromaId: m.chromaId });
        continue;
      }
      if (!m.options || m.options.length === 0) {
        picks.push({ memberId: m.id, skinId: m.skinId, chromaId: m.chromaId });
        continue;
      }

      const opts = m.options.filter((o) => o.auraColor === color);
      if (opts.length === 0) {
        picks.push({ memberId: m.id, skinId: m.skinId, chromaId: m.chromaId });
        continue;
      }

      const optIdx = randomInt(0, opts.length);
      const opt = opts[optIdx];

      m.skinId = opt.skinId;
      m.chromaId = opt.chromaId;

      picks.push({ memberId: m.id, skinId: opt.skinId, chromaId: opt.chromaId });
    }

    this.addToHistory(room, color, picks);

    room.activeSynergy = { type: "sameColor", color, timestamp: Date.now() };
    room.activeColor = color;

    logger.info(`[AutoApply] Room ${room.code}: Auto-applied color ${color}`);

    return { color, picks };
  }

  public serializeRoom(room: Room) {
    return {
      id: room.id,
      code: room.code,
      ownerId: room.ownerId,
      // Strip the per-member secret token before broadcasting to the room.
      members: Array.from(room.members.values()).map(
        ({ token: _token, ...publicMember }) => publicMember
      ),
      synergy: room.synergy ?? { colors: [], skinLines: [] },
      activeSynergy: room.activeSynergy,
      activeColor: room.activeColor,
    };
  }

  // --- Testing helper ---
  public addBots(room: Room, count: number, config: any): Member[] {
    const freeSlots = 5 - room.members.size;
    const toAdd = Math.min(count, freeSlots);
    const createdBots: Member[] = [];

    const namePrefix = config.namePrefix || "Bot";

    // Pick a starting index that avoids collision with any existing
    // "<prefix> <n>" member name (including bots from prior addBots calls
    // that may have been filled and partially vacated).
    const takenSuffixes = new Set<number>();
    const prefixMatch = new RegExp(
      `^${namePrefix.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")} (\\d+)$`
    );
    for (const m of room.members.values()) {
      const match = prefixMatch.exec(m.name);
      if (match) takenSuffixes.add(parseInt(match[1], 10));
    }

    let nextSuffix = 1;
    for (let i = 0; i < toAdd; i++) {
        while (takenSuffixes.has(nextSuffix)) nextSuffix++;
        takenSuffixes.add(nextSuffix);

        const memberId = randomUUID();
        const bot: Member = {
            id: memberId,
            name: `${namePrefix} ${nextSuffix}`,
            // Bots have a token for type uniformity but never connect via socket.
            token: generateMemberToken(),
            championId: config.championId ?? randomInt(1, 201),
            championAlias: "",
            skinId: config.skinId ?? randomInt(1000, 999999),
            chromaId: config.chromaId ?? 0,
            isReady: true,
            lockedSkin: false,
            options: [] // Bots have no options for now
        };
        room.members.set(memberId, bot);
        createdBots.push(bot);
    }

    this.recomputeSynergy(room);
    return createdBots;
  }
}
