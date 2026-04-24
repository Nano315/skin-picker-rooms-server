import { io, Socket } from "socket.io-client";
import { GroupSkinOption } from "./types";
import { buildOwnedOptions } from "./options-builder";
import { fetchChampionAlias } from "./cdragon.service";

const SERVER_URL = "http://localhost:4000";
const CONNECT_TIMEOUT = 5000;

// ANSI color codes for terminal output
const COLORS = [
  "\x1b[36m", // cyan
  "\x1b[33m", // yellow
  "\x1b[35m", // magenta
  "\x1b[32m", // green
];
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

let colorIndex = 0;

export type LogFunction = (message: string) => void;

export class FakeClient {
  puuid: string;
  summonerName: string;
  roomSocket: Socket | null = null;
  identitySocket: Socket | null = null;
  memberId: string = "";
  memberToken: string = "";
  roomId: string = "";
  roomCode: string = "";
  championId: number = 0;
  championAlias: string = "";
  options: GroupSkinOption[] = [];
  role: "owner" | "guest";
  friendPuuids: string[];
  connected = false;

  private color: string;
  private log: LogFunction;

  constructor(
    puuid: string,
    summonerName: string,
    role: "owner" | "guest",
    friendPuuids: string[] = [],
    logFn?: LogFunction
  ) {
    this.puuid = puuid;
    this.summonerName = summonerName;
    this.role = role;
    this.friendPuuids = friendPuuids;
    this.color = COLORS[colorIndex++ % COLORS.length];
    this.log = logFn ?? ((msg: string) => console.log(msg));
  }

  private prefix(): string {
    return `${this.color}[${this.summonerName}]${RESET}`;
  }

  private requireRoomSocket(): Socket {
    if (!this.roomSocket?.connected) {
      throw new Error("Room socket non connecté");
    }
    return this.roomSocket;
  }

  // --- Connection Methods ---

  async connectIdentity(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            "Impossible de se connecter au serveur sur localhost:4000 — est-il lancé ?"
          )
        );
      }, CONNECT_TIMEOUT);

      this.identitySocket = io(SERVER_URL, {
        forceNew: true,
        autoConnect: true,
        query: { clientVersion: "2" },
      });

      this.identitySocket.on("connect", () => {
        clearTimeout(timeout);
        this.log(`${this.prefix()} Identity socket connecté`);

        this.identitySocket!.emit("identify", {
          puuid: this.puuid,
          summonerName: this.summonerName,
          friends: this.friendPuuids,
        });
      });

      this.identitySocket.on("identity-confirmed", (payload: { onlineFriends: string[] }) => {
        this.log(
          `${this.prefix()} Identité confirmée (${payload.onlineFriends.length} ami(s) en ligne)`
        );
        // Join personal room for invitations
        this.identitySocket!.emit("join-personal-room");
        this.connected = true;
        resolve();
      });

      this.identitySocket.on("connect_error", (err: Error) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Impossible de se connecter au serveur sur localhost:4000 — est-il lancé ? (${err.message})`
          )
        );
      });

      // Listen for invitation events on identity socket
      this.identitySocket.on(
        "room-invite-received",
        (payload: { fromPuuid: string; fromName: string; roomCode: string }) => {
          this.log(
            `${this.prefix()} Invitation reçue de ${payload.fromName} pour la room ${payload.roomCode}`
          );
        }
      );

      this.identitySocket.on("invite-sent", (payload: { targetPuuid: string }) => {
        this.log(`${this.prefix()} Invitation envoyée à ${payload.targetPuuid}`);
      });

      this.identitySocket.on("invite-failed", (payload: { reason: string }) => {
        this.log(`${this.prefix()} ${DIM}Invitation échouée: ${payload.reason}${RESET}`);
      });
    });
  }

  async connectRoom(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            "Impossible de se connecter au serveur sur localhost:4000 — est-il lancé ?"
          )
        );
      }, CONNECT_TIMEOUT);

      this.roomSocket = io(SERVER_URL, {
        forceNew: true,
        autoConnect: true,
        query: { clientVersion: "2" },
      });

      this.roomSocket.on("connect", () => {
        clearTimeout(timeout);
        this.log(`${this.prefix()} Room socket connecté`);
        resolve();
      });

      this.roomSocket.on("connect_error", (err: Error) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Impossible de se connecter au serveur sur localhost:4000 — est-il lancé ? (${err.message})`
          )
        );
      });

      // Room event listeners
      this.roomSocket.on("room-state", (room: Record<string, unknown>) => {
        const members = room.members as Array<{ id: string; name: string; championAlias: string }> | undefined;
        const memberNames = members?.map((m) => `${m.name}(${m.championAlias || "?"})`).join(", ") ?? "?";
        this.log(
          `${this.prefix()} ${DIM}room-state: ${(members?.length ?? 0)} membre(s) [${memberNames}]${RESET}`
        );
      });

      this.roomSocket.on("room-closed", (payload: { reason?: string }) => {
        this.log(`${this.prefix()} Room fermée: ${payload.reason ?? "inconnue"}`);
      });

      this.roomSocket.on(
        "group-apply-combo",
        (payload: {
          type: string;
          color?: string;
          skinLineName?: string;
          picks: Array<{ memberId: string; skinId: number; chromaId: number }>;
          autoApplied?: boolean;
        }) => {
          const desc =
            payload.type === "skinLine"
              ? `skin line "${payload.skinLineName}"`
              : `couleur ${payload.color}`;
          const auto = payload.autoApplied ? " (auto)" : "";
          this.log(
            `${this.prefix()} ${this.color}group-apply-combo: ${desc}${auto} — ${payload.picks.length} picks${RESET}`
          );
        }
      );

      this.roomSocket.on("error", (err: { code: string; message: string }) => {
        this.log(`${this.prefix()} ${DIM}Erreur serveur: [${err.code}] ${err.message}${RESET}`);
      });

      this.roomSocket.on(
        "color-suggestion-received",
        (payload: { memberId: string; senderName: string; skinId: number; chromaId: number }) => {
          this.log(
            `${this.prefix()} Suggestion de couleur reçue de ${payload.senderName}`
          );
        }
      );
    });
  }

  // --- Owner Methods ---

  async createRoom(): Promise<void> {
    const response = await fetch(`${SERVER_URL}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: this.summonerName }),
    });

    if (!response.ok) {
      throw new Error(`Échec création room: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      roomId: string;
      code: string;
      memberId: string;
      memberToken: string;
    };

    this.roomId = data.roomId;
    this.roomCode = data.code;
    this.memberId = data.memberId;
    this.memberToken = data.memberToken;

    this.log(`${this.prefix()} Room créée — code: ${this.color}${this.roomCode}${RESET}`);

    // Join via socket
    this.requireRoomSocket().emit("join-room", {
      roomId: this.roomId,
      memberId: this.memberId,
      memberToken: this.memberToken,
    });
  }

  invitePlayer(targetPuuid: string): void {
    if (!this.identitySocket) {
      this.log(`${this.prefix()} Erreur: identity socket non connecté`);
      return;
    }

    this.identitySocket.emit("send-room-invite", {
      targetPuuid,
      roomCode: this.roomCode,
    });
  }

  applySkinLineSynergy(skinLineId: number): void {
    if (!this.roomSocket) return;

    this.roomSocket.emit("apply-skin-line-synergy", {
      roomId: this.roomId,
      memberId: this.memberId,
      memberToken: this.memberToken,
      skinLineId,
    });
  }

  requestGroupReroll(
    type: "sameColor" | "skinLine",
    color?: string,
    skinLineId?: number
  ): void {
    if (!this.roomSocket) return;

    this.roomSocket.emit("request-group-reroll", {
      roomId: this.roomId,
      memberId: this.memberId,
      memberToken: this.memberToken,
      type,
      color,
      skinLineId,
    });
  }

  // --- Guest Methods ---

  async joinRoom(code: string): Promise<void> {
    const response = await fetch(`${SERVER_URL}/rooms/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: this.summonerName }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        `Échec join room: HTTP ${response.status} — ${body.error ?? "unknown"}`
      );
    }

    const data = (await response.json()) as {
      roomId: string;
      code: string;
      memberId: string;
      memberToken: string;
    };

    this.roomId = data.roomId;
    this.roomCode = data.code;
    this.memberId = data.memberId;
    this.memberToken = data.memberToken;

    this.log(`${this.prefix()} Room rejointe — code: ${this.roomCode}`);

    // Join via socket
    this.requireRoomSocket().emit("join-room", {
      roomId: this.roomId,
      memberId: this.memberId,
      memberToken: this.memberToken,
    });
  }

  // --- Common Methods ---

  async selectChampion(
    championId: number,
    onProgress?: (current: number, total: number) => void
  ): Promise<void> {
    this.championId = championId;
    this.championAlias = await fetchChampionAlias(championId);

    this.log(
      `${this.prefix()} Champion sélectionné: ${this.championAlias} (${championId})`
    );

    // Default skin = championId * 1000
    const defaultSkinId = championId * 1000;

    // Emit update-selection with default skin
    this.requireRoomSocket().emit("update-selection", {
      roomId: this.roomId,
      memberId: this.memberId,
      memberToken: this.memberToken,
      championId: this.championId,
      championAlias: this.championAlias,
      skinId: defaultSkinId,
      chromaId: 0,
    });

    // Build owned options
    this.log(`${this.prefix()} Récupération des skins depuis Community Dragon...`);

    this.options = await buildOwnedOptions(championId, (current, total) => {
      if (onProgress) {
        onProgress(current, total);
      }
    });

    this.log(
      `${this.prefix()} ${this.options.length} options générées — envoi owned-options`
    );

    // Emit owned-options
    this.requireRoomSocket().emit("owned-options", {
      roomId: this.roomId,
      memberId: this.memberId,
      memberToken: this.memberToken,
      championId: this.championId,
      championAlias: this.championAlias,
      options: this.options,
    });
  }

  suggestColor(skinId: number, chromaId: number): void {
    if (!this.roomSocket) return;

    this.roomSocket.emit(
      "suggest-color",
      {
        roomId: this.roomId,
        memberId: this.memberId,
        memberToken: this.memberToken,
        skinId,
        chromaId,
      },
      (ack: { success?: boolean; error?: string }) => {
        if (ack?.success) {
          this.log(`${this.prefix()} Suggestion de couleur envoyée`);
        } else {
          this.log(
            `${this.prefix()} ${DIM}Suggestion refusée: ${ack?.error ?? "unknown"}${RESET}`
          );
        }
      }
    );
  }

  disconnect(): void {
    this.roomSocket?.disconnect();
    this.identitySocket?.disconnect();
    this.roomSocket = null;
    this.identitySocket = null;
    this.connected = false;
    this.log(`${this.prefix()} Déconnecté`);
  }

  getStatus(): string {
    return `${this.color}${this.summonerName}${RESET} | ${this.role} | room: ${this.roomCode || "-"} | champion: ${this.championAlias || "-"} (${this.championId || "-"})`;
  }
}
