/**
 * Tests de non-regression pour la vague 2 de l'audit de securite.
 * Chaque bloc reference le finding qu'il verrouille.
 */
import type { Socket } from "socket.io";
import { RoomService } from "../../services/room.service";
import { presenceManager } from "../../services/presence.service";
import { validateOwnedOptionsPayload } from "../../utils/validation";
import { createSocketRateLimiter } from "../../utils/socketRateLimiter";

/** Faux socket minimal : seuls join/leave/id sont utilises par presenceManager. */
function makeFakeSocket(id: string) {
  const joined = new Set<string>();
  return {
    socket: {
      id,
      join: (room: string) => joined.add(room),
      leave: (room: string) => joined.delete(room),
    } as unknown as Socket,
    joined,
  };
}

describe("Audit vague 2 — non-regression", () => {
  let service: RoomService;

  beforeEach(() => {
    service = RoomService.getInstance();
    (service as any).rooms.clear();
    (service as any).roomsByCode.clear();
    // Purge du singleton de presence entre les tests.
    (presenceManager as any).connections.clear();
    (presenceManager as any).socketToPuuid.clear();
    (presenceManager as any).friendsMap.clear();
  });

  // --- H5 : squattage / fuite de PUUID ---
  describe("H5 — identify libere le PUUID precedent", () => {
    const PUUID_A = "a".repeat(78);
    const PUUID_B = "b".repeat(78);

    it("ne laisse pas d'entree orpheline quand un socket se re-identifie", () => {
      const { socket } = makeFakeSocket("socket-1");

      expect(presenceManager.identify(socket, PUUID_A, "Alice").ok).toBe(true);
      expect(presenceManager.isOnline(PUUID_A)).toBe(true);

      // Le meme socket s'identifie sur un autre puuid.
      expect(presenceManager.identify(socket, PUUID_B, "Bob").ok).toBe(true);

      // Avant le correctif, PUUID_A restait "en ligne" pour toujours.
      expect(presenceManager.isOnline(PUUID_A)).toBe(false);
      expect(presenceManager.isOnline(PUUID_B)).toBe(true);
      expect(presenceManager.getConnectionCount()).toBe(1);
    });

    it("quitte le canal personnel du PUUID libere (plus d'interception d'invitations)", () => {
      const { socket, joined } = makeFakeSocket("socket-1");

      presenceManager.identify(socket, PUUID_A, "Alice");
      expect(joined.has(`user:${PUUID_A}`)).toBe(true);

      presenceManager.identify(socket, PUUID_B, "Bob");
      expect(joined.has(`user:${PUUID_A}`)).toBe(false);
      expect(joined.has(`user:${PUUID_B}`)).toBe(true);
    });

    it("la vraie victime peut recuperer son PUUID apres le depart du squatteur", () => {
      const attacker = makeFakeSocket("attacker");
      const victim = makeFakeSocket("victim");

      presenceManager.identify(attacker.socket, PUUID_A, "Squatteur");
      // La victime est refusee tant que l'attaquant tient le puuid.
      expect(presenceManager.identify(victim.socket, PUUID_A, "Alice")).toEqual({
        ok: false,
        reason: "puuid_taken",
      });

      // L'attaquant bascule sur un autre puuid : le premier doit etre libere.
      presenceManager.identify(attacker.socket, PUUID_B, "Squatteur");
      expect(presenceManager.identify(victim.socket, PUUID_A, "Alice").ok).toBe(true);
    });

    it("une boucle d'identify ne fait pas croitre les connexions sans borne", () => {
      const { socket } = makeFakeSocket("flood");
      for (let i = 0; i < 200; i++) {
        presenceManager.identify(socket, String(i).padStart(78, "x"), "Flood");
      }
      // Un socket = une connexion, quel que soit le nombre d'identify.
      expect(presenceManager.getConnectionCount()).toBe(1);
    });

    it("re-identify sur le MEME puuid reste idempotent", () => {
      const { socket, joined } = makeFakeSocket("socket-1");
      presenceManager.identify(socket, PUUID_A, "Alice");
      expect(presenceManager.identify(socket, PUUID_A, "Alice").ok).toBe(true);
      expect(presenceManager.isOnline(PUUID_A)).toBe(true);
      expect(joined.has(`user:${PUUID_A}`)).toBe(true);
    });
  });

  // --- H4 : rate limiting Socket.IO ---
  describe("H4 — rate limiting par socket", () => {
    const limiter = () => createSocketRateLimiter("s1", { enabled: true });

    it("laisse passer un usage normal", () => {
      const rl = limiter();
      for (let i = 0; i < 10; i++) {
        expect(rl.allow("join-room")).toBe(true);
      }
      expect(rl.droppedCount()).toBe(0);
    });

    it("coupe un flood d'evenements bon marche", () => {
      const rl = limiter();
      let allowed = 0;
      for (let i = 0; i < 500; i++) if (rl.allow("set-skin-lock")) allowed++;
      // Le seau global (capacite 60) borne la rafale.
      expect(allowed).toBeLessThanOrEqual(60);
      expect(rl.droppedCount()).toBeGreaterThan(400);
    });

    it("borne bien plus severement les evenements couteux", () => {
      const rl = limiter();
      let allowed = 0;
      for (let i = 0; i < 100; i++) if (rl.allow("owned-options")) allowed++;
      // Seau "expensive" : capacite 12.
      expect(allowed).toBeLessThanOrEqual(12);
    });

    it("le seau global ne peut pas etre contourne en alternant les evenements", () => {
      const rl = limiter();
      const events = ["join-room", "leave-room", "set-skin-lock", "kick-member"];
      let allowed = 0;
      for (let i = 0; i < 500; i++) {
        if (rl.allow(events[i % events.length])) allowed++;
      }
      expect(allowed).toBeLessThanOrEqual(60);
    });

    it("borne tres strictement identify (vecteur du squattage de PUUID)", () => {
      const rl = limiter();
      let allowed = 0;
      for (let i = 0; i < 50; i++) if (rl.allow("identify")) allowed++;
      expect(allowed).toBeLessThanOrEqual(5);
    });

    it("est inactif par defaut sous NODE_ENV=test", () => {
      const rl = createSocketRateLimiter("s2");
      for (let i = 0; i < 1000; i++) expect(rl.allow("owned-options")).toBe(true);
      expect(rl.droppedCount()).toBe(0);
    });
  });

  // --- H8 : cardinalite de auraColor ---
  describe("H8 — auraColor validee et cardinalite bornee", () => {
    const base = {
      roomId: "r",
      memberId: "m",
      memberToken: "t".repeat(64),
      championId: 1,
    };
    const opt = (auraColor: unknown) => ({
      ...base,
      options: [{ skinId: 1, chromaId: 0, auraColor }],
    });

    it.each([
      "rgba(98,72,255,0.5)",
      "rgba(0,0,0,0)",
      "rgb(255,255,255)",
      "#6248FF",
      "#abcdef",
    ])("accepte le format legitime %s", (color) => {
      expect(validateOwnedOptionsPayload(opt(color)).valid).toBe(true);
    });

    it.each([
      "red",
      "red;background:url(http://evil)",
      "rgba(999,0,0,0.5)",
      "javascript:alert(1)",
      "#zzzzzz",
      "#FFF",
      "rgba(1,2,3,0.5) ",
      "",
    ])("rejette la valeur hostile ou malformee %j", (color) => {
      expect(validateOwnedOptionsPayload(opt(color)).valid).toBe(false);
    });

    it("null reste accepte (skin sans aura)", () => {
      expect(validateOwnedOptionsPayload(opt(null)).valid).toBe(true);
    });

    it("recomputeSynergy reste borne face a un grand nombre de couleurs distinctes", () => {
      const { room } = service.createRoom("Owner");
      const joined = service.joinRoom(room.code, "Other");
      if ("error" in joined) throw new Error("join a echoue");

      // 2000 couleurs distinctes par membre : sans plafond, la boucle
      // couleurs x membres x options explosait.
      const many = (offset: number) =>
        Array.from({ length: 2000 }, (_, i) => ({
          skinId: i,
          chromaId: 0,
          auraColor: `rgba(${(i + offset) % 256},${i % 256},${(i * 7) % 256},0.5)`,
        }));

      const [a, b] = Array.from(room.members.values());
      a.options = many(0);
      b.options = many(1);

      const start = Date.now();
      service.recomputeSynergy(room);
      expect(Date.now() - start).toBeLessThan(2000);
    });
  });

  // --- M3 / M4 : cycle de vie des rooms et des membres ---
  describe("M3/M4 — balayage des rooms et des membres jamais connectes", () => {
    const LATER = 5 * 60 * 1000; // au-dela du sursis de 2 min

    it("libere le slot d'un membre qui n'a jamais attache de socket", () => {
      const { room } = service.createRoom("Owner");
      const owner = Array.from(room.members.values())[0];
      service.markMemberConnected(room, owner.id);

      const joined = service.joinRoom(room.code, "Fantome");
      if ("error" in joined) throw new Error("join a echoue");
      expect(room.members.size).toBe(2);

      const res = service.sweep(Date.now() + LATER);
      expect(res.membersEvicted).toBe(1);
      expect(room.members.size).toBe(1);
      expect(room.members.has(owner.id)).toBe(true);
    });

    it("ne touche pas un membre qui a bien attache un socket", () => {
      const { room } = service.createRoom("Owner");
      const owner = Array.from(room.members.values())[0];
      service.markMemberConnected(room, owner.id);

      const joined = service.joinRoom(room.code, "Reel");
      if ("error" in joined) throw new Error("join a echoue");
      service.markMemberConnected(room, joined.member.id);

      service.sweep(Date.now() + LATER);
      expect(room.members.size).toBe(2);
    });

    it("supprime la room quand plus personne ne s'est connecte", () => {
      const { room } = service.createRoom("Owner");
      const res = service.sweep(Date.now() + LATER);
      expect(res.roomsClosed).toBe(1);
      expect(service.getRoom(room.id)).toBeUndefined();
      expect(service.getRoomByCode(room.code)).toBeUndefined();
    });

    it("supprime une room inactive depuis plus de 6 h", () => {
      const { room } = service.createRoom("Owner");
      const owner = Array.from(room.members.values())[0];
      service.markMemberConnected(room, owner.id);

      // Toujours active a 5 h.
      service.sweep(Date.now() + 5 * 60 * 60 * 1000);
      expect(service.getRoom(room.id)).toBeDefined();

      // Expiree a 7 h.
      service.sweep(Date.now() + 7 * 60 * 60 * 1000);
      expect(service.getRoom(room.id)).toBeUndefined();
    });

    it("promeut un nouveau proprietaire si l'owner est evince", () => {
      const { room } = service.createRoom("Owner");
      const joined = service.joinRoom(room.code, "Survivant");
      if ("error" in joined) throw new Error("join a echoue");
      // Seul le second membre se connecte : l'owner reste en sursis.
      service.markMemberConnected(room, joined.member.id);

      service.sweep(Date.now() + LATER);
      expect(service.getRoom(room.id)).toBeDefined();
      expect(room.ownerId).toBe(joined.member.id);
    });

    it("refuse la creation au-dela du plafond global", () => {
      // On triche sur la Map pour ne pas creer 5000 rooms reelles.
      const fake = (service as any).rooms as Map<string, unknown>;
      for (let i = 0; i < 5000; i++) fake.set(`fake-${i}`, {});
      expect(() => service.createRoom("Trop")).toThrow();
    });
  });

  // --- M7 : le kick devient effectif ---
  describe("M7 — un membre exclu ne peut plus revenir avec le meme code", () => {
    it("refuse le rejoin d'un nom exclu", () => {
      const { room } = service.createRoom("Owner");
      const joined = service.joinRoom(room.code, "Genant");
      if ("error" in joined) throw new Error("join a echoue");

      expect(service.kickMember(room, joined.member.id)).toEqual({ ok: true });

      const retry = service.joinRoom(room.code, "Genant");
      expect("error" in retry).toBe(true);
      if ("error" in retry) expect(retry.status).toBe(403);
    });

    it("l'exclusion est insensible a la casse et aux espaces", () => {
      const { room } = service.createRoom("Owner");
      const joined = service.joinRoom(room.code, "Genant");
      if ("error" in joined) throw new Error("join a echoue");
      service.kickMember(room, joined.member.id);

      for (const variant of ["genant", "  GENANT  ", "GeNaNt"]) {
        const retry = service.joinRoom(room.code, variant);
        expect("error" in retry).toBe(true);
      }
    });

    it("n'affecte pas les autres joueurs", () => {
      const { room } = service.createRoom("Owner");
      const bad = service.joinRoom(room.code, "Genant");
      if ("error" in bad) throw new Error("join a echoue");
      service.kickMember(room, bad.member.id);

      const good = service.joinRoom(room.code, "Sympa");
      expect("error" in good).toBe(false);
    });

    it("le proprietaire ne peut pas s'auto-exclure", () => {
      const { room } = service.createRoom("Owner");
      expect(service.kickMember(room, room.ownerId)).toEqual({
        ok: false,
        reason: "self",
      });
    });
  });
});
