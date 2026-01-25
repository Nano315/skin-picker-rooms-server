import { randomUUID, randomInt } from "crypto";
import { Room, Member, ColorSynergy, ChromaCombination } from "../types";
import { logger } from "../utils/logger";

const GROUP_HISTORY_LIMIT = 3;

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
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += alphabet[randomInt(0, alphabet.length)];
    }
    return code;
  }

  public createRoom(ownerName: string): { room: Room; member: Member } {
    const roomId = randomUUID();
    const code = this.generateRoomCode();
    const ownerId = randomUUID();

    const owner: Member = {
      id: ownerId,
      name: ownerName,
      championId: 0,
      championAlias: "",
      skinId: 0,
      chromaId: 0,
      isReady: false,
    };

    const room: Room = {
      id: roomId,
      code,
      ownerId,
      members: new Map([[ownerId, owner]]),
      history: [],
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
      championId: 0,
      championAlias: "",
      skinId: 0,
      chromaId: 0,
      isReady: false,
    };

    room.members.set(memberId, member);
    // Recalculate synergy immediately? Not necessary as they have no options yet.
    
    logger.info(`Member ${memberName} (${memberId}) joined room ${room.id}`);
    return { room, member };
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
      room.synergy = { colors: [] };
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

    room.synergy = { colors: synergies };

    if (synergies.length > 0) {
        // Only log "interesting" events to keep logs clean
        logger.debug(`[Synergy] Room ${room.code}: Found ${synergies.length} synergies (Best: ${synergies[0].color})`);
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
    const availableSynergies = this.getAvailableSynergies(room);
    if (availableSynergies.length === 0) return false;

    // Don't auto-apply if already applied recently (within last 5 seconds)
    if (room.activeSynergy && Date.now() - room.activeSynergy.timestamp < 5000) {
      return false;
    }

    return true;
  }

  /**
   * Select a random color from available synergies and generate picks
   */
  public generateAutoApplyPicks(
    room: Room
  ): { color: string; picks: Array<{ memberId: string; skinId: number; chromaId: number }> } | null {
    const availableSynergies = this.getAvailableSynergies(room);
    if (availableSynergies.length === 0) return null;

    // Pick a random synergy (weighted by coverage could be an option, but random is fine)
    const idx = randomInt(0, availableSynergies.length);
    const synergy = availableSynergies[idx];
    const color = synergy.color;

    const picks: Array<{ memberId: string; skinId: number; chromaId: number }> = [];

    for (const m of room.members.values()) {
      if (!m.options || m.options.length === 0) {
        // Keep current selection
        picks.push({ memberId: m.id, skinId: m.skinId, chromaId: m.chromaId });
        continue;
      }

      const opts = m.options.filter((o) => o.auraColor === color);
      if (opts.length === 0) {
        // No matching color, keep current
        picks.push({ memberId: m.id, skinId: m.skinId, chromaId: m.chromaId });
        continue;
      }

      const optIdx = randomInt(0, opts.length);
      const opt = opts[optIdx];

      // Update member's current selection
      m.skinId = opt.skinId;
      m.chromaId = opt.chromaId;

      picks.push({ memberId: m.id, skinId: opt.skinId, chromaId: opt.chromaId });
    }

    // Add to history
    this.addToHistory(room, color, picks);

    // Update room state
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
      members: Array.from(room.members.values()),
      synergy: room.synergy ?? undefined,
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

    for (let i = 0; i < toAdd; i++) {
        const memberId = randomUUID();
        const bot: Member = {
            id: memberId,
            name: `${namePrefix} ${room.members.size + 1}`,
            championId: config.championId ?? randomInt(1, 201),
            championAlias: "",
            skinId: config.skinId ?? randomInt(1000, 999999),
            chromaId: config.chromaId ?? 0,
            isReady: true,
            options: [] // Bots have no options for now
        };
        room.members.set(memberId, bot);
        createdBots.push(bot);
    }
    
    this.recomputeSynergy(room);
    return createdBots;
  }
}
