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
import type {
  JoinRoomPayload,
  LeaveRoomPayload,
  UpdateSelectionPayload,
  OwnedOptionsPayload,
  RequestGroupRerollPayload,
  SuggestColorPayload,
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
    const info = socketToMember.get(socket.id);
    socketToMember.delete(socket.id);
    removeClientVersion(socket.id);

    if (info) {
      logger.debug(`[socket] ${socket.id} disconnected (room ${info.roomId})`);
      handleMemberLeave(info.roomId, info.memberId, "disconnect");
    }
  });

  socket.on("request-group-reroll", safeHandler<RequestGroupRerollPayload>("request-group-reroll", (payload) => {
    const { roomId, memberId, type, color } = payload;

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

      const opts = (m.options ?? []).filter((o) => o.auraColor === color);
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

    // Emit versioned group-apply-combo
    emitVersionedToRoom(io, roomId, "group-apply-combo", (version) =>
      createGroupApplyComboPayload({ type, color, picks }, version)
    );

    // Emit versioned room-state
    const serializedRoom = roomService.serializeRoom(room);
    emitVersionedToRoom(io, roomId, "room-state", (version) =>
      createRoomStatePayload(serializedRoom, version)
    );
  }));

  socket.on("suggest-color", safeHandler<SuggestColorPayload>("suggest-color", (payload) => {
    const { roomId, memberId, skinId, chromaId } = payload;

    logger.info(`[suggest-color] received suggestion in room ${roomId} from member ${memberId}`);

    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }

    const sender = room.members.get(memberId);
    if (!sender) {
      throw new AppError(ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
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
  }));
});

// --- Start ---
// Only start the server if this module is run directly (not imported for tests)
if (process.env.NODE_ENV !== "test") {
  const PORT = Number(process.env.PORT) || 4000;
  httpServer.listen(PORT, "0.0.0.0", () => {
    logger.info(`Rooms server listening on port ${PORT}`);
  });
}
