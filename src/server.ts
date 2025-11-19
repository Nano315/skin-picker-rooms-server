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
  championAlias: string;
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
const roomsByCode = new Map<string, Room>();

function registerRoom(room: Room) {
  rooms.set(room.id, room);
  roomsByCode.set(room.code, room);
}

function unregisterRoom(room: Room) {
  rooms.delete(room.id);
  roomsByCode.delete(room.code);
}

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
    championAlias: "",
    skinId: 0,
    chromaId: 0,
  };

  const room: Room = {
    id: roomId,
    code,
    ownerId,
    members: new Map([[ownerId, owner]]),
  };

  registerRoom(room);

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

  const room = roomsByCode.get(code);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  const memberId = randomUUID();
  const member: Member = {
    id: memberId,
    name,
    championId: 0,
    championAlias: "",
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

// ➜ Ajouter des bots dans une room (pour tests)
//    POST /rooms/:code/bots
//    Body JSON (tout optionnel) :
//    {
//      "count": 3,
//      "namePrefix": "Bot",
//      "championId": 266,
//      "skinId": 266000,
//      "chromaId": 0
//    }
app.post("/rooms/:code/bots", (req, res) => {
  const rawCode = String(req.params.code ?? "")
    .trim()
    .toUpperCase();
  const room = roomsByCode.get(rawCode);

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  const body = req.body ?? {};
  const rawCount = Number(body.count ?? 1);

  // Sécurité : 1 ≤ count ≤ 5
  const count = Number.isFinite(rawCount)
    ? Math.min(Math.max(Math.floor(rawCount), 1), 5)
    : 1;

  const namePrefix =
    typeof body.namePrefix === "string" && body.namePrefix.trim()
      ? body.namePrefix.trim()
      : "Bot";

  const forcedChampionId =
    typeof body.championId === "number" ? body.championId : undefined;
  const forcedSkinId =
    typeof body.skinId === "number" ? body.skinId : undefined;
  const forcedChromaId =
    typeof body.chromaId === "number" ? body.chromaId : undefined;

  const createdBots: Member[] = [];

  console.log(
    `[dev-bots] adding ${count} bot(s) to room ${room.id} (code=${room.code})`
  );

  const currentSize = room.members.size;

  for (let i = 0; i < count; i++) {
    const memberId = randomUUID();

    const bot: Member = {
      id: memberId,
      name: `${namePrefix} ${currentSize + 1 + i}`,
      championId:
        forcedChampionId !== undefined ? forcedChampionId : randomInt(1, 201),
      championAlias: "",
      skinId:
        forcedSkinId !== undefined ? forcedSkinId : randomInt(1000, 999999),
      chromaId: forcedChromaId !== undefined ? forcedChromaId : 0,
    };

    room.members.set(memberId, bot);
    createdBots.push(bot);
  }

  io.to(room.id).emit("room-state", serializeRoom(room));

  return res.json({
    ok: true,
    added: createdBots.length,
    room: serializeRoom(room),
    bots: createdBots,
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
      championAlias: string;
      skinId: number;
      chromaId: number;
    }) => {
      const { roomId, memberId, championId, championAlias, skinId, chromaId } =
        payload;

      const room = rooms.get(roomId);
      if (!room) return;
      const member = room.members.get(memberId);
      if (!member) return;

      member.championId = championId;
      member.championAlias = championAlias ?? "";
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
      unregisterRoom(room);
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
