import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { logger } from "./utils/logger";
import roomRoutes from "./routes/room.routes";
import { RoomService } from "./services/room.service";
import { GroupSkinOption, Member } from "./types";
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

  socket.on("join-room", ({ roomId, memberId }: { roomId: string; memberId: string }) => {
    const room = roomService.getRoom(roomId);
    if (!room) return;

    const member = room.members.get(memberId);
    if (!member) return;

    logger.debug(`[socket] ${socket.id} join room ${roomId} as member ${memberId}`);

    socket.join(roomId);
    socketToMember.set(socket.id, { roomId, memberId });

    io.to(roomId).emit("room-state", roomService.serializeRoom(room));
  });

  socket.on("update-selection", (payload: any) => {
    const { roomId, memberId, championId, championAlias, skinId, chromaId } = payload;
    const room = roomService.getRoom(roomId);
    if (!room) return;
    
    const member = room.members.get(memberId);
    if (!member) return;

    member.championId = championId;
    member.championAlias = championAlias ?? "";
    member.skinId = skinId;
    member.chromaId = chromaId;

    io.to(roomId).emit("room-state", roomService.serializeRoom(room));
  });

  socket.on("owned-options", (payload: any) => {
    const { roomId, memberId, championId, championAlias, options } = payload;
    const room = roomService.getRoom(roomId);
    if (!room) return;

    const member = room.members.get(memberId);
    if (!member) return;

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

  socket.on("leave-room", ({ roomId, memberId }: { roomId: string; memberId: string }) => {
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

  socket.on("request-group-reroll", (payload: any) => {
    const { roomId, memberId, type, color } = payload;
    const room = roomService.getRoom(roomId);
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

  socket.on("suggest-color", (payload: any) => {
    const { roomId, senderId, skinId, chromaId } = payload;
    
    // 1. Validation basics
    const room = roomService.getRoom(roomId);
    if (!room) return;

    // 2. Verify sender is in the room
    const sender = room.members.get(senderId);
    if (!sender) {
        logger.warn(`[suggest-color] sender ${senderId} not found in room ${roomId}`);
        return;
    }

    logger.info(`[suggest-color] from ${sender.name} (${senderId}) in room ${roomId}: skin=${skinId} chroma=${chromaId}`);

    // 3. Find owner socket to send private message (optional) or broadcast to room
    // The requirement is "Relaye l'information à l'owner".
    // We can try to find the owner's socket, or just emit to the room with a specific event that clients ignore if they are not the owner.
    // For simplicity and robustness, existing pattern uses broadcasting room-state. 
    // We will emit 'color-suggestion-received' to the room, payload containing targetOwnerId? 
    // Actually, the client (Owner) just needs to know *someone* suggested something.
    // Let's send to the room. The Owner client will listen and display the toast/notification.
    
    io.to(roomId).emit("color-suggestion-received", {
        senderId,
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
