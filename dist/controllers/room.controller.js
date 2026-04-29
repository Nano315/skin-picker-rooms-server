"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addBots = exports.joinRoom = exports.createBotRoom = exports.createRoom = void 0;
const room_service_1 = require("../services/room.service");
const logger_1 = require("../utils/logger");
const roomService = room_service_1.RoomService.getInstance();
const createRoom = (req, res) => {
    try {
        const name = String(req.body?.name ?? "").trim() || "Player";
        const { room, member } = roomService.createRoom(name);
        res.json({
            roomId: room.id,
            code: room.code,
            memberId: member.id,
            memberToken: member.token,
            owner: true,
            room: roomService.serializeRoom(room),
        });
    }
    catch (err) {
        logger_1.logger.error(`Error creating room: ${err}`);
        res.status(500).json({ error: "Internal Server Error" });
    }
};
exports.createRoom = createRoom;
const createBotRoom = (req, res) => {
    try {
        const { room, member } = roomService.createBotRoom();
        res.json({
            roomId: room.id,
            code: room.code,
            memberId: member.id,
            memberToken: member.token,
            owner: false, // The requester is NOT the owner
            room: roomService.serializeRoom(room),
        });
    }
    catch (err) {
        logger_1.logger.error(`Error creating bot room: ${err}`);
        res.status(500).json({ error: "Internal Server Error" });
    }
};
exports.createBotRoom = createBotRoom;
const joinRoom = (req, res) => {
    try {
        const code = String(req.body?.code ?? "").trim().toUpperCase();
        const name = String(req.body?.name ?? "").trim() || "Player";
        const result = roomService.joinRoom(code, name);
        if ("error" in result) {
            res.status(result.status).json({ error: result.error });
            return;
        }
        const { room, member } = result;
        res.json({
            roomId: room.id,
            code: room.code,
            memberId: member.id,
            memberToken: member.token,
            owner: room.ownerId === member.id,
            room: roomService.serializeRoom(room),
        });
    }
    catch (err) {
        logger_1.logger.error(`Error joining room: ${err}`);
        res.status(500).json({ error: "Internal Server Error" });
    }
};
exports.joinRoom = joinRoom;
const addBots = (req, res) => {
    try {
        const rawCode = String(req.params.code ?? "").trim().toUpperCase();
        const room = roomService.getRoomByCode(rawCode);
        if (!room) {
            return res.status(404).json({ error: "Room not found" });
        }
        const body = req.body ?? {};
        const memberId = typeof body.memberId === "string" ? body.memberId : "";
        const memberToken = typeof body.memberToken === "string" ? body.memberToken : "";
        const requester = room.members.get(memberId);
        if (!requester) {
            logger_1.logger.warn(`[addBots] Rejected: unknown member ${memberId} in room ${room.code}`);
            return res.status(401).json({ error: "Unauthorized" });
        }
        if (!(0, room_service_1.verifyMemberToken)(requester.token, memberToken)) {
            logger_1.logger.warn(`[addBots] Rejected: invalid memberToken for ${memberId} in room ${room.code}`);
            return res.status(401).json({ error: "Unauthorized" });
        }
        if (room.ownerId !== requester.id) {
            logger_1.logger.warn(`[addBots] Rejected: ${requester.id} is not owner of room ${room.code}`);
            return res.status(403).json({ error: "Only the room owner can add bots" });
        }
        const rawCount = Number(body.count ?? 1);
        const count = Number.isFinite(rawCount) ? Math.max(1, Math.floor(rawCount)) : 1;
        const bots = roomService.addBots(room, count, body);
        logger_1.logger.info(`Added ${bots.length} bots to room ${room.code} (by owner ${requester.id})`);
        res.json({
            ok: true,
            added: bots.length,
            room: roomService.serializeRoom(room),
            bots,
        });
    }
    catch (err) {
        logger_1.logger.error(`Error adding bots: ${err}`);
        res.status(500).json({ error: "Internal Server Error" });
    }
};
exports.addBots = addBots;
