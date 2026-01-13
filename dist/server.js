"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const logger_1 = require("./utils/logger");
const socketHelpers_1 = require("./utils/socketHelpers");
const room_routes_1 = __importDefault(require("./routes/room.routes"));
const room_service_1 = require("./services/room.service");
const crypto_1 = require("crypto");
const app = (0, express_1.default)();
const roomService = room_service_1.RoomService.getInstance();
// --- Configuration & Middleware ---
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)()); // Configure origin in production
app.use(express_1.default.json());
// Rate limiting
const limiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);
// --- Routes ---
app.use("/rooms", room_routes_1.default);
app.get("/", (req, res) => {
    res.send("Skin Picker Rooms server is running");
});
// --- Server Setup ---
const httpServer = http_1.default.createServer(app);
const io = new socket_io_1.Server(httpServer, {
    cors: { origin: "*" },
});
// --- Socket.io Logic ---
// Map socketId -> { roomId, memberId }
const socketToMember = new Map();
function handleMemberLeave(roomId, memberId, reason) {
    const room = roomService.getRoom(roomId);
    if (!room)
        return;
    const result = roomService.removeMember(room, memberId);
    if (result.roomClosed) {
        // Room closed, notify everyone
        io.to(roomId).emit("room-closed", { reason: result.reason });
        // Disconnect all sockets in this room
        io.in(roomId).disconnectSockets(true);
    }
    else {
        // Room still active, notify state update
        io.to(roomId).emit("room-state", roomService.serializeRoom(room));
    }
}
io.on("connection", (socket) => {
    logger_1.logger.info(`[socket] connected ${socket.id}`);
    socket.on("join-room", ({ roomId, memberId }) => {
        const { room, member } = (0, socketHelpers_1.getRoomAndMemberOrWarn)(roomService, roomId, memberId, "join-room");
        if (!room || !member)
            return;
        logger_1.logger.debug(`[socket] ${socket.id} join room ${roomId} as member ${memberId}`);
        socket.join(roomId);
        socketToMember.set(socket.id, { roomId, memberId });
        io.to(roomId).emit("room-state", roomService.serializeRoom(room));
    });
    socket.on("update-selection", (payload) => {
        const { roomId, memberId, championId, championAlias, skinId, chromaId } = payload;
        const { room, member } = (0, socketHelpers_1.getRoomAndMemberOrWarn)(roomService, roomId, memberId, "update-selection");
        if (!room || !member)
            return;
        member.championId = championId;
        member.championAlias = championAlias ?? "";
        member.skinId = skinId;
        member.chromaId = chromaId;
        io.to(roomId).emit("room-state", roomService.serializeRoom(room));
    });
    socket.on("owned-options", (payload) => {
        const { roomId, memberId, championId, championAlias, options } = payload;
        const { room, member } = (0, socketHelpers_1.getRoomAndMemberOrWarn)(roomService, roomId, memberId, "owned-options");
        if (!room || !member)
            return;
        member.championId = championId;
        member.championAlias = championAlias ?? "";
        member.options = Array.isArray(options) ? options : [];
        member.isReady = true;
        // Security check
        if (member.options && member.options.length > 2000) {
            logger_1.logger.warn(`[Security] Member ${memberId} sent too many options (${member.options.length}). Truncating.`);
            member.options = member.options.slice(0, 2000);
        }
        logger_1.logger.debug(`[owned-options] member=${memberId} room=${roomId} options=${member.options.length}`);
        try {
            roomService.recomputeSynergy(room);
        }
        catch (err) {
            logger_1.logger.error(`Error recomputing synergy: ${err}`);
        }
        io.to(roomId).emit("room-state", roomService.serializeRoom(room));
    });
    socket.on("leave-room", ({ roomId, memberId }) => {
        logger_1.logger.debug(`[socket] ${socket.id} explicit leave room ${roomId}`);
        handleMemberLeave(roomId, memberId, "leave");
        socketToMember.delete(socket.id);
        socket.leave(roomId);
    });
    socket.on("disconnect", () => {
        const info = socketToMember.get(socket.id);
        socketToMember.delete(socket.id);
        if (info) {
            logger_1.logger.debug(`[socket] ${socket.id} disconnected (room ${info.roomId})`);
            handleMemberLeave(info.roomId, info.memberId, "disconnect");
        }
    });
    socket.on("request-group-reroll", (payload) => {
        const { roomId, memberId, type, color } = payload;
        const room = (0, socketHelpers_1.getRoomOrWarn)(roomService, roomId, "request-group-reroll");
        if (!room)
            return;
        if (room.ownerId !== memberId) {
            logger_1.logger.warn(`[group-reroll] non-owner tried to reroll: ${memberId}`);
            return;
        }
        const synergy = room.synergy;
        if (!synergy)
            return;
        const entry = synergy.colors.find((c) => c.type === type && c.color === color);
        if (!entry) {
            logger_1.logger.warn(`[group-reroll] no synergy entry for color=${color} in room=${roomId}`);
            return;
        }
        const picks = [];
        // Reroll logic
        for (const m of room.members.values()) {
            if (!m.isReady)
                continue;
            const opts = (m.options ?? []).filter((o) => o.auraColor === color);
            if (!opts.length) {
                // Keep current
                picks.push({ memberId: m.id, skinId: m.skinId, chromaId: m.chromaId });
                continue;
            }
            const idx = (0, crypto_1.randomInt)(0, opts.length);
            const opt = opts[idx];
            m.skinId = opt.skinId;
            m.chromaId = opt.chromaId;
            picks.push({ memberId: m.id, skinId: opt.skinId, chromaId: opt.chromaId });
        }
        logger_1.logger.info(`[group-reroll] applying combo color=${color} in room=${roomId}`);
        room.activeSynergy = { type, color, timestamp: Date.now() };
        if (type === "sameColor") {
            room.activeColor = color;
        }
        io.to(roomId).emit("group-apply-combo", { type, color, picks });
        io.to(roomId).emit("room-state", roomService.serializeRoom(room));
    });
    socket.on("suggest-color", (payload) => {
        const { roomId, memberId, skinId, chromaId } = payload;
        logger_1.logger.info(`[suggest-color] received suggestion in room ${roomId} from member ${memberId}`);
        // Validate room and sender
        const { room, member: sender } = (0, socketHelpers_1.getRoomAndMemberOrWarn)(roomService, roomId, memberId, "suggest-color");
        if (!room || !sender)
            return;
        logger_1.logger.info(`[suggest-color] from ${sender.name} (${memberId}) in room ${roomId}: skin=${skinId} chroma=${chromaId}`);
        // 3. Broadcast to room - Owner client will listen and display the suggestion
        logger_1.logger.info(`[suggest-color] broadcasting suggestion to room ${roomId}`);
        io.to(roomId).emit("color-suggestion-received", {
            memberId,
            senderName: sender.name,
            skinId,
            chromaId
        });
    });
});
// --- Start ---
const PORT = Number(process.env.PORT) || 4000;
httpServer.listen(PORT, "0.0.0.0", () => {
    logger_1.logger.info(`Rooms server listening on port ${PORT}`);
});
