"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.io = exports.httpServer = void 0;
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const logger_1 = require("./utils/logger");
const socketHelpers_1 = require("./utils/socketHelpers");
const errors_1 = require("./utils/errors");
const versionAdapter_1 = require("./utils/versionAdapter");
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
exports.httpServer = http_1.default.createServer(app);
exports.io = new socket_io_1.Server(exports.httpServer, {
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
        exports.io.to(roomId).emit("room-closed", { reason: result.reason });
        // Disconnect all sockets in this room
        exports.io.in(roomId).disconnectSockets(true);
    }
    else {
        // Room still active, notify state update with versioned payload
        const serializedRoom = roomService.serializeRoom(room);
        (0, versionAdapter_1.emitVersionedToRoom)(exports.io, roomId, "room-state", (version) => (0, versionAdapter_1.createRoomStatePayload)(serializedRoom, version));
    }
}
exports.io.on("connection", (socket) => {
    // Register client version from handshake query
    const rawVersion = socket.handshake.query.clientVersion;
    const clientVersion = (0, versionAdapter_1.registerClientVersion)(socket.id, typeof rawVersion === "string" ? parseInt(rawVersion, 10) || 1 : 1);
    logger_1.logger.info(`[socket] connected ${socket.id} (v${clientVersion})`);
    const safeHandler = (0, socketHelpers_1.createSafeHandler)(socket);
    socket.on("join-room", safeHandler("join-room", ({ roomId, memberId }) => {
        const room = roomService.getRoom(roomId);
        if (!room) {
            throw new errors_1.AppError(errors_1.ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
        }
        const member = room.members.get(memberId);
        if (!member) {
            throw new errors_1.AppError(errors_1.ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
        }
        logger_1.logger.debug(`[socket] ${socket.id} join room ${roomId} as member ${memberId}`);
        socket.join(roomId);
        socketToMember.set(socket.id, { roomId, memberId });
        // Emit versioned room-state
        const serializedRoom = roomService.serializeRoom(room);
        (0, versionAdapter_1.emitVersionedToRoom)(exports.io, roomId, "room-state", (version) => (0, versionAdapter_1.createRoomStatePayload)(serializedRoom, version));
    }));
    socket.on("update-selection", safeHandler("update-selection", (payload) => {
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
        // Emit versioned room-state
        const serializedRoom = roomService.serializeRoom(room);
        (0, versionAdapter_1.emitVersionedToRoom)(exports.io, roomId, "room-state", (version) => (0, versionAdapter_1.createRoomStatePayload)(serializedRoom, version));
    }));
    socket.on("owned-options", safeHandler("owned-options", (payload) => {
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
        // Emit versioned room-state
        const serializedRoom = roomService.serializeRoom(room);
        (0, versionAdapter_1.emitVersionedToRoom)(exports.io, roomId, "room-state", (version) => (0, versionAdapter_1.createRoomStatePayload)(serializedRoom, version));
    }));
    socket.on("leave-room", safeHandler("leave-room", ({ roomId, memberId }) => {
        logger_1.logger.debug(`[leave-room] ${socket.id} explicit leave room ${roomId}`);
        handleMemberLeave(roomId, memberId, "leave");
        socketToMember.delete(socket.id);
        socket.leave(roomId);
    }));
    socket.on("disconnect", () => {
        const info = socketToMember.get(socket.id);
        socketToMember.delete(socket.id);
        (0, versionAdapter_1.removeClientVersion)(socket.id);
        if (info) {
            logger_1.logger.debug(`[socket] ${socket.id} disconnected (room ${info.roomId})`);
            handleMemberLeave(info.roomId, info.memberId, "disconnect");
        }
    });
    socket.on("request-group-reroll", safeHandler("request-group-reroll", (payload) => {
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
        // Emit versioned group-apply-combo
        (0, versionAdapter_1.emitVersionedToRoom)(exports.io, roomId, "group-apply-combo", (version) => (0, versionAdapter_1.createGroupApplyComboPayload)({ type, color, picks }, version));
        // Emit versioned room-state
        const serializedRoom = roomService.serializeRoom(room);
        (0, versionAdapter_1.emitVersionedToRoom)(exports.io, roomId, "room-state", (version) => (0, versionAdapter_1.createRoomStatePayload)(serializedRoom, version));
    }));
    socket.on("suggest-color", (payload, ack) => {
        try {
            const { roomId, memberId, skinId, chromaId } = payload;
            logger_1.logger.info(`[suggest-color] received suggestion in room ${roomId} from member ${memberId}`);
            const room = roomService.getRoom(roomId);
            if (!room) {
                logger_1.logger.warn(`[suggest-color] Room ${roomId} not found`);
                if (ack)
                    ack({ success: false, error: 'Room not found' });
                return;
            }
            const sender = room.members.get(memberId);
            if (!sender) {
                logger_1.logger.warn(`[suggest-color] Member ${memberId} not found in room ${roomId}`);
                if (ack)
                    ack({ success: false, error: 'Member not found' });
                return;
            }
            logger_1.logger.info(`[suggest-color] from ${sender.name} (${memberId}) in room ${roomId}: skin=${skinId} chroma=${chromaId}`);
            // Broadcast to room with version-appropriate payload
            (0, versionAdapter_1.emitVersionedToRoom)(exports.io, roomId, "color-suggestion-received", (version) => (0, versionAdapter_1.createColorSuggestionPayload)({
                memberId,
                memberName: sender.name,
                skinId,
                chromaId,
            }, version));
            // Send acknowledgment to sender
            if (ack) {
                ack({ success: true });
                logger_1.logger.debug(`[suggest-color] Acknowledged suggestion from ${memberId}`);
            }
        }
        catch (err) {
            logger_1.logger.error(`[suggest-color] Error processing suggestion`, err);
            if (ack)
                ack({ success: false, error: 'Internal server error' });
        }
    });
});
// --- Start ---
// Only start the server if this module is run directly (not imported for tests)
if (process.env.NODE_ENV !== "test") {
    const PORT = Number(process.env.PORT) || 4000;
    exports.httpServer.listen(PORT, "0.0.0.0", () => {
        logger_1.logger.info(`Rooms server listening on port ${PORT}`);
    });
}
