import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { randomUUID, randomInt } from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();
app.use(helmet());
app.use(cors()); // Note: In production, configure origin explicitly
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true, 
  legacyHeaders: false,
});

app.use(limiter);

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

const MAX_MEMBERS = 5;

/* --------- Types --------- */

type GroupSkinOption = {
  skinId: number;
  chromaId: number; // 0 = base
  auraColor: string | null; // string reçue du front ("#6248FF", etc.)
};

type Member = {
  id: string;
  name: string;
  championId: number;
  championAlias: string;
  skinId: number;
  chromaId: number;

  // nouvelles infos pour la feature de groupe
  options?: GroupSkinOption[];
  isReady: boolean; // true quand le client a envoyé ses options (remplace ready?)
};

type ColorSynergy = {
  type: "sameColor";
  color: string;
  members: string[]; // ids des membres qui ont au moins une option de cette couleur
  coverage: number; // members.length / totalMembers
  combinationCount: number; // nombre total de combinaisons possibles
};

type SynergySummary = {
  colors: ColorSynergy[];
};

type Room = {
  id: string;
  code: string;
  ownerId: string;
  members: Map<string, Member>;
  synergy?: SynergySummary;
  activeSynergy?: {
    type: string;
    color: string;
    timestamp: number;
  };
  activeColor?: string;
};

const rooms = new Map<string, Room>();
const socketToMember = new Map<string, { roomId: string; memberId: string }>();
const roomsByCode = new Map<string, Room>();

function closeRoom(room: Room, reason: string) {
  // prévenir tous les clients
  io.to(room.id).emit("room-closed", { reason });

  // déconnecter tous les sockets liés à cette room
  for (const [socketId, info] of socketToMember) {
    if (info.roomId === room.id) {
      const sock = io.sockets.sockets.get(socketId);
      if (sock) {
        sock.leave(room.id);
        sock.disconnect(true);
      }
      socketToMember.delete(socketId);
    }
  }

  unregisterRoom(room);
  console.log(`[room] closed room ${room.id} (${reason})`);
}

function handleMemberLeave(
  room: Room,
  memberId: string,
  reason: "leave" | "disconnect"
) {
  const member = room.members.get(memberId);
  if (!member) return;

  room.members.delete(memberId);

  // Si c’est le owner -> on ferme la room pour tout le monde
  if (memberId === room.ownerId) {
    closeRoom(room, reason === "leave" ? "owner-left" : "owner-disconnected");
    return;
  }

  // Sinon comportement normal : on retire juste le joueur
  if (room.members.size === 0) {
    unregisterRoom(room);
    console.log(`[room] deleted empty room ${room.id}`);
  } else {
    // Recalculer la synergie car un membre est parti
    recomputeSynergy(room);
    io.to(room.id).emit("room-state", serializeRoom(room));
  }
}

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
    synergy: room.synergy ?? undefined,
    activeSynergy: room.activeSynergy,
    activeColor: room.activeColor,
  };
}

function recomputeSynergy(room: Room) {
  const allMembers = Array.from(room.members.values());

  // Modif: On considère qu'un membre est "prêt" pour la synergie s'il a envoyé ses options
  // ET qu'il a au moins une option (ce qui veut dire qu'il a lock un champion valide)
  const readyMembers = allMembers.filter((m) => m.options && m.options.length > 0);

  const totalReady = readyMembers.length;

  // On évite le spam de logs (uniquement si le nb change ou debug spécifique)
  // console.log(`[recomputeSynergy] Room ${room.code}: ${totalReady}/${allMembers.length} members ready.`);

  if (totalReady < 1) { // On autorise 1 seul joueur pour tester (mode solo)
    room.synergy = { colors: [] };
    return;
  }

  const allColors = new Set<string>();

  for (const m of readyMembers) {
    if (!m.options) continue;
    for (const opt of m.options) {
      if (!opt.auraColor) continue;
      allColors.add(opt.auraColor);
    }
  }

  const colors: ColorSynergy[] = [];

  for (const color of allColors) {
    const participants: string[] = [];
    let comboCount = 1;

    for (const m of readyMembers) {
      const opts = (m.options ?? []).filter((o) => o.auraColor === color);

      // Si un joueur n'a pas la couleur, il casse la chaine "parfaite", 
      // mais on peut vouloir afficher les synergies partielles.
      if (!opts.length) {
        // Pour l'instant, on est strict : tout le monde doit avoir la couleur
        // Sinon le bouton "reroll group" va faire fail ceux qui ne l'ont pas.
        comboCount = 0;
        break;
      }

      participants.push(m.id);
      comboCount *= opts.length;
    }

    if (comboCount > 0) {
      colors.push({
        type: "sameColor",
        color,
        members: participants,
        coverage: 1, // 100% des readyMembers
        combinationCount: comboCount,
      });
    }
  }

  colors.sort(
    (a, b) => b.coverage - a.coverage || b.combinationCount - a.combinationCount
  );

  room.synergy = { colors };

  // Log seulement si on trouve quelque chose, pour éviter le spam
  if (colors.length > 0) {
    console.log(`[Synergy] Room ${room.code}: Found ${colors.length} synergies (Best: ${colors[0].color})`);
  }
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
    isReady: false,
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

  // ➜ Limite de 5 membres
  if (room.members.size >= MAX_MEMBERS) {
    return res.status(403).json({ error: "Room is full" });
  }

  const memberId = randomUUID();
  const member: Member = {
    id: memberId,
    name,
    championId: 0,
    championAlias: "",
    skinId: 0,
    chromaId: 0,
    isReady: false,
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

// -> Ajouter des bots dans une room (pour tests)
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

  const requestedCount = Number.isFinite(rawCount)
    ? Math.min(Math.max(Math.floor(rawCount), 1), 5)
    : 1;

  // ➜ slots restants dans la room
  const freeSlots = MAX_MEMBERS - room.members.size;
  if (freeSlots <= 0) {
    return res.status(400).json({
      error: "Room is already full",
    });
  }

  const count = Math.min(requestedCount, freeSlots);

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
      isReady: true, // Bots are always ready!
      options: [], // Bots don't have options for now, or we could mock them
    };

    room.members.set(memberId, bot);
    createdBots.push(bot);
  }

  // Recalculate synergy with new bots
  recomputeSynergy(room);

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
      // Note: serializeRoom includes activeSynergy now, so late joiners get it.
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

  // Réception des options complètes pour le champion lock
  socket.on(
    "owned-options",
    (payload: {
      roomId: string;
      memberId: string;
      championId: number;
      championAlias: string;
      options: GroupSkinOption[];
    }) => {
      const { roomId, memberId, championId, championAlias, options } = payload;

      const room = rooms.get(roomId);
      if (!room) return;

      const member = room.members.get(memberId);
      if (!member) return;

      member.championId = championId;
      member.championAlias = championAlias ?? "";
      member.options = Array.isArray(options) ? options : [];
      member.isReady = true;

      // [SECURITY] Fix DoS: Limit max options size
      if (member.options && member.options.length > 2000) {
        console.warn(`[Security] Member ${memberId} sent too many options (${member.options.length}). Truncating.`);
        member.options = member.options.slice(0, 2000);
      }

      console.log(
        `[owned-options] member=${memberId} room=${roomId} options=${member.options?.length}`
      );

      // On recalcule la synergie simple basée sur la couleur de chroma
      try {
        recomputeSynergy(room);
      } catch (err) {
        console.error(`[Synergy] Error recomputing synergy for room ${roomId}:`, err);
      }

      // On renvoie le nouvel état de room (avec synergy) à tout le monde
      io.to(room.id).emit("room-state", serializeRoom(room));
    }
  );

  socket.on(
    "leave-room",
    ({ roomId, memberId }: { roomId: string; memberId: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      if (!room.members.has(memberId)) return;

      console.log(
        `[socket] ${socket.id} explicit leave room ${roomId} (member ${memberId})`
      );

      handleMemberLeave(room, memberId, "leave");

      socketToMember.delete(socket.id);
      socket.leave(roomId);
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

    console.log(
      `[socket] ${socket.id} disconnected from room ${roomId} (member ${memberId})`
    );

    handleMemberLeave(room, memberId, "disconnect");
  });

  socket.on(
    "request-group-reroll",
    (payload: {
      roomId: string;
      memberId: string;
      type: "sameColor";
      color: string;
    }) => {
      const { roomId, memberId, type, color } = payload;
      const room = rooms.get(roomId);
      if (!room) return;

      // sécurité : seul le owner peut déclencher
      if (room.ownerId !== memberId) {
        console.warn(
          `[group-reroll] non-owner tried to reroll: member=${memberId} room=${roomId}`
        );
        return;
      }

      const synergy = room.synergy;
      if (!synergy) return;

      const entry = synergy.colors.find(
        (c) => c.type === type && c.color === color && c.combinationCount > 0
      );
      if (!entry) {
        console.warn(
          `[group-reroll] no synergy entry for color=${color} in room=${roomId}`
        );
        return;
      }

      const picks: {
        memberId: string;
        skinId: number;
        chromaId: number;
      }[] = [];

      // On itère sur les membres PRÉSENTS et PRÊTS
      for (const m of room.members.values()) {
        if (!m.isReady) continue; // On ne change pas le skin de ceux qui ne sont pas prêts

        const opts = (m.options ?? []).filter((o) => o.auraColor === color);

        if (!opts.length) {
          // "mouton noir" : on garde ce qu'il a déjà
          picks.push({
            memberId: m.id,
            skinId: m.skinId,
            chromaId: m.chromaId,
          });
          continue;
        }

        const idx = randomInt(0, opts.length);
        const opt = opts[idx];

        // on met à jour l'état serveur
        m.skinId = opt.skinId;
        m.chromaId = opt.chromaId;

        picks.push({
          memberId: m.id,
          skinId: opt.skinId,
          chromaId: opt.chromaId,
        });
      }

      console.log(
        `[group-reroll] applying combo color=${color} in room=${roomId}, picks=${picks.length}`
      );

      // Mettre à jour l'état interne du serveur IMMEDIATEMENT
      for (const pick of picks) {
        const member = room.members.get(pick.memberId);
        if (member) {
          member.skinId = pick.skinId;
          member.chromaId = pick.chromaId;
        }
      }

      // Sauvegarder la synergie active pour les late joiners
      room.activeSynergy = {
        type,
        color,
        timestamp: Date.now(),
      };

      if (type === "sameColor") {
        room.activeColor = color;
      }

      // 1) notifier tout le monde de la combinaison à appliquer
      io.to(roomId).emit("group-apply-combo", {
        type,
        color,
        picks,
      });

      // 2) renvoyer l'état de la room mis à jour
      io.to(roomId).emit("room-state", serializeRoom(room));
    }
  );
});

/* --------- Lancement --------- */

const PORT = Number(process.env.PORT) || 4000;

app.get("/", (req, res) => {
  res.send("Skin Picker Rooms server is running");
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Rooms server listening on port ${PORT}`);
});
