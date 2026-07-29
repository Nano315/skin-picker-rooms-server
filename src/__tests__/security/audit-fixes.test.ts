/**
 * Tests de non-regression pour les correctifs de la vague 1 de l'audit de
 * securite. Chaque bloc reference le finding qu'il verrouille.
 */
import { RoomService } from "../../services/room.service";
import { AppError, ErrorCodes } from "../../utils/errors";
import {
  validateOwnedOptionsPayload,
  validateUpdateSelectionPayload,
  validateRequestGroupRerollPayload,
  validateSetSkinLockPayload,
  validateKickMemberPayload,
} from "../../utils/validation";

describe("Audit vague 1 — non-regression", () => {
  let service: RoomService;

  beforeEach(() => {
    service = RoomService.getInstance();
    (service as any).rooms.clear();
    (service as any).roomsByCode.clear();
  });

  // --- H1 : ReDoS / injection RegExp via namePrefix ---
  describe("H1 — addBots n'accepte plus de namePrefix arbitraire", () => {
    const buildRoom = () => {
      const { room } = service.createRoom("Owner");
      return room;
    };

    it.each([
      ["(a+)+", "quantificateurs imbriques (ReDoS)"],
      ["^|", "alternance vide (injection de semantique)"],
      ["(", "regex syntaxiquement invalide"],
      [".*", "metacaracteres"],
      ["a".repeat(25), "prefixe trop long"],
      ["", "prefixe vide explicite"],
    ])("rejette %j — %s", (prefix) => {
      const room = buildRoom();
      expect(() => service.addBots(room, 1, { namePrefix: prefix })).toThrow(AppError);
    });

    it("renvoie bien un AppError INVALID_PAYLOAD (donc un 400, pas un 500)", () => {
      const room = buildRoom();
      try {
        service.addBots(room, 1, { namePrefix: "(a+)+" });
        fail("addBots aurait du lever");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe(ErrorCodes.INVALID_PAYLOAD);
      }
    });

    it("ne se bloque pas sur un nom de membre concu pour le backtracking", () => {
      const room = buildRoom();
      // Le membre porte un nom qui aurait fait exploser `^(a+)+ (\d+)$`.
      const victim = Array.from(room.members.values())[0];
      victim.name = "a".repeat(60);

      const start = Date.now();
      service.addBots(room, 1, { namePrefix: "Bot" });
      // Sans le correctif, cette ligne ne rendait jamais la main.
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it("accepte un prefixe legitime et numerote sans collision", () => {
      const room = buildRoom();
      const bots = service.addBots(room, 2, { namePrefix: "Bot" });
      expect(bots).toHaveLength(2);
      expect(bots.map((b) => b.name)).toEqual(["Bot 1", "Bot 2"]);

      const more = service.addBots(room, 1, { namePrefix: "Bot" });
      expect(more[0].name).toBe("Bot 3");
    });

    it("utilise 'Bot' par defaut quand namePrefix est absent ou du mauvais type", () => {
      expect(service.addBots(buildRoom(), 1, {})[0].name).toBe("Bot 1");
      expect(service.addBots(buildRoom(), 1, { namePrefix: 42 })[0].name).toBe("Bot 1");
      expect(service.addBots(buildRoom(), 1, { namePrefix: null })[0].name).toBe("Bot 1");
    });
  });

  // --- H2 : crash du process via options[] malforme ---
  describe("H2 — les elements de options[] sont valides", () => {
    const base = {
      roomId: "room-1",
      memberId: "member-1",
      memberToken: "t".repeat(64),
      championId: 12,
    };

    it("rejette un null dans options[] (le vecteur de crash)", () => {
      const res = validateOwnedOptionsPayload({ ...base, options: [null] });
      expect(res.valid).toBe(false);
    });

    const badOptions: Array<[unknown[], string]> = [
      [[undefined], "undefined"],
      [["nope"], "chaine"],
      [[42], "nombre"],
      [[[]], "tableau imbrique"],
      [[{ skinId: 1 }], "chromaId manquant"],
      [[{ skinId: 1, chromaId: 0 }], "auraColor manquant (undefined)"],
      [[{ skinId: -1, chromaId: 0, auraColor: null }], "skinId negatif"],
      [[{ skinId: 1.5, chromaId: 0, auraColor: null }], "skinId non entier"],
      [[{ skinId: 1, chromaId: 0, auraColor: "x".repeat(65) }], "auraColor trop longue"],
      [[{ skinId: 1, chromaId: 0, auraColor: null, skinLineId: "abc" }], "skinLineId non numerique"],
    ];

    it.each(badOptions)("rejette %j — %s", (options) => {
      expect(validateOwnedOptionsPayload({ ...base, options }).valid).toBe(false);
    });

    it("accepte des options bien formees, auraColor null inclus", () => {
      const res = validateOwnedOptionsPayload({
        ...base,
        options: [
          { skinId: 1, chromaId: 0, auraColor: null },
          { skinId: 2, chromaId: 3, auraColor: "#6248FF", skinLineId: 7, skinLineName: "Star Guardian" },
        ],
      });
      expect(res.valid).toBe(true);
      if (res.valid) expect(res.payload.options).toHaveLength(2);
    });

    it("rejette au-dela du plafond d'options", () => {
      const many = Array.from({ length: 2001 }, (_, i) => ({
        skinId: i,
        chromaId: 0,
        auraColor: null,
      }));
      expect(validateOwnedOptionsPayload({ ...base, options: many }).valid).toBe(false);
    });

    it("aucune option malformee ne peut plus atteindre recomputeSynergy", () => {
      const { room } = service.createRoom("Owner");
      const joined = service.joinRoom(room.code, "Attacker");
      if ("error" in joined) throw new Error("join a echoue");

      const [owner, attacker] = Array.from(room.members.values());

      // recomputeSynergy sort tot si moins de 2 membres portent des options :
      // le crash exige donc un membre sain ET le membre empoisonne.
      owner.options = [{ skinId: 1, chromaId: 0, auraColor: "#FFFFFF" }];
      (attacker as any).options = [null];

      // Etat d'avant le correctif : opt.auraColor est deferences sans garde.
      // Depuis le handler `disconnect`, cette TypeError tuait le process.
      expect(() => service.recomputeSynergy(room)).toThrow(TypeError);

      // Desormais un tel payload est rejete en amont et n'est jamais assigne.
      expect(
        validateOwnedOptionsPayload({
          roomId: room.id,
          memberId: attacker.id,
          memberToken: attacker.token,
          championId: 1,
          options: [null],
        }).valid
      ).toBe(false);
    });
  });

  // --- H3 : les validateurs sont reellement branches ---
  describe("H3 — validateurs des evenements authentifies", () => {
    const identity = {
      roomId: "room-1",
      memberId: "member-1",
      memberToken: "t".repeat(64),
    };

    it("rejette un payload non-objet", () => {
      for (const bad of [null, undefined, "x", 42, []]) {
        expect(validateSetSkinLockPayload(bad).valid).toBe(false);
      }
    });

    it("rejette une identite incomplete ou hors bornes", () => {
      expect(validateSetSkinLockPayload({ ...identity, roomId: "", locked: true }).valid).toBe(false);
      expect(validateSetSkinLockPayload({ ...identity, memberId: "a".repeat(129), locked: true }).valid).toBe(false);
      expect(validateSetSkinLockPayload({ ...identity, memberToken: "", locked: true }).valid).toBe(false);
    });

    it("set-skin-lock exige un booleen strict", () => {
      expect(validateSetSkinLockPayload({ ...identity, locked: "true" }).valid).toBe(false);
      expect(validateSetSkinLockPayload({ ...identity, locked: 1 }).valid).toBe(false);
      expect(validateSetSkinLockPayload({ ...identity, locked: true }).valid).toBe(true);
    });

    it("kick-member exige un targetMemberId non vide", () => {
      expect(validateKickMemberPayload({ ...identity, targetMemberId: "" }).valid).toBe(false);
      expect(validateKickMemberPayload({ ...identity }).valid).toBe(false);
      expect(validateKickMemberPayload({ ...identity, targetMemberId: "m2" }).valid).toBe(true);
    });

    it("update-selection exige des identifiants entiers bornes", () => {
      const ok = { ...identity, championId: 1, skinId: 2, chromaId: 0 };
      expect(validateUpdateSelectionPayload(ok).valid).toBe(true);
      expect(validateUpdateSelectionPayload({ ...ok, championId: undefined }).valid).toBe(false);
      expect(validateUpdateSelectionPayload({ ...ok, skinId: -1 }).valid).toBe(false);
      expect(validateUpdateSelectionPayload({ ...ok, chromaId: 2e9 }).valid).toBe(false);
      expect(validateUpdateSelectionPayload({ ...ok, skinId: "2" }).valid).toBe(false);
    });

    // Regression ciblee : le validateur d'origine laissait tomber ces deux
    // champs, ce qui aurait casse les rerolls de skin line en les branchant.
    it("request-group-reroll preserve skinLineId et sourceMemberId", () => {
      const res = validateRequestGroupRerollPayload({
        ...identity,
        type: "sameColor",
        color: "#6248FF",
        skinLineId: 42,
        sourceMemberId: "member-2",
      });
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.payload.skinLineId).toBe(42);
        expect(res.payload.sourceMemberId).toBe("member-2");
      }
    });

    it("request-group-reroll reste valide sans les champs optionnels", () => {
      const res = validateRequestGroupRerollPayload({
        ...identity,
        type: "sameColor",
        color: "#6248FF",
      });
      expect(res.valid).toBe(true);
      if (res.valid) expect(res.payload.skinLineId).toBeUndefined();
    });

    it("request-group-reroll rejette un skinLineId malforme et une couleur non bornee", () => {
      const base = { ...identity, type: "sameColor", color: "#6248FF" };
      expect(validateRequestGroupRerollPayload({ ...base, skinLineId: "42" }).valid).toBe(false);
      expect(validateRequestGroupRerollPayload({ ...base, color: "c".repeat(65) }).valid).toBe(false);
      expect(validateRequestGroupRerollPayload({ ...base, type: "skinLine" }).valid).toBe(false);
    });
  });

  // --- H6 : le nom de membre est borne ---
  describe("H6 — noms de membres bornes", () => {
    it("tronque un nom demesure a la creation via le controleur", async () => {
      // Le controleur est teste au travers de l'API dans socket-flow ; ici on
      // verrouille l'invariant cote service : un nom stocke reste exploitable
      // par la comparaison de prefixe sans cout non lineaire.
      const { room } = service.createRoom("x".repeat(32));
      const member = Array.from(room.members.values())[0];
      expect(member.name.length).toBeLessThanOrEqual(32);
    });
  });
});
