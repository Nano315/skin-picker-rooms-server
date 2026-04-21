import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { logger } from "./utils/logger";
import { createSafeHandler } from "./utils/socketHelpers";
import { AppError, ErrorCodes } from "./utils/errors";
import {
  registerClientVersion,
  getClientVersion,
  removeClientVersion,
  createColorSuggestionPayload,
  createRoomStatePayload,
  createGroupApplyComboPayload,
  emitVersionedToRoom,
} from "./utils/versionAdapter";
import { CURRENT_EVENT_VERSION } from "./types";
import roomRoutes from "./routes/room.routes";
import { RoomService } from "./services/room.service";
import { presenceManager } from "./services/presence.service";
import type {
  JoinRoomPayload,
  LeaveRoomPayload,
  UpdateSelectionPayload,
  OwnedOptionsPayload,
  RequestGroupRerollPayload,
  SuggestColorPayload,
  ApplySkinLineSynergyPayload,
  IdentifyPayload,
  SendRoomInvitePayload,
} from "./types";
import { randomInt } from "crypto";

const app = express();
const roomService = RoomService.getInstance();

// --- Configuration & Middleware ---
app.use(helmet());
app.use(cors()); // Configure origin in production
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100, 
  standardHeaders: true, 
  legacyHeaders: false,
});
app.use(limiter);

// --- Routes ---
app.use("/rooms", roomRoutes);

app.get("/", (req, res) => {
  res.send("Skin Picker Rooms server is running");
});

// --- Server Setup ---
export const httpServer = http.createServer(app);
export const io = new SocketIOServer(httpServer, {
  cors: { origin: "*" },
});

// --- Socket.io Logic ---

// Map socketId -> { roomId, memberId }
const socketToMember = new Map<string, { roomId: string; memberId: string }>();

// Rate limiting for room invitations (Story 4.5)
// Key: `${senderPuuid}:${targetPuuid}` -> timestamp of last invite
const inviteRateLimits = new Map<string, number>();
const INVITE_RATE_LIMIT_MS = 10000; // 10 seconds
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

function handleMemberLeave(roomId: string, memberId: string, reason: string) {
  const room = roomService.getRoom(roomId);
  if (!room) return;

  const result = roomService.removeMember(room, memberId);

  if (result.roomClosed) {
    // Room closed, notify everyone
    io.to(roomId).emit("room-closed", { reason: result.reason });
    // Disconnect all sockets in this room
    io.in(roomId).disconnectSockets(true);
  } else {
    // Room still active, notify state update with versioned payload
    const serializedRoom = roomService.serializeRoom(room);
    emitVersionedToRoom(io, roomId, "room-state", (version) =>
      createRoomStatePayload(serializedRoom, version)
    );
  }
}

io.on("connection", (socket) => {
  // Register client version from handshake query
  const rawVersion = socket.handshake.query.clientVersion;
  const clientVersion = registerClientVersion(
    socket.id,
    typeof rawVersion === "string" ? parseInt(rawVersion, 10) || 1 : 1
  );
  logger.info(`[socket] connected ${socket.id} (v${clientVersion})`);

  const safeHandler = createSafeHandler(socket);

  socket.on("join-room", safeHandler<JoinRoomPayload>("join-room", ({ roomId, memberId }) => {
    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }

    const member = room.members.get(memberId);
    if (!member) {
      throw new AppError(ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
    }

    logger.debug(`[socket] ${socket.id} join room ${roomId} as member ${memberId}`);

    socket.join(roomId);
    socketToMember.set(socket.id, { roomId, memberId });

    // Emit versioned room-state
    const serializedRoom = roomService.serializeRoom(room);
    emitVersionedToRoom(io, roomId, "room-state", (version) =>
      createRoomStatePayload(serializedRoom, version)
    );
  }));

  socket.on("update-selection", safeHandler<UpdateSelectionPayload>("update-selection", (payload) => {
    const { roomId, memberId, championId, championAlias, skinId, chromaId } = payload;

    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }

    const member = room.members.get(memberId);
    if (!member) {
      throw new AppError(ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
    }

    member.championId = championId;
    member.championAlias = championAlias ?? "";
    member.skinId = skinId;
    member.chromaId = chromaId;

    // Emit versioned room-state
    const serializedRoom = roomService.serializeRoom(room);
    emitVersionedToRoom(io, roomId, "room-state", (version) =>
      createRoomStatePayload(serializedRoom, version)
    );
  }));

  socket.on("owned-options", safeHandler<OwnedOptionsPayload>("owned-options", (payload) => {
    const { roomId, memberId, championId, championAlias, options } = payload;

    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }

    const member = room.members.get(memberId);
    if (!member) {
      throw new AppError(ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
    }

    member.championId = championId;
    member.championAlias = championAlias ?? "";
    member.options = Array.isArray(options) ? options : [];
    member.isReady = true;

    // Security check
    if (member.options && member.options.length > 2000) {
      logger.warn(`[owned-options] Member ${memberId} sent too many options (${member.options.length}). Truncating.`, {
        roomId,
        memberId,
        optionsCount: member.options.length,
      });
      member.options = member.options.slice(0, 2000);
    }

    logger.debug(`[owned-options] member=${memberId} room=${roomId} options=${member.options.length}`);

    roomService.recomputeSynergy(room);

    // Check if we should auto-apply (all members have champions and options)
    if (roomService.shouldAutoApply(room)) {
      const result = roomService.generateAutoApplyPicks(room);
      if (result) {
        // Emit auto-apply combo (color or skin line depending on syncMode)
        emitVersionedToRoom(io, roomId, "group-apply-combo", (version) =>
          createGroupApplyComboPayload({
            type: result.skinLineId ? "skinLine" : "sameColor",
            color: result.color,
            skinLineId: result.skinLineId,
            skinLineName: result.skinLineName,
            picks: result.picks,
            autoApplied: true,
          }, version)
        );
      }
    }

    // Emit versioned room-state
    const serializedRoom = roomService.serializeRoom(room);
    emitVersionedToRoom(io, roomId, "room-state", (version) =>
      createRoomStatePayload(serializedRoom, version)
    );
  }));

  socket.on("leave-room", safeHandler<LeaveRoomPayload>("leave-room", ({ roomId, memberId }) => {
    logger.debug(`[leave-room] ${socket.id} explicit leave room ${roomId}`);

    handleMemberLeave(roomId, memberId, "leave");

    socketToMember.delete(socket.id);
    socket.leave(roomId);
  }));

  socket.on("disconnect", () => {
    // Handle room membership cleanup
    const info = socketToMember.get(socket.id);
    socketToMember.delete(socket.id);
    removeClientVersion(socket.id);

    if (info) {
      logger.debug(`[socket] ${socket.id} disconnected (room ${info.roomId})`);
      handleMemberLeave(info.roomId, info.memberId, "disconnect");
    }

    // Handle presence cleanup and friend notifications (Story 4.3)
    const puuid = presenceManager.getPuuidBySocketId(socket.id);
    if (puuid) {
      const friends = presenceManager.getFriends(puuid);
      const summonerName = presenceManager.getSummonerName(puuid);

      // Notify online friends that this user is offline
      if (friends) {
        for (const friendPuuid of friends) {
          if (presenceManager.isOnline(friendPuuid)) {
            io.to(`user:${friendPuuid}`).emit("friend-offline", { puuid });
          }
        }
      }

      // Clear presence after notifications
      presenceManager.disconnect(socket.id);
      logger.info(`[identify] ${summonerName} (${puuid}) disconnected`);
    }
  });

  socket.on("request-group-reroll", safeHandler<RequestGroupRerollPayload>("request-group-reroll", (payload) => {
    const { roomId, memberId, type, color, skinLineId, sourceMemberId } = payload;

    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }

    if (room.ownerId !== memberId) {
      throw new AppError(ErrorCodes.UNAUTHORIZED, `Only owner can trigger group reroll`, true, {
        roomId,
        memberId,
        ownerId: room.ownerId,
      });
    }

    const synergy = room.synergy;
    if (!synergy) {
      logger.warn(`[request-group-reroll] No synergy computed for room ${roomId}`);
      return;
    }

    const entry = synergy.colors.find((c) => c.type === type && c.color === color);
    if (!entry) {
      logger.warn(`[request-group-reroll] No synergy entry for color=${color} in room=${roomId}`);
      return;
    }

    const picks: { memberId: string; skinId: number; chromaId: number }[] = [];

    // Reroll logic
    for (const m of room.members.values()) {
      if (!m.isReady) continue;

      const opts = (m.options ?? []).filter((o) => {
        let match = o.auraColor === color;
        if (skinLineId !== undefined) {
          match = match && o.skinLineId === skinLineId;
        }
        return match;
      });

      if (!opts.length) {
        // Keep current
        picks.push({ memberId: m.id, skinId: m.skinId, chromaId: m.chromaId });
        continue;
      }

      const idx = randomInt(0, opts.length);
      const opt = opts[idx];

      m.skinId = opt.skinId;
      m.chromaId = opt.chromaId;

      picks.push({ memberId: m.id, skinId: opt.skinId, chromaId: opt.chromaId });
    }

    logger.info(`[request-group-reroll] applying combo color=${color} in room=${roomId}`);

    room.activeSynergy = { type, color, timestamp: Date.now() };
    if (type === "sameColor") {
      room.activeColor = color;
    }

    // Add to history
    roomService.addToHistory(room, color, picks);

    // Emit versioned group-apply-combo
    emitVersionedToRoom(io, roomId, "group-apply-combo", (version) =>
      createGroupApplyComboPayload({ type, color, picks, sourceMemberId, autoApplied: false }, version)
    );

    // Emit versioned room-state
    const serializedRoom = roomService.serializeRoom(room);
    emitVersionedToRoom(io, roomId, "room-state", (version) =>
      createRoomStatePayload(serializedRoom, version)
    );
  }));

  socket.on("suggest-color", (payload: SuggestColorPayload, ack?: (response: { success: boolean; error?: string }) => void) => {
    try {
      const { roomId, memberId, skinId, chromaId } = payload;

      logger.info(`[suggest-color] received suggestion in room ${roomId} from member ${memberId}`);

      const room = roomService.getRoom(roomId);
      if (!room) {
        logger.warn(`[suggest-color] Room ${roomId} not found`);
        if (ack) ack({ success: false, error: 'Room not found' });
        return;
      }

      const sender = room.members.get(memberId);
      if (!sender) {
        logger.warn(`[suggest-color] Member ${memberId} not found in room ${roomId}`);
        if (ack) ack({ success: false, error: 'Member not found' });
        return;
      }

      logger.info(`[suggest-color] from ${sender.name} (${memberId}) in room ${roomId}: skin=${skinId} chroma=${chromaId}`);

      // Broadcast to room with version-appropriate payload
      emitVersionedToRoom(io, roomId, "color-suggestion-received", (version) =>
        createColorSuggestionPayload(
          {
            memberId,
            memberName: sender.name,
            skinId,
            chromaId,
          },
          version
        )
      );

      // Send acknowledgment to sender
      if (ack) {
        ack({ success: true });
        logger.debug(`[suggest-color] Acknowledged suggestion from ${memberId}`);
      }
    } catch (err) {
      logger.error(`[suggest-color] Error processing suggestion`, err);
      if (ack) ack({ success: false, error: 'Internal server error' });
    }
  });

  // --- Apply Skin Line Synergy (Story 6.6) ---
  socket.on("apply-skin-line-synergy", safeHandler<ApplySkinLineSynergyPayload>("apply-skin-line-synergy", (payload) => {
    const { roomId, memberId, skinLineId } = payload;

    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }

    if (room.ownerId !== memberId) {
      throw new AppError(ErrorCodes.UNAUTHORIZED, `Only owner can apply skin line synergy`, true, {
        roomId,
        memberId,
        ownerId: room.ownerId,
      });
    }

    const result = roomService.applySkinLineSynergy(room, skinLineId);
    if (!result) {
      throw new AppError(ErrorCodes.INVALID_PAYLOAD, `Skin line ${skinLineId} not available`, true, { skinLineId });
    }

    logger.info(`[apply-skin-line-synergy] Applied skin line ${result.skinLineName} in room ${room.code}`);

    // Broadcast combo
    emitVersionedToRoom(io, roomId, "group-apply-combo", (version) =>
      createGroupApplyComboPayload({
        type: "skinLine",
        skinLineId: result.skinLineId,
        skinLineName: result.skinLineName,
        picks: result.picks,
        autoApplied: false,
      }, version)
    );

    // Broadcast updated room state
    const serializedRoom = roomService.serializeRoom(room);
    emitVersionedToRoom(io, roomId, "room-state", (version) =>
      createRoomStatePayload(serializedRoom, version)
    );
  }));

  // --- Identity Handshake (Story 4.3) ---
  socket.on("identify", (payload: IdentifyPayload) => {
    try {
      const { puuid, summonerName, friends } = payload;

      // Validate payload
      if (!puuid || typeof puuid !== "string" || puuid.length < 10) {
        logger.warn("[identify] Invalid puuid received", { puuid });
        return;
      }
      if (!summonerName || typeof summonerName !== "string") {
        logger.warn("[identify] Invalid summonerName received", { summonerName });
        return;
      }
      if (!Array.isArray(friends)) {
        logger.warn("[identify] Invalid friends array received");
        return;
      }

      // 1. Register presence
      presenceManager.identify(socket, puuid, summonerName);

      // 2. Store friends list
      presenceManager.setFriends(puuid, friends);

      // 3. Find online friends
      const onlineFriends = presenceManager.getOnlineFriends(friends);

      // 4. Confirm to client
      socket.emit("identity-confirmed", { onlineFriends });

      // 5. Notify friends that this user is online
      for (const friendPuuid of friends) {
        if (presenceManager.isOnline(friendPuuid)) {
          io.to(`user:${friendPuuid}`).emit("friend-online", { puuid, summonerName });
        }
      }

      logger.info(`[identify] ${summonerName} (${puuid}) identified with ${friends.length} friends, ${onlineFriends.length} online`);
    } catch (err) {
      logger.error("[identify] Error processing identify", err);
    }
  });

  // --- Room Invitations (Story 4.5) ---
  socket.on("send-room-invite", (payload: SendRoomInvitePayload) => {
    try {
      const { targetPuuid, roomCode } = payload;

      if (!targetPuuid || typeof targetPuuid !== "string" || targetPuuid.length < 10) {
        logger.warn("[invite] Invalid targetPuuid received", { targetPuuid });
        socket.emit("invite-failed", { reason: "invalid_payload" });
        return;
      }
      if (!roomCode || typeof roomCode !== "string") {
        logger.warn("[invite] Invalid roomCode received", { roomCode });
        socket.emit("invite-failed", { reason: "invalid_payload" });
        return;
      }

      // 1. Verify sender is identified
      const senderPuuid = presenceManager.getPuuidBySocketId(socket.id);
      if (!senderPuuid) {
        socket.emit("invite-failed", { reason: "not_identified" });
        logger.warn("[invite] Unidentified user tried to send invite");
        return;
      }

      // 2. Verify target is a friend of sender (security)
      const skipFriendCheck =
        process.env.NODE_ENV === "development" &&
        process.env.SKIP_FRIEND_CHECK === "true";
      if (skipFriendCheck) {
        logger.warn(`[invite] Friend check bypassed (SKIP_FRIEND_CHECK=true, dev mode)`);
      }
      if (!skipFriendCheck) {
        const senderFriends = presenceManager.getFriends(senderPuuid);
        if (!senderFriends || !senderFriends.includes(targetPuuid)) {
          socket.emit("invite-failed", { reason: "not_friend" });
          logger.warn(`[invite] ${senderPuuid} tried to invite non-friend ${targetPuuid}`);
          return;
        }
      }

      // 3. Check rate limit
      const rateLimitKey = `${senderPuuid}:${targetPuuid}`;
      const lastInvite = inviteRateLimits.get(rateLimitKey);
      if (lastInvite && Date.now() - lastInvite < INVITE_RATE_LIMIT_MS) {
        socket.emit("invite-failed", { reason: "rate_limited" });
        logger.debug(`[invite] Rate limited: ${senderPuuid} -> ${targetPuuid}`);
        return;
      }

      // 4. Check target is online
      if (!presenceManager.isOnline(targetPuuid)) {
        socket.emit("invite-failed", { reason: "friend_offline" });
        logger.debug(`[invite] Target offline: ${targetPuuid}`);
        return;
      }

      // 5. Check target is not already in the room.
      //    Member.id is a randomly generated UUID, NOT a PUUID, so we cannot
      //    compare it directly with targetPuuid. Instead we resolve the target's
      //    current socket via the presence manager and check whether that socket
      //    is currently registered as a member of this room.
      const room = roomService.getRoomByCode(roomCode);
      if (room) {
        const targetSocketId = presenceManager.getSocketId(targetPuuid);
        const targetMembership = targetSocketId ? socketToMember.get(targetSocketId) : null;
        if (targetMembership && targetMembership.roomId === room.id) {
          socket.emit("invite-failed", { reason: "already_in_room" });
          logger.debug(`[invite] Target ${targetPuuid} already in room ${roomCode}`);
          return;
        }
      }

      // 6. Send invitation to target
      const senderName = presenceManager.getSummonerName(senderPuuid);
      io.to(`user:${targetPuuid}`).emit("room-invite-received", {
        fromPuuid: senderPuuid,
        fromName: senderName,
        roomCode,
      });

      // 7. Confirm to sender
      socket.emit("invite-sent", { targetPuuid });

      // 8. Update rate limit
      inviteRateLimits.set(rateLimitKey, Date.now());

      logger.info(`[invite] ${senderName} invited ${targetPuuid} to room ${roomCode}`);
    } catch (err) {
      logger.error("[invite] Error processing invite", err);
    }
  });
});

// --- Start ---
// Only start the server if this module is run directly (not imported for tests)
if (process.env.NODE_ENV !== "test") {
  const PORT = Number(process.env.PORT) || 4000;
  httpServer.listen(PORT, "0.0.0.0", () => {
    logger.info(`Rooms server listening on port ${PORT}`);
  });
}
