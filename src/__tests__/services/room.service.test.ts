import { RoomService } from '../../services/room.service';

describe('RoomService', () => {
  let service: RoomService;

  beforeEach(() => {
    service = RoomService.getInstance();
    // This is a bit of a hack to access a private member for testing
    // In a real scenario, you might have a public reset method for the singleton
    (service as any).rooms.clear();
    (service as any).roomsByCode.clear();
  });

  describe('createRoom', () => {
    it('should create a room with a valid 6-character alphanumeric code', () => {
      const { room } = service.createRoom('TestOwner');
      expect(room).toBeDefined();
      expect(room.code).toMatch(/^[A-Z0-9]{6}$/);
    });

    it('should create a room with one member, who is the owner', () => {
        const { room, member } = service.createRoom('TestOwner');
        expect(room.members.size).toBe(1);
        expect(room.ownerId).toBe(member.id);
        const ownerMember = room.members.get(member.id);
        expect(ownerMember).toBeDefined();
        expect(ownerMember?.name).toBe('TestOwner');
    });

    it('should store the room in the service maps', () => {
        const { room } = service.createRoom('TestOwner');
        expect(service.getRoom(room.id)).toBe(room);
        expect(service.getRoomByCode(room.code)).toBe(room);
    });

    it('should generate unique room codes', () => {
        const codes = new Set<string>();
        const iterationCount = 100;
        for (let i = 0; i < iterationCount; i++) {
            const { room } = service.createRoom(`Owner${i}`);
            codes.add(room.code);
        }
        expect(codes.size).toBe(iterationCount);
    });
  });

  describe('joinRoom', () => {
    it('should allow a member to join an existing, non-full room', () => {
      const { room: createdRoom } = service.createRoom('Owner');
      const result = service.joinRoom(createdRoom.code, 'Player2');

      // Check if it's a success response
      expect(result).toHaveProperty('room');
      expect(result).toHaveProperty('member');

      const { room, member } = result as { room: any, member: any };
      expect(room.id).toBe(createdRoom.id);
      expect(room.members.size).toBe(2);
      expect(room.members.get(member.id)).toBeDefined();
      expect(room.members.get(member.id)?.name).toBe('Player2');
    });

    it('should return an error when trying to join a non-existent room', () => {
        const result = service.joinRoom('BADCODE', 'Player2');
        expect(result).toHaveProperty('error');
        const errorResult = result as { error: string, status: number };
        expect(errorResult.error).toBe('Room not found');
        expect(errorResult.status).toBe(404);
    });

    it('should return an error when trying to join a full room', () => {
      const { room } = service.createRoom('Owner');
      // Fill the room (1 owner + 4 joins = 5 members)
      service.joinRoom(room.code, 'Player2');
      service.joinRoom(room.code, 'Player3');
      service.joinRoom(room.code, 'Player4');
      service.joinRoom(room.code, 'Player5');

      expect(room.members.size).toBe(5);

      const result = service.joinRoom(room.code, 'Player6');
      expect(result).toHaveProperty('error');
      const errorResult = result as { error: string, status: number };
      expect(errorResult.error).toBe('Room is full');
      expect(errorResult.status).toBe(403);
      expect(room.members.size).toBe(5); // Ensure no one was actually added
    });
  });

  describe('removeMember', () => {
    it('should remove a member from a room', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: member2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };
      expect(room.members.size).toBe(2);

      const result = service.removeMember(room, member2.id);

      expect(result.roomClosed).toBe(false);
      expect(room.members.size).toBe(1);
      expect(room.members.has(member2.id)).toBe(false);
    });

    it('should close the room if the owner leaves', () => {
        const { room, member: owner } = service.createRoom('Owner');
        service.joinRoom(room.code, 'Player2');
        expect(room.members.size).toBe(2);

        const result = service.removeMember(room, owner.id);

        expect(result.roomClosed).toBe(true);
        expect(result.reason).toBe('owner-left');
        expect(service.getRoom(room.id)).toBeUndefined();
        expect(service.getRoomByCode(room.code)).toBeUndefined();
    });

    it('should close the room if the last member leaves', () => {
        const { room, member: owner } = service.createRoom('Owner');
        expect(room.members.size).toBe(1);

        const result = service.removeMember(room, owner.id);
        
        expect(result.roomClosed).toBe(true);
        expect(result.reason).toBe('owner-left'); // In this case, owner is the last member
        expect(service.getRoom(room.id)).toBeUndefined();
        expect(service.getRoomByCode(room.code)).toBeUndefined();
    });
  });

  describe('getRoom', () => {
    it('should return a room by its ID', () => {
        const { room: createdRoom } = service.createRoom('Owner');
        const foundRoom = service.getRoom(createdRoom.id);
        expect(foundRoom).toBe(createdRoom);
    });

    it('should return undefined for a non-existent room ID', () => {
        const foundRoom = service.getRoom('non-existent-id');
        expect(foundRoom).toBeUndefined();
    });
  });

  describe('getRoomByCode', () => {
    it('should return a room by its code', () => {
        const { room: createdRoom } = service.createRoom('Owner');
        const foundRoom = service.getRoomByCode(createdRoom.code);
        expect(foundRoom).toBe(createdRoom);
    });

    it('should return undefined for a non-existent room code', () => {
        const foundRoom = service.getRoomByCode('BADCODE');
        expect(foundRoom).toBeUndefined();
    });
  });

  describe('createBotRoom', () => {
    it('should create a room with a bot owner', () => {
      const { room, member } = service.createBotRoom();

      expect(room).toBeDefined();
      expect(room.code).toMatch(/^[A-Z0-9]{6}$/);
      expect(member.name).toBe('Bot Owner');
      expect(member.isReady).toBe(true);
      expect(member.championId).toBeGreaterThan(0);
      expect(member.skinId).toBeGreaterThan(0);
    });
  });

  describe('addBots', () => {
    it('should add bots to a room', () => {
      const { room } = service.createRoom('Owner');
      expect(room.members.size).toBe(1);

      const bots = service.addBots(room, 2, { namePrefix: 'TestBot' });

      expect(bots).toHaveLength(2);
      expect(room.members.size).toBe(3);
      expect(bots[0].name).toBe('TestBot 2'); // First bot is added when room has 1 member
      expect(bots[1].name).toBe('TestBot 3');
      expect(bots[0].isReady).toBe(true);
    });

    it('should not exceed room capacity', () => {
      const { room } = service.createRoom('Owner');
      // Add 4 bots (room has 1 owner, max 5 members)
      service.addBots(room, 10, {}); // Try to add 10

      expect(room.members.size).toBe(5); // Should only have 5 total
    });

    it('should use custom config for bots', () => {
      const { room } = service.createRoom('Owner');
      const bots = service.addBots(room, 1, {
        championId: 123,
        skinId: 456,
        chromaId: 789
      });

      expect(bots[0].championId).toBe(123);
      expect(bots[0].skinId).toBe(456);
      expect(bots[0].chromaId).toBe(789);
    });
  });

  describe('recomputeSynergy', () => {
    it('should result in no synergies if no members have options', () => {
        const { room } = service.createRoom('Owner');
        service.joinRoom(room.code, 'Player2');
        service.recomputeSynergy(room);
        expect(room.synergy).toBeDefined();
        expect(room.synergy?.colors).toHaveLength(0);
    });

    it('should find a simple synergy between two members', () => {
        const { room, member: owner } = service.createRoom('Owner');
        const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

        // Add mock options
        owner.options = [{ skinId: 1, chromaId: 1, auraColor: 'Blue' }, { skinId: 2, chromaId: 2, auraColor: 'Red' }];
        player2.options = [{ skinId: 3, chromaId: 3, auraColor: 'Blue' }];
        
        service.recomputeSynergy(room);

        expect(room.synergy).toBeDefined();
        expect(room.synergy?.colors).toHaveLength(1);
        const blueSynergy = room.synergy?.colors[0];
        expect(blueSynergy?.color).toBe('Blue');
        expect(blueSynergy?.members).toEqual([owner.id, player2.id]);
        expect(blueSynergy?.combinationCount).toBe(1); // 1 blue option for owner * 1 for player2
    });

    it('should calculate combination count correctly', () => {
        const { room, member: owner } = service.createRoom('Owner');
        const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

        owner.options = [{ skinId: 1, chromaId: 1, auraColor: 'Blue' }, { skinId: 2, chromaId: 2, auraColor: 'Blue' }]; // 2 blue options
        player2.options = [{ skinId: 3, chromaId: 3, auraColor: 'Blue' }, { skinId: 4, chromaId: 4, auraColor: 'Blue' }, { skinId: 5, chromaId: 5, auraColor: 'Blue' }]; // 3 blue options
        
        service.recomputeSynergy(room);

        expect(room.synergy).toBeDefined();
        expect(room.synergy?.colors).toHaveLength(1);
        expect(room.synergy?.colors[0].color).toBe('Blue');
        expect(room.synergy?.colors[0].combinationCount).toBe(6); // 2 * 3
    });

    it('should only include members with the shared color in a synergy', () => {
        const { room, member: owner } = service.createRoom('Owner');
        const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };
        const { member: player3 } = service.joinRoom(room.code, 'Player3') as { room: any, member: any };

        owner.options = [{ skinId: 1, chromaId: 1, auraColor: 'Red' }];
        player2.options = [{ skinId: 3, chromaId: 3, auraColor: 'Blue' }];
        player3.options = [{ skinId: 5, chromaId: 5, auraColor: 'Red' }];

        service.recomputeSynergy(room);

        expect(room.synergy).toBeDefined();
        expect(room.synergy?.colors).toHaveLength(1); // Only Red synergy should be found
        const redSynergy = room.synergy?.colors[0];
        expect(redSynergy?.color).toBe('Red');
        expect(redSynergy?.members).toHaveLength(2);
        expect(redSynergy?.members).toContain(owner.id);
        expect(redSynergy?.members).toContain(player3.id);
        expect(redSynergy?.members).not.toContain(player2.id);
    });
  });
});
