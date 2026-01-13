import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { logger } from "./utils/logger";
import { getRoomOrWarn, getRoomAndMemberOrWarn, safeHandler } from "./utils/socketHelpers";
import { AppError, ErrorCodes } from "./utils/errors";
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
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
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
     // Room still active, notify state update
     io.to(roomId).emit("room-state", roomService.serializeRoom(room));
  }
}

io.on("connection", (socket) => {
  logger.info(`[socket] connected ${socket.id}`);

  socket.on("join-room", safeHandler<JoinRoomPayload>("join-room", ({ roomId, memberId }, sock) => {
    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }

    const member = room.members.get(memberId);
    if (!member) {
      throw new AppError(ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
    }

    logger.debug(`[socket] ${sock.id} join room ${roomId} as member ${memberId}`);

    sock.join(roomId);
    socketToMember.set(sock.id, { roomId, memberId });

    io.to(roomId).emit("room-state", roomService.serializeRoom(room));
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

    io.to(roomId).emit("room-state", roomService.serializeRoom(room));
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

    io.to(roomId).emit("room-state", roomService.serializeRoom(room));
  }));

  socket.on("leave-room", safeHandler<LeaveRoomPayload>("leave-room", ({ roomId, memberId }, sock) => {
    logger.debug(`[leave-room] ${sock.id} explicit leave room ${roomId}`);

    handleMemberLeave(roomId, memberId, "leave");

    socketToMember.delete(sock.id);
    sock.leave(roomId);
  }));

  socket.on("disconnect", () => {
    const info = socketToMember.get(socket.id);
    socketToMember.delete(socket.id);

    if (info) {
      logger.debug(`[socket] ${socket.id} disconnected (room ${info.roomId})`);
      handleMemberLeave(info.roomId, info.memberId, "disconnect");
    }
  });

  socket.on("request-group-reroll", safeHandler<RequestGroupRerollPayload>("request-group-reroll", (payload, sock) => {
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

    io.to(roomId).emit("group-apply-combo", { type, color, picks });
    io.to(roomId).emit("room-state", roomService.serializeRoom(room));
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
  logger.info(`Rooms server listening on port ${PORT}`);
});
