import { randomUUID, randomInt } from "crypto";
import { Room, Member, ColorSynergy } from "../types";
import { logger } from "../utils/logger";

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
    // Filter members who are ready and have options (valid lock)
    const readyMembers = allMembers.filter((m) => m.options && m.options.length > 0);

    // Limit logging to avoid spam
    // logger.debug(`Recomputing synergy for room ${room.code} (${readyMembers.length} ready)`);

    if (readyMembers.length < 1) {
      room.synergy = { colors: [] };
      return;
    }

    const allColors = new Set<string>();

    for (const m of readyMembers) {
      if (!m.options) continue;
      for (const opt of m.options) {
        if (!opt.auraColor) continue;
        allColors.add(opt.auraColor);
      }
    }

    const colors: ColorSynergy[] = [];

    for (const color of allColors) {
      const participants: string[] = [];
      let comboCount = 1;

      for (const m of readyMembers) {
        const opts = (m.options ?? []).filter((o) => o.auraColor === color);

        if (!opts.length) {
          comboCount = 0;
          break;
        }

        participants.push(m.id);
        comboCount *= opts.length;
      }

      if (comboCount > 0) {
        colors.push({
          type: "sameColor",
          color,
          members: participants,
          coverage: 1, // 100% of ready members
          combinationCount: comboCount,
        });
      }
    }

    colors.sort(
      (a, b) => b.coverage - a.coverage || b.combinationCount - a.combinationCount
    );

    room.synergy = { colors };
    
    if (colors.length > 0) {
        // Only log "interesting" events to keep logs clean
        logger.debug(`[Synergy] Room ${room.code}: Found ${colors.length} synergies (Best: ${colors[0].color})`);
    }
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
