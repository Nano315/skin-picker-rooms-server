"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoomService = void 0;
const crypto_1 = require("crypto");
const logger_1 = require("../utils/logger");
class RoomService {
    constructor() {
        this.rooms = new Map();
        this.roomsByCode = new Map();
    }
    static getInstance() {
        if (!RoomService.instance) {
            RoomService.instance = new RoomService();
        }
        return RoomService.instance;
    }
    generateRoomCode() {
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let code = "";
        for (let i = 0; i < 6; i++) {
            code += alphabet[(0, crypto_1.randomInt)(0, alphabet.length)];
        }
        return code;
    }
    createRoom(ownerName) {
        const roomId = (0, crypto_1.randomUUID)();
        const code = this.generateRoomCode();
        const ownerId = (0, crypto_1.randomUUID)();
        const owner = {
            id: ownerId,
            name: ownerName,
            championId: 0,
            championAlias: "",
            skinId: 0,
            chromaId: 0,
            isReady: false,
        };
        const room = {
            id: roomId,
            code,
            ownerId,
            members: new Map([[ownerId, owner]]),
        };
        this.rooms.set(roomId, room);
        this.roomsByCode.set(code, room);
        logger_1.logger.info(`Room created: ${roomId} (Code: ${code}) by ${ownerName}`);
        return { room, member: owner };
    }
    getRoom(roomId) {
        return this.rooms.get(roomId);
    }
    getRoomByCode(code) {
        return this.roomsByCode.get(code);
    }
    joinRoom(code, memberName) {
        const room = this.roomsByCode.get(code);
        if (!room) {
            return { error: "Room not found", status: 404 };
        }
        if (room.members.size >= 5) {
            return { error: "Room is full", status: 403 };
        }
        const memberId = (0, crypto_1.randomUUID)();
        const member = {
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
        logger_1.logger.info(`Member ${memberName} (${memberId}) joined room ${room.id}`);
        return { room, member };
    }
    removeMember(room, memberId) {
        const member = room.members.get(memberId);
        if (!member)
            return { roomClosed: false };
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
    closeRoom(room) {
        this.rooms.delete(room.id);
        this.roomsByCode.delete(room.code);
        logger_1.logger.info(`Room closed: ${room.id}`);
    }
    recomputeSynergy(room) {
        const allMembers = Array.from(room.members.values());
        // Filter members who are ready and have options (valid lock)
        const readyMembers = allMembers.filter((m) => m.options && m.options.length > 0);
        // Limit logging to avoid spam
        // logger.debug(`Recomputing synergy for room ${room.code} (${readyMembers.length} ready)`);
        if (readyMembers.length < 1) {
            room.synergy = { colors: [] };
            return;
        }
        const allColors = new Set();
        for (const m of readyMembers) {
            if (!m.options)
                continue;
            for (const opt of m.options) {
                if (!opt.auraColor)
                    continue;
                allColors.add(opt.auraColor);
            }
        }
        const colors = [];
        for (const color of allColors) {
            const participants = [];
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
        colors.sort((a, b) => b.coverage - a.coverage || b.combinationCount - a.combinationCount);
        room.synergy = { colors };
        if (colors.length > 0) {
            // Only log "interesting" events to keep logs clean
            logger_1.logger.debug(`[Synergy] Room ${room.code}: Found ${colors.length} synergies (Best: ${colors[0].color})`);
        }
    }
    serializeRoom(room) {
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
    addBots(room, count, config) {
        const freeSlots = 5 - room.members.size;
        const toAdd = Math.min(count, freeSlots);
        const createdBots = [];
        const namePrefix = config.namePrefix || "Bot";
        for (let i = 0; i < toAdd; i++) {
            const memberId = (0, crypto_1.randomUUID)();
            const bot = {
                id: memberId,
                name: `${namePrefix} ${room.members.size + 1}`,
                championId: config.championId ?? (0, crypto_1.randomInt)(1, 201),
                championAlias: "",
                skinId: config.skinId ?? (0, crypto_1.randomInt)(1000, 999999),
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
exports.RoomService = RoomService;
