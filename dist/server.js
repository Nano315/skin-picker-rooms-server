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
const presence_service_1 = require("./services/presence.service");
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
// Rate limiting for room invitations (Story 4.5)
// Key: `${senderPuuid}:${targetPuuid}` -> timestamp of last invite
const inviteRateLimits = new Map();
const INVITE_RATE_LIMIT_MS = 30000; // 30 seconds
const INVITE_CLEANUP_INTERVAL_MS = 300000; // 5 minutes
// Cleanup expired rate limit entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of inviteRateLimits.entries()) {
        if (now - timestamp > INVITE_CLEANUP_INTERVAL_MS) {
            inviteRateLimits.delete(key);
        }
    }
}, INVITE_CLEANUP_INTERVAL_MS);
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
        // Check if we should auto-apply (all members have champions and options)
        if (roomService.shouldAutoApply(room)) {
            const result = roomService.generateAutoApplyPicks(room);
            if (result) {
                // Emit auto-apply combo (color or skin line depending on syncMode)
                (0, versionAdapter_1.emitVersionedToRoom)(exports.io, roomId, "group-apply-combo", (version) => (0, versionAdapter_1.createGroupApplyComboPayload)({
                    type: result.skinLineId ? "skinLine" : "sameColor",
                    color: result.color,
                    skinLineId: result.skinLineId,
                    skinLineName: result.skinLineName,
                    picks: result.picks,
                    autoApplied: true,
                }, version));
            }
        }
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
        // Handle room membership cleanup
        const info = socketToMember.get(socket.id);
        socketToMember.delete(socket.id);
        (0, versionAdapter_1.removeClientVersion)(socket.id);
        if (info) {
            logger_1.logger.debug(`[socket] ${socket.id} disconnected (room ${info.roomId})`);
            handleMemberLeave(info.roomId, info.memberId, "disconnect");
        }
        // Handle presence cleanup and friend notifications (Story 4.3)
        const puuid = presence_service_1.presenceManager.getPuuidBySocketId(socket.id);
        if (puuid) {
            const friends = presence_service_1.presenceManager.getFriends(puuid);
            const summonerName = presence_service_1.presenceManager.getSummonerName(puuid);
            // Notify online friends that this user is offline
            if (friends) {
                for (const friendPuuid of friends) {
                    if (presence_service_1.presenceManager.isOnline(friendPuuid)) {
                        exports.io.to(`user:${friendPuuid}`).emit("friend-offline", { puuid });
                    }
                }
            }
            // Clear presence after notifications
            presence_service_1.presenceManager.disconnect(socket.id);
            logger_1.logger.info(`[identify] ${summonerName} (${puuid}) disconnected`);
        }
    });
    socket.on("request-group-reroll", safeHandler("request-group-reroll", (payload) => {
        const { roomId, memberId, type, color, sourceMemberId } = payload;
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
        // Add to history
        roomService.addToHistory(room, color, picks);
        // Emit versioned group-apply-combo
        (0, versionAdapter_1.emitVersionedToRoom)(exports.io, roomId, "group-apply-combo", (version) => (0, versionAdapter_1.createGroupApplyComboPayload)({ type, color, picks, sourceMemberId, autoApplied: false }, version));
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
    // --- Set Sync Mode (Story 6.4) ---
    socket.on("set-sync-mode", safeHandler("set-sync-mode", (payload) => {
        const { roomId, memberId, mode } = payload;
        const room = roomService.getRoom(roomId);
        if (!room) {
            throw new errors_1.AppError(errors_1.ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
        }
        if (room.ownerId !== memberId) {
            throw new errors_1.AppError(errors_1.ErrorCodes.UNAUTHORIZED, `Only owner can change sync mode`, true, {
                roomId,
                memberId,
                ownerId: room.ownerId,
            });
        }
        if (!["chromas", "skins", "both"].includes(mode)) {
            throw new errors_1.AppError(errors_1.ErrorCodes.INVALID_PAYLOAD, `Invalid sync mode: ${mode}`, true, { mode });
        }
        room.syncMode = mode;
        logger_1.logger.info(`[SyncMode] Room ${room.code}: Mode changed to ${mode} by owner`);
        // Broadcast updated room state
        const serializedRoom = roomService.serializeRoom(room);
        (0, versionAdapter_1.emitVersionedToRoom)(exports.io, roomId, "room-state", (version) => (0, versionAdapter_1.createRoomStatePayload)(serializedRoom, version));
    }));
    // --- Apply Skin Line Synergy (Story 6.6) ---
    socket.on("apply-skin-line-synergy", safeHandler("apply-skin-line-synergy", (payload) => {
        const { roomId, memberId, skinLineId } = payload;
        const room = roomService.getRoom(roomId);
        if (!room) {
            throw new errors_1.AppError(errors_1.ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
        }
        if (room.ownerId !== memberId) {
            throw new errors_1.AppError(errors_1.ErrorCodes.UNAUTHORIZED, `Only owner can apply skin line synergy`, true, {
                roomId,
                memberId,
                ownerId: room.ownerId,
            });
        }
        const result = roomService.applySkinLineSynergy(room, skinLineId);
        if (!result) {
            throw new errors_1.AppError(errors_1.ErrorCodes.INVALID_PAYLOAD, `Skin line ${skinLineId} not available`, true, { skinLineId });
        }
        logger_1.logger.info(`[apply-skin-line-synergy] Applied skin line ${result.skinLineName} in room ${room.code}`);
        // Broadcast combo
        (0, versionAdapter_1.emitVersionedToRoom)(exports.io, roomId, "group-apply-combo", (version) => (0, versionAdapter_1.createGroupApplyComboPayload)({
            type: "skinLine",
            skinLineId: result.skinLineId,
            skinLineName: result.skinLineName,
            picks: result.picks,
            autoApplied: false,
        }, version));
        // Broadcast updated room state
        const serializedRoom = roomService.serializeRoom(room);
        (0, versionAdapter_1.emitVersionedToRoom)(exports.io, roomId, "room-state", (version) => (0, versionAdapter_1.createRoomStatePayload)(serializedRoom, version));
    }));
    // --- Apply Custom Combo from Builder (Story 6.7) ---
    socket.on("apply-custom-combo", safeHandler("apply-custom-combo", (payload) => {
        const { roomId, memberId, picks } = payload;
        const room = roomService.getRoom(roomId);
        if (!room) {
            throw new errors_1.AppError(errors_1.ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
        }
        if (room.ownerId !== memberId) {
            throw new errors_1.AppError(errors_1.ErrorCodes.UNAUTHORIZED, `Only owner can apply custom combo`, true, {
                roomId,
                memberId,
                ownerId: room.ownerId,
            });
        }
        if (!Array.isArray(picks) || picks.length === 0) {
            throw new errors_1.AppError(errors_1.ErrorCodes.INVALID_PAYLOAD, `Picks array is required`, true, { picks });
        }
        // Apply picks to each member
        for (const pick of picks) {
            const member = room.members.get(pick.memberId);
            if (member) {
                member.skinId = pick.skinId;
                member.chromaId = pick.chromaId;
            }
        }
        room.activeSynergy = {
            type: "custom",
            timestamp: Date.now(),
        };
        logger_1.logger.info(`[Builder] Room ${room.code}: Custom combo applied by owner (${picks.length} picks)`);
        // Broadcast combo
        (0, versionAdapter_1.emitVersionedToRoom)(exports.io, roomId, "group-apply-combo", (version) => (0, versionAdapter_1.createGroupApplyComboPayload)({
            type: "sameColor",
            picks,
            autoApplied: false,
        }, version));
        // Broadcast updated room state
        const serializedRoom = roomService.serializeRoom(room);
        (0, versionAdapter_1.emitVersionedToRoom)(exports.io, roomId, "room-state", (version) => (0, versionAdapter_1.createRoomStatePayload)(serializedRoom, version));
    }));
    // --- Identity Handshake (Story 4.3) ---
    socket.on("identify", (payload) => {
        try {
            const { puuid, summonerName, friends } = payload;
            // Validate payload
            if (!puuid || typeof puuid !== "string" || puuid.length < 10) {
                logger_1.logger.warn("[identify] Invalid puuid received", { puuid });
                return;
            }
            if (!summonerName || typeof summonerName !== "string") {
                logger_1.logger.warn("[identify] Invalid summonerName received", { summonerName });
                return;
            }
            if (!Array.isArray(friends)) {
                logger_1.logger.warn("[identify] Invalid friends array received");
                return;
            }
            // 1. Register presence
            presence_service_1.presenceManager.identify(socket, puuid, summonerName);
            // 2. Store friends list
            presence_service_1.presenceManager.setFriends(puuid, friends);
            // 3. Find online friends
            const onlineFriends = presence_service_1.presenceManager.getOnlineFriends(friends);
            // 4. Confirm to client
            socket.emit("identity-confirmed", { onlineFriends });
            // 5. Notify friends that this user is online
            for (const friendPuuid of friends) {
                if (presence_service_1.presenceManager.isOnline(friendPuuid)) {
                    exports.io.to(`user:${friendPuuid}`).emit("friend-online", { puuid, summonerName });
                }
            }
            logger_1.logger.info(`[identify] ${summonerName} (${puuid}) identified with ${friends.length} friends, ${onlineFriends.length} online`);
        }
        catch (err) {
            logger_1.logger.error("[identify] Error processing identify", err);
        }
    });
    // --- Room Invitations (Story 4.5) ---
    socket.on("send-room-invite", (payload) => {
        try {
            const { targetPuuid, roomCode } = payload;
            // 1. Verify sender is identified
            const senderPuuid = presence_service_1.presenceManager.getPuuidBySocketId(socket.id);
            if (!senderPuuid) {
                socket.emit("invite-failed", { reason: "not_identified" });
                logger_1.logger.warn("[invite] Unidentified user tried to send invite");
                return;
            }
            // 2. Verify target is a friend of sender (security)
            const senderFriends = presence_service_1.presenceManager.getFriends(senderPuuid);
            if (!senderFriends || !senderFriends.includes(targetPuuid)) {
                socket.emit("invite-failed", { reason: "not_friend" });
                logger_1.logger.warn(`[invite] ${senderPuuid} tried to invite non-friend ${targetPuuid}`);
                return;
            }
            // 3. Check rate limit
            const rateLimitKey = `${senderPuuid}:${targetPuuid}`;
            const lastInvite = inviteRateLimits.get(rateLimitKey);
            if (lastInvite && Date.now() - lastInvite < INVITE_RATE_LIMIT_MS) {
                socket.emit("invite-failed", { reason: "rate_limited" });
                logger_1.logger.debug(`[invite] Rate limited: ${senderPuuid} -> ${targetPuuid}`);
                return;
            }
            // 4. Check target is online
            if (!presence_service_1.presenceManager.isOnline(targetPuuid)) {
                socket.emit("invite-failed", { reason: "friend_offline" });
                logger_1.logger.debug(`[invite] Target offline: ${targetPuuid}`);
                return;
            }
            // 5. Check target is not already in the room
            const room = roomService.getRoomByCode(roomCode);
            if (room) {
                const targetSocketId = presence_service_1.presenceManager.getSocketId(targetPuuid);
                if (targetSocketId) {
                    const targetMemberInfo = socketToMember.get(targetSocketId);
                    if (targetMemberInfo && targetMemberInfo.roomId === room.id) {
                        socket.emit("invite-failed", { reason: "already_in_room" });
                        logger_1.logger.debug(`[invite] Target ${targetPuuid} already in room ${roomCode}`);
                        return;
                    }
                }
            }
            // 6. Send invitation to target
            const senderName = presence_service_1.presenceManager.getSummonerName(senderPuuid);
            exports.io.to(`user:${targetPuuid}`).emit("room-invite-received", {
                fromPuuid: senderPuuid,
                fromName: senderName,
                roomCode,
            });
            // 7. Confirm to sender
            socket.emit("invite-sent", { targetPuuid });
            // 8. Update rate limit
            inviteRateLimits.set(rateLimitKey, Date.now());
            logger_1.logger.info(`[invite] ${senderName} invited ${targetPuuid} to room ${roomCode}`);
        }
        catch (err) {
            logger_1.logger.error("[invite] Error processing invite", err);
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
