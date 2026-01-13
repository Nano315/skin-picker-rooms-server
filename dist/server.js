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
const errors_1 = require("./utils/errors");
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
    socket.on("join-room", (0, socketHelpers_1.safeHandler)("join-room", ({ roomId, memberId }, sock) => {
        const room = roomService.getRoom(roomId);
        if (!room) {
            throw new errors_1.AppError(errors_1.ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
        }
        const member = room.members.get(memberId);
        if (!member) {
            throw new errors_1.AppError(errors_1.ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
        }
        logger_1.logger.debug(`[socket] ${sock.id} join room ${roomId} as member ${memberId}`);
        sock.join(roomId);
        socketToMember.set(sock.id, { roomId, memberId });
        io.to(roomId).emit("room-state", roomService.serializeRoom(room));
    }));
    socket.on("update-selection", (0, socketHelpers_1.safeHandler)("update-selection", (payload) => {
        const { roomId, memberId, championId, championAlias, skinId, chromaId } = payload;
        const room = roomService.getRoom(roomId);
        if (!room) {
            throw new errors_1.AppError(errors_1.ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
        }
        const member = room.members.get(memberId);
        if (!member) {
            throw new errors_1.AppError(errors_1.ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
        }
        member.championId = championId;
        member.championAlias = championAlias ?? "";
        member.skinId = skinId;
        member.chromaId = chromaId;
        io.to(roomId).emit("room-state", roomService.serializeRoom(room));
    }));
    socket.on("owned-options", (0, socketHelpers_1.safeHandler)("owned-options", (payload) => {
        const { roomId, memberId, championId, championAlias, options } = payload;
        const room = roomService.getRoom(roomId);
        if (!room) {
            throw new errors_1.AppError(errors_1.ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
        }
        const member = room.members.get(memberId);
        if (!member) {
            throw new errors_1.AppError(errors_1.ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
        }
        member.championId = championId;
        member.championAlias = championAlias ?? "";
        member.options = Array.isArray(options) ? options : [];
        member.isReady = true;
        // Security check
        if (member.options && member.options.length > 2000) {
            logger_1.logger.warn(`[owned-options] Member ${memberId} sent too many options (${member.options.length}). Truncating.`, {
                roomId,
                memberId,
                optionsCount: member.options.length,
            });
            member.options = member.options.slice(0, 2000);
        }
        logger_1.logger.debug(`[owned-options] member=${memberId} room=${roomId} options=${member.options.length}`);
        roomService.recomputeSynergy(room);
        io.to(roomId).emit("room-state", roomService.serializeRoom(room));
    }));
    socket.on("leave-room", (0, socketHelpers_1.safeHandler)("leave-room", ({ roomId, memberId }, sock) => {
        logger_1.logger.debug(`[leave-room] ${sock.id} explicit leave room ${roomId}`);
        handleMemberLeave(roomId, memberId, "leave");
        socketToMember.delete(sock.id);
        sock.leave(roomId);
    }));
    socket.on("disconnect", () => {
        const info = socketToMember.get(socket.id);
        socketToMember.delete(socket.id);
        if (info) {
            logger_1.logger.debug(`[socket] ${socket.id} disconnected (room ${info.roomId})`);
            handleMemberLeave(info.roomId, info.memberId, "disconnect");
        }
    });
    socket.on("request-group-reroll", (0, socketHelpers_1.safeHandler)("request-group-reroll", (payload, sock) => {
        const { roomId, memberId, type, color } = payload;
        const room = roomService.getRoom(roomId);
        if (!room) {
            throw new errors_1.AppError(errors_1.ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
        }
        if (room.ownerId !== memberId) {
            throw new errors_1.AppError(errors_1.ErrorCodes.UNAUTHORIZED, `Only owner can trigger group reroll`, true, {
                roomId,
                memberId,
                ownerId: room.ownerId,
            });
        }
        const synergy = room.synergy;
        if (!synergy) {
            logger_1.logger.warn(`[request-group-reroll] No synergy computed for room ${roomId}`);
            return;
        }
        const entry = synergy.colors.find((c) => c.type === type && c.color === color);
        if (!entry) {
            logger_1.logger.warn(`[request-group-reroll] No synergy entry for color=${color} in room=${roomId}`);
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
        logger_1.logger.info(`[request-group-reroll] applying combo color=${color} in room=${roomId}`);
        room.activeSynergy = { type, color, timestamp: Date.now() };
        if (type === "sameColor") {
            room.activeColor = color;
        }
        io.to(roomId).emit("group-apply-combo", { type, color, picks });
        io.to(roomId).emit("room-state", roomService.serializeRoom(room));
    }));
    socket.on("suggest-color", (0, socketHelpers_1.safeHandler)("suggest-color", (payload) => {
        const { roomId, memberId, skinId, chromaId } = payload;
        logger_1.logger.info(`[suggest-color] received suggestion in room ${roomId} from member ${memberId}`);
        const room = roomService.getRoom(roomId);
        if (!room) {
            throw new errors_1.AppError(errors_1.ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
        }
        const sender = room.members.get(memberId);
        if (!sender) {
            throw new errors_1.AppError(errors_1.ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
        }
        logger_1.logger.info(`[suggest-color] from ${sender.name} (${memberId}) in room ${roomId}: skin=${skinId} chroma=${chromaId}`);
        // Broadcast to room - Owner client will listen and display the suggestion
        io.to(roomId).emit("color-suggestion-received", {
            memberId,
            senderName: sender.name,
            skinId,
            chromaId,
        });
    }));
});
// --- Start ---
const PORT = Number(process.env.PORT) || 4000;
httpServer.listen(PORT, "0.0.0.0", () => {
    logger_1.logger.info(`Rooms server listening on port ${PORT}`);
});
