import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { logger } from "./utils/logger";
import { createSafeHandler, assertMemberAuth } from "./utils/socketHelpers";
import {
  validateJoinRoomPayload,
  validateLeaveRoomPayload,
  validateUpdateSelectionPayload,
  validateOwnedOptionsPayload,
  validateRequestGroupRerollPayload,
  validateApplySkinLineSynergyPayload,
  validateSetSkinLockPayload,
  validateKickMemberPayload,
} from "./utils/validation";
import { createSocketRateLimiter } from "./utils/socketRateLimiter";
import { AppError, ErrorCodes } from "./utils/errors";
import { redactPuuid } from "./utils/redact";
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
import { RoomService, ROOM_SWEEP_INTERVAL_MS } from "./services/room.service";
import { presenceManager } from "./services/presence.service";
import type {
  JoinRoomPayload,
  LeaveRoomPayload,
  UpdateSelectionPayload,
  OwnedOptionsPayload,
  RequestGroupRerollPayload,
  SuggestColorPayload,
  ApplySkinLineSynergyPayload,
  SetSkinLockPayload,
  KickMemberPayload,
  IdentifyPayload,
  SendRoomInvitePayload,
} from "./types";

const app = express();
const roomService = RoomService.getInstance();

// --- Configuration & Middleware ---
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);
if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push("http://localhost:5173", "http://127.0.0.1:5173");
}

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Requests with no Origin header (Electron file://, curl, server-to-server) are allowed.
    if (!origin) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    logger.warn(`[cors] Rejected origin: ${origin}`);
    return callback(new Error("Origin not allowed by CORS"));
  },
  credentials: false,
};

app.use(helmet());
app.use(cors(corsOptions));
// 16 ko : tous les bodys legitimes (create/join/bots) tiennent en quelques
// centaines d'octets. La limite par defaut d'express.json() est de 100 ko, ce
// qui laissait passer des champs `name` de plusieurs dizaines de milliers de
// caracteres.
app.use(express.json({ limit: "16kb" }));

// Rate limiting — disabled in tests to avoid flakiness when running many requests in sequence.
const RATE_LIMIT_DISABLED = process.env.NODE_ENV === "test" || process.env.DISABLE_RATE_LIMIT === "true";

// Derrière Cloudflare Tunnel, l'IP TCP vue par Express est celle du connecteur
// cloudflared : l'IP réelle du client arrive dans l'en-tête CF-Connecting-IP.
// On indexe les limiteurs dessus (repli sur req.ip en accès direct/dev).
// L'origine n'étant joignable QUE via le tunnel, l'en-tête n'est pas falsifiable.
const clientIpKey = (req: express.Request): string => {
  const cfIp = req.headers["cf-connecting-ip"];
  const ip = (typeof cfIp === "string" && cfIp.length > 0 ? cfIp : req.ip) ?? "";
  return ipKeyGenerator(ip);
};

// Global baseline applied to every route, keyed by client IP.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  skip: () => RATE_LIMIT_DISABLED,
});
app.use(limiter);

// Stricter per-IP limit on room creation to prevent spam.
const createRoomLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many rooms created, try again later" },
  keyGenerator: clientIpKey,
  skip: () => RATE_LIMIT_DISABLED,
});

// Stricter per-IP limit on room join to prevent brute-forcing room codes.
const joinRoomLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: clientIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many join attempts, try again later" },
  skip: () => RATE_LIMIT_DISABLED,
});

// --- Routes ---
app.use("/rooms", (req, res, next) => {
  if (req.method === "POST" && req.path === "/") return createRoomLimiter(req, res, next);
  if (req.method === "POST" && req.path === "/bot") return createRoomLimiter(req, res, next);
  if (req.method === "POST" && req.path === "/join") return joinRoomLimiter(req, res, next);
  return next();
}, roomRoutes);

app.get("/", (req, res) => {
  res.send("Skin Picker Rooms server is running");
});

// --- Server Setup ---
export const httpServer = http.createServer(app);
export const io = new SocketIOServer(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      logger.warn(`[socket.io/cors] Rejected origin: ${origin}`);
      return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: false,
  },
});

// --- Socket.io Logic ---

// Validate a Riot-style PUUID. Real encrypted PUUIDs are 78 URL-safe base64
// characters, but simulator fixtures and legacy test traffic can be shorter,
// so we accept a bounded range with a strict character class. The old check
// (`length < 10`) let "abcdefghij" through.
const PUUID_REGEX = /^[A-Za-z0-9_-]{16,128}$/;
function isValidPuuid(value: unknown): value is string {
  return typeof value === "string" && PUUID_REGEX.test(value);
}

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

/**
 * Retire du canal Socket.IO TOUS les sockets rattaches a un membre.
 *
 * `leave-room` ne faisait quitter que le socket emetteur. Un membre ayant
 * plusieurs sockets (reconnexion sans `disconnect` propre) laissait donc
 * derriere lui un auditeur silencieux, qui continuait a recevoir chaque
 * `room-state` sans figurer dans la liste des membres — donc sans etre
 * expulsable.
 */
function evictMemberSockets(roomId: string, memberId: string): void {
  void (async () => {
    try {
      const sockets = await io.in(roomId).fetchSockets();
      for (const s of sockets) {
        const info = socketToMember.get(s.id);
        if (info?.memberId !== memberId) continue;
        socketToMember.delete(s.id);
        s.leave(roomId);
      }
    } catch (err) {
      logger.error(`[leave] Failed to evict sockets of member ${memberId}`, {
        error: err instanceof Error ? err.message : String(err),
        roomId,
      });
    }
  })();
}

/**
 * Chute de socket d'un membre connecte : on ouvre le sursis de reconnexion au
 * lieu de le retirer.
 *
 * Rien n'est diffuse aux autres membres : pour eux, la room ne change pas. Si
 * le membre revient dans le sursis, personne n'aura rien vu ; s'il ne revient
 * pas, `sweep` le retire et diffusera l'etat a ce moment-la.
 *
 * Le socket a deja ete retire de `socketToMember` par l'appelant, donc plus
 * aucun evenement ne peut arriver en son nom.
 */
function handleMemberDisconnect(roomId: string, memberId: string) {
  const room = roomService.getRoom(roomId);
  if (!room) return;

  if (!roomService.markMemberDisconnected(room, memberId)) return;

  logger.debug(
    `[socket] Membre ${memberId} de la room ${room.code} en sursis de reconnexion`
  );
}

function handleMemberLeave(roomId: string, memberId: string, reason: string) {
  const room = roomService.getRoom(roomId);
  if (!room) return;

  const result = roomService.removeMember(room, memberId);
  evictMemberSockets(roomId, memberId);

  if (result.roomClosed) {
    // Last member out — notify everyone (owner-left only fires when there's
    // no one left to inherit) and disconnect any stragglers in the room.
    io.to(roomId).emit("room-closed", { reason: result.reason });
    io.in(roomId).disconnectSockets(true);
    return;
  }

  // Still active — broadcast the new state. The room-state payload carries
  // the (possibly new) ownerId, so clients pick up the transfer naturally.
  const serializedRoom = roomService.serializeRoom(room);
  emitVersionedToRoom(io, roomId, "room-state", (version) =>
    createRoomStatePayload(serializedRoom, version)
  );
}

io.on("connection", (socket) => {
  // Register client version from handshake query
  const rawVersion = socket.handshake.query.clientVersion;
  const clientVersion = registerClientVersion(
    socket.id,
    typeof rawVersion === "string" ? parseInt(rawVersion, 10) || 1 : 1
  );
  logger.info(`[socket] connected ${socket.id} (v${clientVersion})`);

  // Un limiteur par socket : son etat vit dans la closure de la connexion et
  // disparait donc avec elle, sans map globale a purger.
  const rateLimiter = createSocketRateLimiter(socket.id);
  const safeHandler = createSafeHandler(socket, rateLimiter);

  socket.on("join-room", safeHandler<JoinRoomPayload>("join-room", ({ roomId, memberId, memberToken }) => {
    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }

    const member = room.members.get(memberId);
    if (!member) {
      throw new AppError(ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
    }

    assertMemberAuth(member, memberToken, "join-room");

    logger.debug(`[socket] ${socket.id} join room ${roomId} as member ${memberId}`);

    socket.join(roomId);
    socketToMember.set(socket.id, { roomId, memberId });
    // Le membre n'est plus "en sursis" : son slot ne sera plus recupere par le
    // balayage.
    roomService.markMemberConnected(room, memberId);

    // Emit versioned room-state
    const serializedRoom = roomService.serializeRoom(room);
    emitVersionedToRoom(io, roomId, "room-state", (version) =>
      createRoomStatePayload(serializedRoom, version)
    );
  }, validateJoinRoomPayload));

  socket.on("update-selection", safeHandler<UpdateSelectionPayload>("update-selection", (payload) => {
    const { roomId, memberId, memberToken, championId, championAlias, skinId, chromaId } = payload;

    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }

    const member = room.members.get(memberId);
    if (!member) {
      throw new AppError(ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
    }

    assertMemberAuth(member, memberToken, "update-selection");

    // When the member switches champion, their previously-uploaded skin/chroma
    // options belong to the old champion and must not participate in synergy
    // calculations until the client resends owned-options for the new champion.
    if (member.championId !== championId) {
      member.options = [];
      member.isReady = false;
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
  }, validateUpdateSelectionPayload));

  socket.on("owned-options", safeHandler<OwnedOptionsPayload>("owned-options", (payload) => {
    const { roomId, memberId, memberToken, championId, championAlias, options } = payload;

    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }

    const member = room.members.get(memberId);
    if (!member) {
      throw new AppError(ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
    }

    assertMemberAuth(member, memberToken, "owned-options");

    // `options` est deja valide element par element par
    // validateOwnedOptionsPayload (type, bornes, et cap a MAX_OPTIONS) : ce qui
    // arrive ici ne peut plus faire lever recomputeSynergy.
    member.championId = championId;
    member.championAlias = championAlias ?? "";
    member.options = options;
    member.isReady = true;

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
  }, validateOwnedOptionsPayload));

  socket.on("leave-room", safeHandler<LeaveRoomPayload>("leave-room", ({ roomId, memberId, memberToken }) => {
    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }
    const member = room.members.get(memberId);
    if (!member) {
      throw new AppError(ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
    }
    assertMemberAuth(member, memberToken, "leave-room");

    logger.debug(`[leave-room] ${socket.id} explicit leave room ${roomId}`);

    handleMemberLeave(roomId, memberId, "leave");

    socketToMember.delete(socket.id);
    socket.leave(roomId);
  }, validateLeaveRoomPayload));

  // `disconnect` ne peut pas passer par safeHandler (aucun payload, et il est
  // emis par Socket.IO lui-meme), mais il DOIT etre protege : il appelle
  // handleMemberLeave -> removeMember -> recomputeSynergy. Une exception qui
  // s'en echappe remonte a l'event loop et, sans handler uncaughtException,
  // tue le process — emportant l'integralite de l'etat en memoire.
  //
  // Le nettoyage presence est isole du nettoyage room dans un second try :
  // l'echec de l'un ne doit pas laisser l'autre a moitie fait (fuite d'entree
  // dans presenceManager).
  socket.on("disconnect", () => {
    const info = socketToMember.get(socket.id);
    socketToMember.delete(socket.id);
    removeClientVersion(socket.id);

    try {
      if (info) {
        logger.debug(`[socket] ${socket.id} disconnected (room ${info.roomId})`);
        // Une chute de socket n'est PAS un depart : elle ouvre un sursis de
        // reconnexion. Seul `leave-room` (action deliberee) retire tout de
        // suite. Voir DISCONNECT_GRACE_MS dans room.service.
        handleMemberDisconnect(info.roomId, info.memberId);
      }
    } catch (err) {
      logger.error(`[disconnect] Room cleanup failed for socket ${socket.id}`, {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        roomId: info?.roomId,
      });
    }

    // Handle presence cleanup and friend notifications (Story 4.3)
    try {
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
        logger.info(`[identify] ${summonerName} (${redactPuuid(puuid)}) disconnected`);
      }
    } catch (err) {
      logger.error(`[disconnect] Presence cleanup failed for socket ${socket.id}`, {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      // Filet de securite : purger quand meme l'entree, sinon le PUUID reste
      // "en ligne" pour toujours et son proprietaire ne peut plus s'identifier.
      try {
        presenceManager.disconnect(socket.id);
      } catch {
        /* rien de plus a tenter */
      }
    }
  });

  socket.on("request-group-reroll", safeHandler<RequestGroupRerollPayload>("request-group-reroll", (payload) => {
    const { roomId, memberId, memberToken, type, color, skinLineId, sourceMemberId } = payload;

    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }

    const member = room.members.get(memberId);
    if (!member) {
      throw new AppError(ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
    }
    assertMemberAuth(member, memberToken, "request-group-reroll");

    if (room.ownerId !== memberId) {
      throw new AppError(ErrorCodes.UNAUTHORIZED, `Only owner can trigger group reroll`, true, {
        roomId,
        memberId,
        ownerId: room.ownerId,
      });
    }

    const result = roomService.applyColorSynergy(room, color, skinLineId);
    if (!result) {
      logger.warn(
        `[request-group-reroll] No synergy entry for color=${color} in room=${roomId}`
      );
      return;
    }

    emitVersionedToRoom(io, roomId, "group-apply-combo", (version) =>
      createGroupApplyComboPayload(
        { type, color, picks: result.picks, sourceMemberId, autoApplied: false },
        version
      )
    );

    const serializedRoom = roomService.serializeRoom(room);
    emitVersionedToRoom(io, roomId, "room-state", (version) =>
      createRoomStatePayload(serializedRoom, version)
    );
  }, validateRequestGroupRerollPayload));

  socket.on("suggest-color", (payload: SuggestColorPayload, ack?: (response: { success: boolean; error?: string }) => void) => {
    try {
      // Ce handler n'utilise pas safeHandler (semantique d'ack specifique) :
      // le rate limit doit donc etre applique explicitement.
      if (!rateLimiter.allow("suggest-color")) {
        if (ack) ack({ success: false, error: 'Too many requests' });
        return;
      }

      if (!payload || typeof payload !== "object") {
        logger.warn(`[suggest-color] Rejected: payload is not an object`);
        if (ack) ack({ success: false, error: 'Invalid payload' });
        return;
      }

      const { roomId, memberId, memberToken, skinId, chromaId } = payload;

      if (typeof roomId !== "string" || roomId.length === 0 || roomId.length > 128) {
        logger.warn(`[suggest-color] Rejected: invalid roomId`);
        if (ack) ack({ success: false, error: 'Invalid roomId' });
        return;
      }
      if (typeof memberId !== "string" || memberId.length === 0 || memberId.length > 128) {
        logger.warn(`[suggest-color] Rejected: invalid memberId`);
        if (ack) ack({ success: false, error: 'Invalid memberId' });
        return;
      }
      if (
        typeof skinId !== "number" ||
        !Number.isInteger(skinId) ||
        skinId < 0 ||
        skinId > 1_000_000_000
      ) {
        logger.warn(`[suggest-color] Rejected: invalid skinId (${String(skinId)})`);
        if (ack) ack({ success: false, error: 'Invalid skinId' });
        return;
      }
      if (
        typeof chromaId !== "number" ||
        !Number.isInteger(chromaId) ||
        chromaId < 0 ||
        chromaId > 1_000_000_000
      ) {
        logger.warn(`[suggest-color] Rejected: invalid chromaId (${String(chromaId)})`);
        if (ack) ack({ success: false, error: 'Invalid chromaId' });
        return;
      }

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

      try {
        assertMemberAuth(sender, memberToken, "suggest-color");
      } catch {
        if (ack) ack({ success: false, error: 'Unauthorized' });
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
    const { roomId, memberId, memberToken, skinLineId } = payload;

    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }

    const member = room.members.get(memberId);
    if (!member) {
      throw new AppError(ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
    }
    assertMemberAuth(member, memberToken, "apply-skin-line-synergy");

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
  }, validateApplySkinLineSynergyPayload));

  // --- Kick Member (owner only) ---
  socket.on("kick-member", safeHandler<KickMemberPayload>("kick-member", (payload) => {
    const { roomId, memberId, memberToken, targetMemberId } = payload;

    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }

    const member = room.members.get(memberId);
    if (!member) {
      throw new AppError(ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
    }

    assertMemberAuth(member, memberToken, "kick-member");

    if (room.ownerId !== memberId) {
      throw new AppError(ErrorCodes.UNAUTHORIZED, `Only owner can kick members`, true, {
        roomId,
        memberId,
        ownerId: room.ownerId,
      });
    }

    // `targetMemberId` est deja garanti non vide et borne par
    // validateKickMemberPayload.
    const target = room.members.get(targetMemberId);
    const result = roomService.kickMember(room, targetMemberId);
    if (!result.ok) {
      if (result.reason === "self") {
        throw new AppError(ErrorCodes.UNAUTHORIZED, `Owner cannot kick themselves; use leave-room`, true, { targetMemberId });
      }
      throw new AppError(ErrorCodes.MEMBER_NOT_FOUND, `Target member not found`, true, { targetMemberId });
    }

    logger.info(`[kick-member] Room ${room.code}: ${member.name} kicked ${target?.name ?? targetMemberId}`);

    // Notify the kicked member's socket(s) and disconnect them, then push the
    // updated room-state to whoever's left. We do this by walking the room's
    // current sockets — the kicked member may have multiple if they reconnected.
    (async () => {
      try {
        const sockets = await io.in(roomId).fetchSockets();
        for (const s of sockets) {
          const info = socketToMember.get(s.id);
          if (info && info.memberId === targetMemberId) {
            s.emit("room-closed", { reason: "kicked" });
            socketToMember.delete(s.id);
            s.disconnect(true);
          }
        }
      } catch (err) {
        logger.error("[kick-member] Failed to disconnect kicked sockets", err);
      }
    })();

    const serializedRoom = roomService.serializeRoom(room);
    emitVersionedToRoom(io, roomId, "room-state", (version) =>
      createRoomStatePayload(serializedRoom, version)
    );
  }, validateKickMemberPayload));

  // --- Per-match Skin Lock ---
  socket.on("set-skin-lock", safeHandler<SetSkinLockPayload>("set-skin-lock", (payload) => {
    const { roomId, memberId, memberToken, locked } = payload;

    const room = roomService.getRoom(roomId);
    if (!room) {
      throw new AppError(ErrorCodes.ROOM_NOT_FOUND, `Room ${roomId} not found`, true, { roomId });
    }

    const member = room.members.get(memberId);
    if (!member) {
      throw new AppError(ErrorCodes.MEMBER_NOT_FOUND, `Member ${memberId} not found`, true, { roomId, memberId });
    }

    assertMemberAuth(member, memberToken, "set-skin-lock");

    const changed = roomService.setMemberSkinLock(room, memberId, !!locked);
    if (!changed) return; // no-op, don't spam clients with identical state

    logger.debug(`[set-skin-lock] Room ${room.code}: ${member.name} → ${locked ? "locked" : "unlocked"}`);

    const serializedRoom = roomService.serializeRoom(room);
    emitVersionedToRoom(io, roomId, "room-state", (version) =>
      createRoomStatePayload(serializedRoom, version)
    );
  }, validateSetSkinLockPayload));

  // --- Identity Handshake (Story 4.3) ---
  socket.on("identify", (payload: IdentifyPayload) => {
    try {
      // Handler hors safeHandler : rate limit explicite. `identify` reconstruit
      // la presence et notifie tous les amis — c'est le levier d'amplification
      // le plus fort du protocole, et le vecteur du squattage de PUUID.
      if (!rateLimiter.allow("identify")) {
        socket.emit("identity-rejected", { reason: "rate_limited" });
        return;
      }

      const { puuid, summonerName, friends } = payload;

      // Validate payload
      if (!isValidPuuid(puuid)) {
        logger.warn("[identify] Invalid puuid received", { puuid });
        return;
      }
      if (
        typeof summonerName !== "string" ||
        summonerName.length === 0 ||
        summonerName.length > 128
      ) {
        logger.warn("[identify] Invalid summonerName received", { summonerName });
        return;
      }
      if (!Array.isArray(friends) || friends.length > 1000) {
        logger.warn("[identify] Invalid friends array received");
        return;
      }
      // Drop malformed entries rather than trusting every string in the array.
      const validFriends = friends.filter(isValidPuuid);

      // 1. Register presence (fails if PUUID already claimed by another socket)
      const result = presenceManager.identify(socket, puuid, summonerName);
      if (!result.ok) {
        socket.emit("identity-rejected", { reason: result.reason });
        return;
      }

      // 2. Store friends list
      presenceManager.setFriends(puuid, validFriends);

      // 3. Find online friends
      const onlineFriends = presenceManager.getOnlineFriends(validFriends);

      // 4. Confirm to client
      socket.emit("identity-confirmed", { onlineFriends });

      // 5. Notify friends that this user is online
      for (const friendPuuid of validFriends) {
        if (presenceManager.isOnline(friendPuuid)) {
          io.to(`user:${friendPuuid}`).emit("friend-online", { puuid, summonerName });
        }
      }

      logger.info(`[identify] ${summonerName} (${redactPuuid(puuid)}) identified with ${validFriends.length} friends, ${onlineFriends.length} online`);
    } catch (err) {
      logger.error("[identify] Error processing identify", err);
    }
  });

  // --- Room Invitations (Story 4.5) ---
  socket.on("send-room-invite", (payload: SendRoomInvitePayload) => {
    try {
      // Handler hors safeHandler : rate limit explicite. Le limiteur par couple
      // (expediteur, cible) plus bas n'empeche pas d'arroser des milliers de
      // cibles differentes — celui-ci borne le debit total du socket.
      if (!rateLimiter.allow("send-room-invite")) {
        socket.emit("invite-failed", { reason: "rate_limited" });
        return;
      }

      const { targetPuuid, roomCode } = payload;

      if (!isValidPuuid(targetPuuid)) {
        logger.warn("[invite] Invalid targetPuuid received", { targetPuuid });
        socket.emit("invite-failed", { reason: "invalid_payload" });
        return;
      }
      if (
        typeof roomCode !== "string" ||
        roomCode.length === 0 ||
        roomCode.length > 32
      ) {
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
      const senderFriends = presenceManager.getFriends(senderPuuid);
      if (!senderFriends || !senderFriends.includes(targetPuuid)) {
        socket.emit("invite-failed", { reason: "not_friend" });
        logger.warn(`[invite] ${senderPuuid} tried to invite non-friend ${targetPuuid}`);
        return;
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

// --- Balayage periodique des rooms ---
// Libere les slots des membres jamais connectes et supprime les rooms
// abandonnees. `unref()` pour ne pas maintenir le process en vie, et pas de
// timer du tout en test (les suites declenchent `roomService.sweep()`
// directement, ce qui est deterministe).
if (process.env.NODE_ENV !== "test") {
  const sweepTimer = setInterval(() => {
    try {
      const { membersEvicted, roomsClosed, changedRoomIds, closedRoomIds } =
        roomService.sweep();

      // Le balayage modifie l'etat sans qu'aucun client n'ait agi : c'est donc
      // ici, et nulle part ailleurs, que les autres membres apprennent qu'un
      // coequipier n'est pas revenu de sa coupure reseau.
      for (const roomId of changedRoomIds) {
        const room = roomService.getRoom(roomId);
        if (!room) continue;
        const serializedRoom = roomService.serializeRoom(room);
        emitVersionedToRoom(io, roomId, "room-state", (version) =>
          createRoomStatePayload(serializedRoom, version)
        );
      }
      for (const roomId of closedRoomIds) {
        io.to(roomId).emit("room-closed", { reason: "inactive" });
        io.in(roomId).disconnectSockets(true);
      }

      if (membersEvicted > 0 || roomsClosed > 0) {
        logger.info(
          `[sweep] ${membersEvicted} membre(s) evince(s), ${roomsClosed} room(s) fermee(s) — ${roomService.rooms.size} restantes`
        );
      }
    } catch (err) {
      logger.error("[sweep] Balayage en echec", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }, ROOM_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

// --- Filet de securite process ---
// L'etat des rooms est 100% en memoire : un crash du process detruit les rooms
// de TOUS les utilisateurs connectes. Une exception isolee echappee d'un
// callback (timer, I/O, listener Socket.IO) ne doit donc jamais suffire a tuer
// le serveur. On logge et on continue.
//
// Volontairement PAS de process.exit() : un redemarrage laisserait les clients
// avec des rooms fantomes, et PM2 (ecosystem.config.js) n'a ni healthcheck ni
// max_memory_restart pour arbitrer. Si l'etat devient reellement incoherent,
// c'est la supervision qui doit trancher, pas un handler generique.
// Ces handlers ne sont pas installes en test : Jest doit voir les erreurs.
if (process.env.NODE_ENV !== "test") {
  process.on("uncaughtException", (err) => {
    logger.error("[fatal] uncaughtException — le process continue", {
      error: err?.message,
      stack: err?.stack,
    });
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("[fatal] unhandledRejection — le process continue", {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

// --- Arret propre ---
// L'etat etant entierement en memoire, un `docker compose up -d --build` ou un
// `pm2 restart` detruit toutes les rooms en cours. Sans ce handler, les clients
// ne recevaient RIEN : leur socket tombait, ils tentaient de se reconnecter, et
// se retrouvaient face a un MEMBER_NOT_FOUND une fois le serveur revenu — un
// etat que le front n'a aucun moyen de distinguer d'un bug.
//
// On leur dit donc explicitement pourquoi, avant de fermer. `server-restart` est
// une raison distincte : le client peut la traiter comme temporaire et proposer
// de recreer la room, la ou `owner-left` est definitif.
function shutdown(signal: string): void {
  logger.info(`[shutdown] ${signal} recu — fermeture des rooms en cours`);
  try {
    io.emit("room-closed", { reason: "server-restart" });
  } catch (err) {
    logger.error("[shutdown] Diffusion room-closed en echec", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Laisse le temps au message de partir avant de couper les sockets : sans ce
  // delai, io.close() ferme les connexions avant que l'emit soit ecrit sur le
  // reseau, et le message est perdu — ce qui annule tout l'interet du handler.
  setTimeout(() => {
    io.close(() => {
      httpServer.close(() => {
        logger.info("[shutdown] Termine");
        process.exit(0);
      });
    });
  }, 300).unref();

  // Garde-fou : si une socket refuse de se fermer, on sort quand meme avant que
  // l'orchestrateur n'envoie un SIGKILL.
  setTimeout(() => {
    logger.warn("[shutdown] Delai depasse — sortie forcee");
    process.exit(0);
  }, 5000).unref();
}

// --- Start ---
// Only start the server if this module is run directly (not imported for tests)
if (process.env.NODE_ENV !== "test") {
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const PORT = Number(process.env.PORT) || 4000;
  httpServer.listen(PORT, "0.0.0.0", () => {
    logger.info(`Rooms server listening on port ${PORT}`);
  });
}
