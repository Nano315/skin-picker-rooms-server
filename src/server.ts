import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { randomUUID, randomInt } from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

/* --------- Types --------- */

type Member = {
  id: string;
  name: string;
  championId: number;
  skinId: number;
  chromaId: number;
};

type Room = {
  id: string;
  code: string;
  ownerId: string;
  members: Map<string, Member>;
};

const rooms = new Map<string, Room>();
const socketToMember = new Map<string, { roomId: string; memberId: string }>();

/* --------- Utils --------- */

function generateRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // évite confusions 0/O, 1/I
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[randomInt(0, alphabet.length)];
  }
  return code;
}

function serializeRoom(room: Room) {
  return {
    id: room.id,
    code: room.code,
    ownerId: room.ownerId,
    members: Array.from(room.members.values()),
  };
}

/* --------- REST : create / join --------- */

// Créer une room
app.post("/rooms", (req, res) => {
  const name = String(req.body?.name ?? "").trim() || "Player";

  const roomId = randomUUID();
  const code = generateRoomCode();
  const ownerId = randomUUID();

  const owner: Member = {
    id: ownerId,
    name,
    championId: 0,
    skinId: 0,
    chromaId: 0,
  };

  const room: Room = {
    id: roomId,
    code,
    ownerId,
    members: new Map([[ownerId, owner]]),
  };

  rooms.set(roomId, room);

  res.json({
    roomId,
    code,
    memberId: ownerId,
    owner: true,
    room: serializeRoom(room),
  });
});

// Rejoindre une room avec un code
app.post("/rooms/join", (req, res) => {
  const code = String(req.body?.code ?? "")
    .trim()
    .toUpperCase();
  const name = String(req.body?.name ?? "").trim() || "Player";

  const room = Array.from(rooms.values()).find((r) => r.code === code);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  const memberId = randomUUID();
  const member: Member = {
    id: memberId,
    name,
    championId: 0,
    skinId: 0,
    chromaId: 0,
  };

  room.members.set(memberId, member);

  res.json({
    roomId: room.id,
    code: room.code,
    memberId,
    owner: room.ownerId === memberId,
    room: serializeRoom(room),
  });
});

/* --------- WebSocket : synchro en temps réel --------- */

io.on("connection", (socket) => {
  console.log("[socket] connected", socket.id);

  // Quand un client “attache” son socket à un membre d’une room
  socket.on(
    "join-room",
    ({ roomId, memberId }: { roomId: string; memberId: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;

      const member = room.members.get(memberId);
      if (!member) return;

      console.log(
        `[socket] ${socket.id} join room ${roomId} as member ${memberId}`
      );

      socket.join(roomId);
      socketToMember.set(socket.id, { roomId, memberId });

      // Envoyer l’état actuel de la room à tout le monde
      io.to(roomId).emit("room-state", serializeRoom(room));
    }
  );

  // Mise à jour du skin/chroma
  socket.on(
    "update-selection",
    (payload: {
      roomId: string;
      memberId: string;
      championId: number;
      skinId: number;
      chromaId: number;
    }) => {
      const { roomId, memberId, championId, skinId, chromaId } = payload;
      const room = rooms.get(roomId);
      if (!room) return;
      const member = room.members.get(memberId);
      if (!member) return;

      member.championId = championId;
      member.skinId = skinId;
      member.chromaId = chromaId;

      io.to(roomId).emit("room-state", serializeRoom(room));
    }
  );

  // Déconnexion
  socket.on("disconnect", () => {
    const info = socketToMember.get(socket.id);
    socketToMember.delete(socket.id);
    if (!info) return;

    const { roomId, memberId } = info;
    const room = rooms.get(roomId);
    if (!room) return;

    room.members.delete(memberId);
    console.log(
      `[socket] ${socket.id} left room ${roomId} (member ${memberId})`
    );

    if (room.members.size === 0) {
      rooms.delete(roomId);
      console.log(`[room] deleted empty room ${roomId}`);
    } else {
      io.to(roomId).emit("room-state", serializeRoom(room));
    }
  });
});

/* --------- Lancement --------- */

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`Rooms server listening on http://localhost:${PORT}`);
});
