import { io, Socket } from "socket.io-client";
import {
  ClientLifecycle,
  GroupSkinOption,
  RoomStatePayload,
} from "./types";
import { buildOwnedOptions } from "./options-builder";
import { fetchChampionAlias } from "./cdragon.service";
import { pickOneOptimalChampion } from "./auto-draft";

const SERVER_URL = "http://localhost:4000";
const CONNECT_TIMEOUT = 5000;
// Bumped from "2" to "3" so room-state payloads include the per-member
// `lockedSkin` field — the simulator now displays it in its room view and
// re-syncs its local lock state from the canonical server payload.
const CLIENT_VERSION = "3";

// ANSI color codes for terminal output
const COLORS = [
  "\x1b[36m", // cyan
  "\x1b[33m", // yellow
  "\x1b[35m", // magenta
  "\x1b[32m", // green
];
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

let colorIndex = 0;

export type LogFunction = (message: string) => void;

/**
 * One simulated player. Holds two socket connections (identity + room),
 * tracks a lifecycle state ("lobby" | "in-draft") that mirrors what a real
 * LCU-backed player would broadcast, and keeps a snapshot of the latest
 * room-state from the server so the CLI's pickers can be context-aware
 * (only show available synergies, only show this player's owned skins, etc).
 */
export class FakeClient {
  puuid: string;
  summonerName: string;
  roomSocket: Socket | null = null;
  identitySocket: Socket | null = null;
  memberId: string = "";
  memberToken: string = "";
  roomId: string = "";
  roomCode: string = "";

  // Champion state — non-zero only while in-draft. Mirrors what a real player
  // would broadcast: in lobby, championId stays at 0 and no `owned-options`
  // is uploaded — synergy doesn't see the player at all until they enter
  // champ select.
  championId: number = 0;
  championAlias: string = "";
  options: GroupSkinOption[] = [];

  /** Default "lobby" — flipped to "in-draft" on enterChampSelect / changeChampion. */
  lifecycle: ClientLifecycle = "lobby";
  /** Local mirror of `Member.lockedSkin`. Re-synced from each room-state. */
  skinLockEnabled = false;
  /** Latest serialized room state received from the server, or null. */
  latestRoomState: RoomStatePayload | null = null;

  /**
   * When ON, the client watches `room-state` and as soon as another member
   * appears with a non-zero championId, this client auto-enters champ select
   * with a champion optimized for skin-line synergy. This is the
   * "I don't have time to pilot every fake during my real custom draft" mode.
   */
  autoFollowEnabled = false;
  /** In-flight guard so a burst of room-state events doesn't spawn N picks. */
  private autoPickInFlight = false;

  /**
   * External coordination hook. When set (typically by the CLI), every
   * "I want to auto-pick because someone else just picked" request goes
   * through this callback instead of firing immediately. The CLI uses
   * this to serialize multi-fake auto-follow into a single 1-second-gap
   * sequence — without it, several fakes firing in the same tick all
   * read the same `latestRoomState` and converge on the same champion.
   *
   * If null, the client falls back to picking directly (used by the
   * standalone smoke tests; production CLI always wires an orchestrator).
   */
  autoPickRequester: ((client: FakeClient) => void) | null = null;

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

  // --- Public getters ---

  get inDraft(): boolean {
    return this.lifecycle === "in-draft";
  }

  get isOwner(): boolean {
    return this.role === "owner";
  }

  prefix(): string {
    return `${this.color}[${this.summonerName}]${RESET}`;
  }

  /**
   * Public helper for external callers (e.g. the CLI's draft orchestrator)
   * to emit a status line under this client's identity. Goes through the
   * same prompt-aware logger as the client's own internal log calls.
   */
  notify(message: string): void {
    this.log(`${this.prefix()} ${message}`);
  }

  private requireRoomSocket(): Socket {
    if (!this.roomSocket?.connected) {
      throw new Error("Room socket non connecté");
    }
    return this.roomSocket;
  }

  // ==========================================================================
  // Connection
  // ==========================================================================

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
        query: { clientVersion: CLIENT_VERSION },
      });

      this.identitySocket.on("connect", () => {
        clearTimeout(timeout);
        this.log(`${this.prefix()} ${DIM}identity socket connecté${RESET}`);
        this.identitySocket!.emit("identify", {
          puuid: this.puuid,
          summonerName: this.summonerName,
          friends: this.friendPuuids,
        });
      });

      this.identitySocket.on(
        "identity-confirmed",
        (payload: { onlineFriends: string[] }) => {
          this.log(
            `${this.prefix()} identité confirmée (${payload.onlineFriends.length} ami(s) en ligne)`
          );
          this.identitySocket!.emit("join-personal-room");
          this.connected = true;
          resolve();
        }
      );

      this.identitySocket.on(
        "identity-rejected",
        (p: { reason?: string }) => {
          clearTimeout(timeout);
          reject(new Error(`identité rejetée: ${p?.reason ?? "?"}`));
        }
      );

      this.identitySocket.on("connect_error", (err: Error) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Impossible de se connecter au serveur sur localhost:4000 — est-il lancé ? (${err.message})`
          )
        );
      });

      this.identitySocket.on(
        "room-invite-received",
        (p: { fromName: string; roomCode: string }) => {
          this.log(
            `${this.prefix()} invitation reçue de ${p.fromName} pour la room ${p.roomCode}`
          );
        }
      );

      this.identitySocket.on(
        "invite-sent",
        (p: { targetPuuid: string }) => {
          this.log(`${this.prefix()} invitation envoyée à ${p.targetPuuid}`);
        }
      );

      this.identitySocket.on("invite-failed", (p: { reason: string }) => {
        this.log(
          `${this.prefix()} ${DIM}invitation échouée: ${p.reason}${RESET}`
        );
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
        query: { clientVersion: CLIENT_VERSION },
      });

      this.roomSocket.on("connect", () => {
        clearTimeout(timeout);
        this.log(`${this.prefix()} ${DIM}room socket connecté${RESET}`);
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

      // --- Room events ---

      this.roomSocket.on("room-state", (room: RoomStatePayload) => {
        this.latestRoomState = room;
        // Re-sync our own lock from the canonical server state to catch any
        // out-of-band changes (we still set it locally before each emit).
        const me = room.members?.find((m) => m.id === this.memberId);
        if (me?.lockedSkin !== undefined) {
          this.skinLockEnabled = me.lockedSkin;
        }
        const memberNames = (room.members ?? [])
          .map((m) => {
            const champ =
              m.championAlias ||
              (m.championId > 0 ? String(m.championId) : "—");
            const ready = m.isReady ? "✓" : "·";
            const lock = m.lockedSkin ? " 🔒" : "";
            return `${m.name}(${champ}${ready})${lock}`;
          })
          .join(", ");
        this.log(
          `${this.prefix()} ${DIM}room-state: ${room.members?.length ?? 0} membre(s) [${memberNames}]${RESET}`
        );

        // Auto-follow: if another member just appeared with a non-zero
        // champion and we're still in lobby, request an auto-pick. The
        // actual sequencing (1s between consecutive picks, dedup, final
        // re-validation) is handled by the orchestrator wired via
        // `autoPickRequester`. We don't pick directly here — that would
        // bypass sequencing and cause every fake firing on the same
        // room-state event to converge on the same champion.
        if (
          this.autoFollowEnabled &&
          this.lifecycle === "lobby" &&
          !this.autoPickInFlight
        ) {
          const someoneElsePicked = (room.members ?? []).some(
            (m) => m.id !== this.memberId && m.championId > 0
          );
          if (someoneElsePicked) {
            this.requestAutoPick();
          }
        }
      });

      this.roomSocket.on("room-closed", (p: { reason?: string }) => {
        this.log(`${this.prefix()} room fermée (${p.reason ?? "?"})`);
        this.lifecycle = "lobby";
        this.latestRoomState = null;
      });

      this.roomSocket.on(
        "group-apply-combo",
        (p: {
          type: string;
          color?: string;
          skinLineName?: string;
          picks: Array<{
            memberId: string;
            skinId: number;
            chromaId: number;
          }>;
          autoApplied?: boolean;
        }) => {
          const desc =
            p.type === "skinLine"
              ? `lignée "${p.skinLineName}"`
              : `couleur ${p.color}`;
          const auto = p.autoApplied ? " (auto)" : "";
          this.log(
            `${this.prefix()} ${this.color}group-apply-combo${auto}: ${desc} — ${p.picks.length} picks${RESET}`
          );
        }
      );

      this.roomSocket.on(
        "error",
        (err: { code: string; message: string }) => {
          this.log(
            `${this.prefix()} ${DIM}erreur serveur: [${err.code}] ${err.message}${RESET}`
          );
        }
      );

      this.roomSocket.on(
        "color-suggestion-received",
        (p: {
          memberId: string;
          senderName?: string;
          memberName?: string;
        }) => {
          // V1 uses senderName, V2 uses memberName — accept both.
          const sender = p.memberName ?? p.senderName ?? p.memberId;
          this.log(`${this.prefix()} suggestion de couleur reçue de ${sender}`);
        }
      );
    });
  }

  // ==========================================================================
  // Room creation / join (REST)
  // ==========================================================================

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

    this.log(
      `${this.prefix()} room créée — code: ${this.color}${BOLD}${this.roomCode}${RESET}`
    );

    this.requireRoomSocket().emit("join-room", {
      roomId: this.roomId,
      memberId: this.memberId,
      memberToken: this.memberToken,
    });
  }

  async joinRoom(code: string): Promise<void> {
    const response = await fetch(`${SERVER_URL}/rooms/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: this.summonerName }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
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

    this.log(`${this.prefix()} room rejointe — code: ${this.roomCode}`);

    this.requireRoomSocket().emit("join-room", {
      roomId: this.roomId,
      memberId: this.memberId,
      memberToken: this.memberToken,
    });
  }

  // ==========================================================================
  // Lifecycle transitions — the difference between a "real" player and a bot
  // ==========================================================================

  /**
   * Move from lobby → in-draft for the given champion.
   *  - emits `update-selection` with championId + default skin (no chroma)
   *  - emits `owned-options` once skins/chromas/colors are fetched
   *
   * After this returns the member is "ready" on the server, contributes to
   * synergy, and can be auto-applied to. Calling this twice with the same
   * champion is a no-op.
   */
  async enterChampSelect(
    championId: number,
    onProgress?: (current: number, total: number) => void
  ): Promise<void> {
    if (this.lifecycle === "in-draft" && this.championId === championId) {
      this.log(
        `${this.prefix()} ${DIM}déjà en champion select sur ${this.championAlias}${RESET}`
      );
      return;
    }
    await this.applyChampion(championId, onProgress);
    this.lifecycle = "in-draft";
  }

  /**
   * Switch champion while staying in champion select. Same wire effect as
   * `enterChampSelect` (the server clears options when championId changes,
   * then we resend them); only the log line differs.
   */
  async changeChampion(
    championId: number,
    onProgress?: (current: number, total: number) => void
  ): Promise<void> {
    await this.applyChampion(championId, onProgress);
    this.lifecycle = "in-draft";
  }

  /**
   * Move back to lobby — clear champion + options on the server. Mirrors a
   * real player leaving champion select: their next `update-selection` (with
   * a different championId) makes the server drop their options on the floor.
   * We send championId=0 explicitly to be unambiguous.
   */
  leaveChampSelect(): void {
    if (this.lifecycle === "lobby") {
      this.log(`${this.prefix()} ${DIM}déjà en lobby${RESET}`);
      return;
    }

    const oldChamp = this.championAlias || String(this.championId);
    this.championId = 0;
    this.championAlias = "";
    this.options = [];

    this.requireRoomSocket().emit("update-selection", {
      roomId: this.roomId,
      memberId: this.memberId,
      memberToken: this.memberToken,
      championId: 0,
      championAlias: "",
      skinId: 0,
      chromaId: 0,
    });

    this.lifecycle = "lobby";
    this.log(
      `${this.prefix()} sorti de champion select (était sur ${oldChamp}) → lobby`
    );
  }

  private async applyChampion(
    championId: number,
    onProgress?: (current: number, total: number) => void
  ): Promise<void> {
    this.championId = championId;
    this.championAlias = await fetchChampionAlias(championId);

    this.log(
      `${this.prefix()} champion sélectionné: ${BOLD}${this.championAlias}${RESET} ${DIM}(ID ${championId})${RESET}`
    );

    const defaultSkinId = championId * 1000;

    // Hover/preview phase: send champion + base skin, no options yet.
    this.requireRoomSocket().emit("update-selection", {
      roomId: this.roomId,
      memberId: this.memberId,
      memberToken: this.memberToken,
      championId,
      championAlias: this.championAlias,
      skinId: defaultSkinId,
      chromaId: 0,
    });

    this.log(
      `${this.prefix()} ${DIM}calcul des skins/chromas (Community Dragon)...${RESET}`
    );

    this.options = await buildOwnedOptions(championId, onProgress);

    this.log(
      `${this.prefix()} ${this.options.length} options envoyées (${BOLD}owned-options${RESET})`
    );

    this.requireRoomSocket().emit("owned-options", {
      roomId: this.roomId,
      memberId: this.memberId,
      memberToken: this.memberToken,
      championId,
      championAlias: this.championAlias,
      options: this.options,
    });
  }

  // ==========================================================================
  // Member actions
  // ==========================================================================

  invitePlayer(targetPuuid: string): void {
    if (!this.identitySocket) {
      this.log(`${this.prefix()} identity socket non connecté`);
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

  /**
   * Owner-only color reroll. The server applies the picked color to every
   * non-locked member that has at least one option matching it. Optional
   * `skinLineId` narrows the picks to options sharing both the color **and**
   * the skin line.
   */
  requestGroupReroll(color: string, skinLineId?: number): void {
    if (!this.roomSocket) return;
    this.roomSocket.emit("request-group-reroll", {
      roomId: this.roomId,
      memberId: this.memberId,
      memberToken: this.memberToken,
      type: "sameColor",
      color,
      skinLineId,
    });
  }

  suggestColor(
    skinId: number,
    chromaId: number,
    onAck?: (ok: boolean, error?: string) => void
  ): void {
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
        const ok = !!ack?.success;
        onAck?.(ok, ack?.error);
        if (ok) {
          this.log(`${this.prefix()} suggestion envoyée`);
        } else {
          this.log(
            `${this.prefix()} ${DIM}suggestion refusée: ${ack?.error ?? "?"}${RESET}`
          );
        }
      }
    );
  }

  setMatchLock(locked: boolean): void {
    if (!this.roomSocket) return;
    this.skinLockEnabled = !!locked;
    this.roomSocket.emit("set-skin-lock", {
      roomId: this.roomId,
      memberId: this.memberId,
      memberToken: this.memberToken,
      locked: this.skinLockEnabled,
    });
    this.log(
      `${this.prefix()} match-lock ${this.skinLockEnabled ? "🔒 activé" : "🔓 désactivé"}`
    );
  }

  toggleMatchLock(): void {
    this.setMatchLock(!this.skinLockEnabled);
  }

  // ==========================================================================
  // Auto-draft (synergy-maximizing champion selection)
  // ==========================================================================

  /**
   * Pick a single optimal champion (skin-line synergy with whoever's
   * already in the room) and enter champion select with it. No-op if
   * already in-draft, or if another auto-pick is in flight.
   *
   *  - `explicitTarget`: anchor on this champion (e.g. the operator says
   *    "the user is going to play Yasuo, ID 157"). Otherwise inferred
   *    from the current room state.
   *
   * Errors during the cdragon fetch / enterChampSelect are caught and
   * logged — auto-pick is fire-and-forget by design.
   */
  async autoPickChampion(explicitTarget?: number): Promise<void> {
    if (this.lifecycle === "in-draft" || this.autoPickInFlight) return;
    this.autoPickInFlight = true;
    try {
      const pick = await pickOneOptimalChampion({
        selfMemberId: this.memberId,
        roomMembers: this.latestRoomState?.members ?? [],
        explicitTarget,
      });
      if (!pick) {
        this.log(
          `${this.prefix()} ${DIM}auto-pick: aucun candidat trouvé${RESET}`
        );
        return;
      }

      const tag =
        pick.sharedLines > 0
          ? `${pick.sharedLines} lignée${pick.sharedLines > 1 ? "s" : ""} partagée${pick.sharedLines > 1 ? "s" : ""}`
          : `${pick.totalLines} lignées au total`;
      this.log(
        `${this.prefix()} ${BOLD}auto-pick${RESET} → champion ${pick.championId} ${DIM}(${tag})${RESET}`
      );

      await this.enterChampSelect(pick.championId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`${this.prefix()} ${DIM}auto-pick error: ${msg}${RESET}`);
    } finally {
      this.autoPickInFlight = false;
    }
  }

  /**
   * Enable / disable auto-follow. When toggled ON we also evaluate the
   * current room state immediately — if someone has already picked, we
   * request an auto-pick (which goes through the orchestrator, so multiple
   * fakes toggled simultaneously are still serialized 1s apart).
   */
  setAutoFollow(enabled: boolean): void {
    const wasEnabled = this.autoFollowEnabled;
    this.autoFollowEnabled = !!enabled;
    if (wasEnabled === this.autoFollowEnabled) return;

    this.log(
      `${this.prefix()} auto-follow ${this.autoFollowEnabled ? `${BOLD}ON${RESET}` : `${DIM}OFF${RESET}`}`
    );

    if (
      this.autoFollowEnabled &&
      this.lifecycle === "lobby" &&
      this.latestRoomState
    ) {
      const someoneElsePicked = this.latestRoomState.members.some(
        (m) => m.id !== this.memberId && m.championId > 0
      );
      if (someoneElsePicked) {
        this.requestAutoPick();
      }
    }
  }

  toggleAutoFollow(): void {
    this.setAutoFollow(!this.autoFollowEnabled);
  }

  /**
   * Internal helper: defer an auto-pick to the orchestrator if one is
   * wired up (production), or fire directly otherwise (smoke tests).
   * Either path eventually calls `autoPickChampion` — the orchestrator
   * just adds queueing + 1s gap + re-validation.
   */
  private requestAutoPick(): void {
    if (this.autoPickRequester) {
      this.autoPickRequester(this);
      return;
    }
    void this.autoPickChampion().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`${this.prefix()} ${DIM}auto-pick error: ${msg}${RESET}`);
    });
  }

  kickMember(targetMemberId: string): void {
    if (!this.roomSocket) return;
    this.roomSocket.emit("kick-member", {
      roomId: this.roomId,
      memberId: this.memberId,
      memberToken: this.memberToken,
      targetMemberId,
    });
  }

  /** Emit `leave-room` then disconnect both sockets. */
  leaveRoomGracefully(): void {
    if (this.roomSocket && this.roomId) {
      try {
        this.roomSocket.emit("leave-room", {
          roomId: this.roomId,
          memberId: this.memberId,
          memberToken: this.memberToken,
        });
      } catch {
        /* ignore — we'll disconnect anyway */
      }
    }
    this.disconnect();
  }

  disconnect(): void {
    this.roomSocket?.disconnect();
    this.identitySocket?.disconnect();
    this.roomSocket = null;
    this.identitySocket = null;
    this.connected = false;
    this.log(`${this.prefix()} déconnecté`);
  }

  // ==========================================================================
  // Status helpers (for the CLI)
  // ==========================================================================

  /** One-line status used in `[3] List clients`. */
  getStatus(): string {
    const lifecycleLabel =
      this.lifecycle === "lobby"
        ? `${DIM}lobby${RESET}`
        : `${BOLD}draft${RESET} (${this.championAlias} #${this.championId})`;
    const lock = this.skinLockEnabled ? " 🔒" : "";
    const follow = this.autoFollowEnabled ? " 👁" : "";
    return [
      `${this.color}${this.summonerName}${RESET}`,
      this.role,
      `room: ${this.roomCode || "—"}`,
      `state: ${lifecycleLabel}${lock}${follow}`,
    ].join(" | ");
  }

  /** Multi-line pretty print used by the pilot menu's "show room" action. */
  prettyRoomState(): string {
    const r = this.latestRoomState;
    if (!r) {
      return `${DIM}(pas encore de room-state reçu)${RESET}`;
    }
    const lines: string[] = [];
    lines.push(
      `${BOLD}Room ${r.code}${RESET} ${DIM}(id ${r.id}, v${r.version ?? "?"})${RESET}`
    );
    const ownerLabel =
      r.ownerId === this.memberId ? `${BOLD}toi${RESET}` : r.ownerId;
    lines.push(`Owner: ${ownerLabel}`);
    lines.push(`Members (${r.members?.length ?? 0}):`);
    for (const m of r.members ?? []) {
      const isMe = m.id === this.memberId ? `${BOLD}*${RESET}` : " ";
      const isOwner = r.ownerId === m.id ? "👑" : "  ";
      const lock = m.lockedSkin ? "🔒" : "  ";
      const ready = m.isReady ? "✓" : "·";
      const champ =
        m.championAlias ||
        (m.championId > 0
          ? `#${m.championId}`
          : `${DIM}—lobby—${RESET}`);
      const skin = m.skinId
        ? ` skin ${m.skinId}${m.chromaId ? `/c${m.chromaId}` : ""}`
        : "";
      lines.push(
        `  ${isMe} ${isOwner} ${lock} ${ready}  ${m.name.padEnd(20)} ${champ}${skin}`
      );
    }
    const cs = r.synergy?.colors ?? [];
    if (cs.length) {
      lines.push(`${BOLD}Color synergies (${cs.length}):${RESET}`);
      for (const c of cs.slice(0, 8)) {
        const pct = Math.round(c.coverage * 100);
        lines.push(
          `  ${c.color}  ${c.members.length} membres (${pct}% cov), ${c.combinationCount} combos`
        );
      }
    }
    const sl = r.synergy?.skinLines ?? [];
    if (sl.length) {
      lines.push(`${BOLD}Skin-line synergies (${sl.length}):${RESET}`);
      for (const s of sl.slice(0, 8)) {
        const pct = Math.round(s.coverage * 100);
        lines.push(
          `  ${s.skinLineName} (#${s.skinLineId})  ${s.members.length} membres (${pct}% cov), ${s.combinationCount} combos`
        );
      }
    }
    if (r.activeSynergy) {
      const tag =
        r.activeSynergy.type === "skinLine"
          ? r.activeSynergy.skinLineName ?? `#${r.activeSynergy.skinLineId}`
          : r.activeSynergy.color ?? "?";
      lines.push(`${DIM}Active synergy: ${r.activeSynergy.type} → ${tag}${RESET}`);
    }
    return lines.join("\n");
  }
}
