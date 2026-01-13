import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { logger } from "./utils/logger";
import { getRoomOrWarn, getMemberOrWarn, getRoomAndMemberOrWarn } from "./utils/socketHelpers";
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

  socket.on("join-room", ({ roomId, memberId }: JoinRoomPayload) => {
    const { room, member } = getRoomAndMemberOrWarn(roomService, roomId, memberId, "join-room");
    if (!room || !member) return;

    logger.debug(`[socket] ${socket.id} join room ${roomId} as member ${memberId}`);

    socket.join(roomId);
    socketToMember.set(socket.id, { roomId, memberId });

    io.to(roomId).emit("room-state", roomService.serializeRoom(room));
  });

  socket.on("update-selection", (payload: UpdateSelectionPayload) => {
    const { roomId, memberId, championId, championAlias, skinId, chromaId } = payload;
    const { room, member } = getRoomAndMemberOrWarn(roomService, roomId, memberId, "update-selection");
    if (!room || !member) return;

    member.championId = championId;
    member.championAlias = championAlias ?? "";
    member.skinId = skinId;
    member.chromaId = chromaId;

    io.to(roomId).emit("room-state", roomService.serializeRoom(room));
  });

  socket.on("owned-options", (payload: OwnedOptionsPayload) => {
    const { roomId, memberId, championId, championAlias, options } = payload;
    const { room, member } = getRoomAndMemberOrWarn(roomService, roomId, memberId, "owned-options");
    if (!room || !member) return;

    member.championId = championId;
    member.championAlias = championAlias ?? "";
    member.options = Array.isArray(options) ? options : [];
    member.isReady = true;

    // Security check
    if (member.options && member.options.length > 2000) {
        logger.warn(`[Security] Member ${memberId} sent too many options (${member.options.length}). Truncating.`);
        member.options = member.options.slice(0, 2000);
    }

    logger.debug(`[owned-options] member=${memberId} room=${roomId} options=${member.options.length}`);

    try {
        roomService.recomputeSynergy(room);
    } catch (err) {
        logger.error(`Error recomputing synergy: ${err}`);
    }

    io.to(roomId).emit("room-state", roomService.serializeRoom(room));
  });

  socket.on("leave-room", ({ roomId, memberId }: LeaveRoomPayload) => {
    logger.debug(`[socket] ${socket.id} explicit leave room ${roomId}`);
    
    handleMemberLeave(roomId, memberId, "leave");

    socketToMember.delete(socket.id);
    socket.leave(roomId);
  });

  socket.on("disconnect", () => {
    const info = socketToMember.get(socket.id);
    socketToMember.delete(socket.id);

    if (info) {
      logger.debug(`[socket] ${socket.id} disconnected (room ${info.roomId})`);
      handleMemberLeave(info.roomId, info.memberId, "disconnect");
    }
  });

  socket.on("request-group-reroll", (payload: RequestGroupRerollPayload) => {
    const { roomId, memberId, type, color } = payload;
    const room = getRoomOrWarn(roomService, roomId, "request-group-reroll");
    if (!room) return;

    if (room.ownerId !== memberId) {
        logger.warn(`[group-reroll] non-owner tried to reroll: ${memberId}`);
        return;
    }

    const synergy = room.synergy;
    if (!synergy) return;

    const entry = synergy.colors.find((c) => c.type === type && c.color === color);
    if (!entry) {
        logger.warn(`[group-reroll] no synergy entry for color=${color} in room=${roomId}`);
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

    logger.info(`[group-reroll] applying combo color=${color} in room=${roomId}`);

    room.activeSynergy = { type, color, timestamp: Date.now() };
    if (type === "sameColor") {
        room.activeColor = color;
    }

    io.to(roomId).emit("group-apply-combo", { type, color, picks });
    io.to(roomId).emit("room-state", roomService.serializeRoom(room));
  });

  socket.on("suggest-color", (payload: SuggestColorPayload) => {
    const { roomId, memberId, skinId, chromaId } = payload;

    logger.info(`[suggest-color] received suggestion in room ${roomId} from member ${memberId}`);

    // Validate room and sender
    const { room, member: sender } = getRoomAndMemberOrWarn(roomService, roomId, memberId, "suggest-color");
    if (!room || !sender) return;

    logger.info(`[suggest-color] from ${sender.name} (${memberId}) in room ${roomId}: skin=${skinId} chroma=${chromaId}`);

    // 3. Broadcast to room - Owner client will listen and display the suggestion
    logger.info(`[suggest-color] broadcasting suggestion to room ${roomId}`);

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
  logger.info(`Rooms server listening on port ${PORT}`);
});
