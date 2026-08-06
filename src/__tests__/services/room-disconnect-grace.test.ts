import { RoomService } from "../../services/room.service";
import type { Room, Member } from "../../types";

/**
 * Sursis de reconnexion.
 *
 * Avant, une chute de socket retirait le membre immediatement : une coupure
 * Wi-Fi d'une seconde en plein champion select transferait la propriete ou
 * fermait la room, et le client qui se reconnectait recevait MEMBER_NOT_FOUND.
 * Paradoxe complet : un membre qui ne s'etait JAMAIS connecte avait 2 minutes
 * de sursis, celui qui jouait depuis 20 minutes n'en avait aucune.
 *
 * Le sursis vaut 90 s (DISCONNECT_GRACE_MS, prive au service) : les tests
 * pilotent donc `sweep(now)` avec un horodatage injecte plutot que des timers.
 */
const GRACE_MS = 90 * 1000;

describe("RoomService — sursis de reconnexion", () => {
  let service: RoomService;

  beforeEach(() => {
    service = RoomService.getInstance();
    (service as any).rooms.clear();
    (service as any).roomsByCode.clear();
  });

  /** Room a deux membres, tous deux consideres connectes. */
  function roomWithTwoMembers(): {
    room: Room;
    owner: Member;
    player: Member;
  } {
    const { room, member: owner } = service.createRoom("Owner");
    const joined = service.joinRoom(room.code, "Player") as {
      room: Room;
      member: Member;
    };
    service.markMemberConnected(room, owner.id);
    service.markMemberConnected(room, joined.member.id);
    return { room, owner, player: joined.member };
  }

  it("garde le membre dans la room pendant le sursis", () => {
    const { room, player } = roomWithTwoMembers();

    expect(service.markMemberDisconnected(room, player.id)).toBe(true);
    expect(room.members.has(player.id)).toBe(true);

    // Juste avant l'expiration : toujours la.
    const { membersEvicted } = service.sweep(Date.now() + GRACE_MS - 1000);
    expect(membersEvicted).toBe(0);
    expect(room.members.has(player.id)).toBe(true);
  });

  it("retire le membre une fois le sursis expire", () => {
    const { room, player } = roomWithTwoMembers();
    service.markMemberDisconnected(room, player.id);

    const { membersEvicted, changedRoomIds } = service.sweep(
      Date.now() + GRACE_MS + 1000
    );

    expect(membersEvicted).toBe(1);
    expect(room.members.has(player.id)).toBe(false);
    // La room survit et doit etre rediffusee aux membres restants.
    expect(changedRoomIds).toContain(room.id);
  });

  it("annule le sursis si le membre se reconnecte a temps", () => {
    const { room, player } = roomWithTwoMembers();
    service.markMemberDisconnected(room, player.id);

    // Reconnexion avant expiration.
    service.markMemberConnected(room, player.id);

    const { membersEvicted } = service.sweep(Date.now() + GRACE_MS + 1000);
    expect(membersEvicted).toBe(0);
    expect(room.members.has(player.id)).toBe(true);
  });

  it("ne transfere pas la propriete tant que le proprietaire peut revenir", () => {
    const { room, owner, player } = roomWithTwoMembers();

    service.markMemberDisconnected(room, owner.id);
    service.sweep(Date.now() + GRACE_MS - 1000);

    expect(room.ownerId).toBe(owner.id);
    expect(room.members.has(player.id)).toBe(true);
  });

  it("transfere la propriete quand le proprietaire ne revient pas", () => {
    const { room, owner, player } = roomWithTwoMembers();

    service.markMemberDisconnected(room, owner.id);
    service.sweep(Date.now() + GRACE_MS + 1000);

    expect(room.members.has(owner.id)).toBe(false);
    expect(room.ownerId).toBe(player.id);
  });

  it("ferme la room quand le dernier membre ne revient pas", () => {
    const { room, member: solo } = service.createRoom("Solo");
    service.markMemberConnected(room, solo.id);
    service.markMemberDisconnected(room, solo.id);

    const { roomsClosed } = service.sweep(Date.now() + GRACE_MS + 1000);

    expect(roomsClosed).toBe(1);
    expect(service.getRoom(room.id)).toBeUndefined();
  });

  it("ignore un membre inconnu", () => {
    const { room } = roomWithTwoMembers();
    expect(service.markMemberDisconnected(room, "membre-inexistant")).toBe(false);
  });

  it("purge le sursis quand le membre part volontairement", () => {
    const { room, player } = roomWithTwoMembers();

    service.markMemberDisconnected(room, player.id);
    // `leave-room` reste immediat : c'est une action deliberee.
    service.removeMember(room, player.id);

    expect(room.members.has(player.id)).toBe(false);
    expect(room.disconnectedMembers.has(player.id)).toBe(false);

    // Le balayage ne doit pas recompter ce membre comme evince.
    const { membersEvicted } = service.sweep(Date.now() + GRACE_MS + 1000);
    expect(membersEvicted).toBe(0);
  });

  it("ne signale aucune room a rediffuser quand rien ne bouge", () => {
    roomWithTwoMembers();
    const { changedRoomIds, closedRoomIds } = service.sweep(Date.now());
    expect(changedRoomIds).toHaveLength(0);
    expect(closedRoomIds).toHaveLength(0);
  });
});
