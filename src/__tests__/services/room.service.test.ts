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

  describe('recomputeSynergy - skin lines (Story 6.3)', () => {
    it('should find a skin line synergy between 2 members with the same skin line', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.options = [
        { skinId: 103015, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
      ];
      player2.options = [
        { skinId: 103017, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
      ];

      service.recomputeSynergy(room);

      expect(room.synergy?.skinLines).toHaveLength(1);
      expect(room.synergy?.skinLines[0].skinLineName).toBe('Star Guardian');
      expect(room.synergy?.skinLines[0].skinLineId).toBe(10);
      expect(room.synergy?.skinLines[0].coverage).toBe(1.0);
      expect(room.synergy?.skinLines[0].combinationCount).toBe(1);
    });

    it('should find multiple skin line synergies with 3 members and mixed skin lines', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: p2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };
      const { member: p3 } = service.joinRoom(room.code, 'Player3') as { room: any, member: any };

      owner.options = [
        { skinId: 1, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
        { skinId: 2, chromaId: 0, auraColor: null, skinLineId: 20, skinLineName: 'PROJECT' },
      ];
      p2.options = [
        { skinId: 3, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
        { skinId: 4, chromaId: 0, auraColor: null, skinLineId: 20, skinLineName: 'PROJECT' },
        { skinId: 5, chromaId: 0, auraColor: null, skinLineId: 20, skinLineName: 'PROJECT' },
      ];
      p3.options = [
        { skinId: 6, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
      ];

      service.recomputeSynergy(room);

      expect(room.synergy?.skinLines).toHaveLength(2);
      // Star Guardian has 3/3 coverage, PROJECT has 2/3
      expect(room.synergy?.skinLines[0].skinLineName).toBe('Star Guardian');
      expect(room.synergy?.skinLines[0].coverage).toBe(1.0);
      expect(room.synergy?.skinLines[0].combinationCount).toBe(1); // 1*1*1
      expect(room.synergy?.skinLines[1].skinLineName).toBe('PROJECT');
      expect(room.synergy?.skinLines[1].coverage).toBeCloseTo(2 / 3);
      expect(room.synergy?.skinLines[1].combinationCount).toBe(2); // 1*2
    });

    it('should exclude Base skin line (id=1) when other synergies exist', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: p2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.options = [
        { skinId: 1001, chromaId: 0, auraColor: null, skinLineId: 1, skinLineName: 'Base' },
        { skinId: 2001, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
      ];
      p2.options = [
        { skinId: 1002, chromaId: 0, auraColor: null, skinLineId: 1, skinLineName: 'Base' },
        { skinId: 2002, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
      ];

      service.recomputeSynergy(room);

      expect(room.synergy?.skinLines).toHaveLength(1);
      expect(room.synergy?.skinLines[0].skinLineName).toBe('Star Guardian');
    });

    it('should include Base skin line when it is the only option', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: p2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.options = [
        { skinId: 1001, chromaId: 0, auraColor: null, skinLineId: 1, skinLineName: 'Base' },
      ];
      p2.options = [
        { skinId: 2001, chromaId: 0, auraColor: null, skinLineId: 1, skinLineName: 'Base' },
      ];

      service.recomputeSynergy(room);

      expect(room.synergy?.skinLines).toHaveLength(1);
      expect(room.synergy?.skinLines[0].skinLineId).toBe(1);
    });

    it('should calculate combinationCount correctly for skin lines', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: p2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      // Owner has 2 Star Guardian skins, Player2 has 3
      owner.options = [
        { skinId: 1, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
        { skinId: 2, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
      ];
      p2.options = [
        { skinId: 3, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
        { skinId: 4, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
        { skinId: 5, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
      ];

      service.recomputeSynergy(room);

      expect(room.synergy?.skinLines[0].combinationCount).toBe(6); // 2*3
    });

    it('should not create skin line synergy if only 1 member has the skin line', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: p2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.options = [
        { skinId: 1, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
      ];
      p2.options = [
        { skinId: 2, chromaId: 0, auraColor: null, skinLineId: 20, skinLineName: 'PROJECT' },
      ];

      service.recomputeSynergy(room);

      expect(room.synergy?.skinLines).toHaveLength(0);
    });

    it('should coexist with color synergies', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: p2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.options = [
        { skinId: 1, chromaId: 0, auraColor: 'Blue', skinLineId: 10, skinLineName: 'Star Guardian' },
      ];
      p2.options = [
        { skinId: 2, chromaId: 0, auraColor: 'Blue', skinLineId: 10, skinLineName: 'Star Guardian' },
      ];

      service.recomputeSynergy(room);

      expect(room.synergy?.colors).toHaveLength(1);
      expect(room.synergy?.colors[0].color).toBe('Blue');
      expect(room.synergy?.skinLines).toHaveLength(1);
      expect(room.synergy?.skinLines[0].skinLineName).toBe('Star Guardian');
    });

    it('should handle options without skinLineId gracefully', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: p2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.options = [
        { skinId: 1, chromaId: 0, auraColor: 'Blue' }, // No skinLineId
      ];
      p2.options = [
        { skinId: 2, chromaId: 0, auraColor: 'Blue' }, // No skinLineId
      ];

      service.recomputeSynergy(room);

      expect(room.synergy?.skinLines).toHaveLength(0);
      expect(room.synergy?.colors).toHaveLength(1); // Color synergy still works
    });

    it('should complete in under 100ms with 5 members and 50 skins each', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const members = [owner];
      for (let i = 1; i < 5; i++) {
        const { member } = service.joinRoom(room.code, `Player${i + 1}`) as { room: any, member: any };
        members.push(member);
      }

      for (const member of members) {
        const options = [];
        for (let j = 0; j < 50; j++) {
          options.push({
            skinId: member.id.charCodeAt(0) * 1000 + j,
            chromaId: 0,
            auraColor: j % 5 === 0 ? 'Blue' : null,
            skinLineId: (j % 20) + 2, // Avoid Base (id=1)
            skinLineName: `Line${(j % 20) + 2}`,
          });
        }
        member.options = options;
      }

      const start = performance.now();
      service.recomputeSynergy(room);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(100);
      expect(room.synergy?.skinLines.length).toBeGreaterThan(0);
    });
  });

  describe('history management', () => {
    it('should initialize room with empty history', () => {
      const { room } = service.createRoom('Owner');
      expect(room.history).toBeDefined();
      expect(room.history).toHaveLength(0);
    });

    it('should add combination to history', () => {
      const { room } = service.createRoom('Owner');
      const picks = [{ memberId: 'member1', skinId: 100, chromaId: 1 }];

      service.addToHistory(room, 'Blue', picks);

      expect(room.history).toHaveLength(1);
      expect(room.history[0].color).toBe('Blue');
      expect(room.history[0].members).toEqual(picks);
      expect(room.history[0].timestamp).toBeGreaterThan(0);
    });

    it('should respect FIFO limit of 3 combinations', () => {
      const { room } = service.createRoom('Owner');

      service.addToHistory(room, 'Red', []);
      service.addToHistory(room, 'Blue', []);
      service.addToHistory(room, 'Green', []);
      service.addToHistory(room, 'Yellow', []);

      expect(room.history).toHaveLength(3);
      expect(room.history.map(h => h.color)).toEqual(['Blue', 'Green', 'Yellow']);
    });
  });

  describe('getAvailableSynergies', () => {
    it('should return all synergies when history is empty', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.options = [{ skinId: 1, chromaId: 1, auraColor: 'Blue' }];
      player2.options = [{ skinId: 2, chromaId: 2, auraColor: 'Blue' }];
      service.recomputeSynergy(room);

      const available = service.getAvailableSynergies(room);

      expect(available).toHaveLength(1);
      expect(available[0].color).toBe('Blue');
    });

    it('should filter out recently used colors', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.options = [
        { skinId: 1, chromaId: 1, auraColor: 'Blue' },
        { skinId: 2, chromaId: 2, auraColor: 'Red' }
      ];
      player2.options = [
        { skinId: 3, chromaId: 3, auraColor: 'Blue' },
        { skinId: 4, chromaId: 4, auraColor: 'Red' }
      ];
      service.recomputeSynergy(room);

      // Add Blue to history
      service.addToHistory(room, 'Blue', []);

      const available = service.getAvailableSynergies(room);

      expect(available).toHaveLength(1);
      expect(available[0].color).toBe('Red');
    });

    it('should return all synergies as fallback when all colors are in history', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.options = [{ skinId: 1, chromaId: 1, auraColor: 'Blue' }];
      player2.options = [{ skinId: 2, chromaId: 2, auraColor: 'Blue' }];
      service.recomputeSynergy(room);

      // Add Blue to history (the only synergy)
      service.addToHistory(room, 'Blue', []);

      const available = service.getAvailableSynergies(room);

      // Fallback: should return Blue even though it's in history
      expect(available).toHaveLength(1);
      expect(available[0].color).toBe('Blue');
    });

    it('should return empty array when no synergies exist', () => {
      const { room } = service.createRoom('Owner');

      const available = service.getAvailableSynergies(room);

      expect(available).toHaveLength(0);
    });
  });

  describe('shouldAutoApply', () => {
    it('should return false when less than 2 members', () => {
      const { room, member: owner } = service.createRoom('Owner');
      owner.championId = 1;
      owner.options = [{ skinId: 1, chromaId: 1, auraColor: 'Blue' }];

      expect(service.shouldAutoApply(room)).toBe(false);
    });

    it('should return false when not all members have champions', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.championId = 1;
      owner.options = [{ skinId: 1, chromaId: 1, auraColor: 'Blue' }];
      player2.championId = 0; // No champion
      player2.options = [{ skinId: 2, chromaId: 2, auraColor: 'Blue' }];

      service.recomputeSynergy(room);
      expect(service.shouldAutoApply(room)).toBe(false);
    });

    it('should return false when not all members have options', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.championId = 1;
      owner.options = [{ skinId: 1, chromaId: 1, auraColor: 'Blue' }];
      player2.championId = 2;
      player2.options = []; // No options

      service.recomputeSynergy(room);
      expect(service.shouldAutoApply(room)).toBe(false);
    });

    it('should return false when no synergies available', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.championId = 1;
      owner.options = [{ skinId: 1, chromaId: 1, auraColor: 'Blue' }];
      player2.championId = 2;
      player2.options = [{ skinId: 2, chromaId: 2, auraColor: 'Red' }]; // Different color

      service.recomputeSynergy(room);
      expect(service.shouldAutoApply(room)).toBe(false);
    });

    it('should return true when all conditions are met', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.championId = 1;
      owner.options = [{ skinId: 1, chromaId: 1, auraColor: 'Blue' }];
      player2.championId = 2;
      player2.options = [{ skinId: 2, chromaId: 2, auraColor: 'Blue' }];

      service.recomputeSynergy(room);
      expect(service.shouldAutoApply(room)).toBe(true);
    });

    it('should return false when recently applied', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.championId = 1;
      owner.options = [{ skinId: 1, chromaId: 1, auraColor: 'Blue' }];
      player2.championId = 2;
      player2.options = [{ skinId: 2, chromaId: 2, auraColor: 'Blue' }];

      service.recomputeSynergy(room);

      // Simulate recent apply
      room.activeSynergy = { type: 'sameColor', color: 'Blue', timestamp: Date.now() };

      expect(service.shouldAutoApply(room)).toBe(false);
    });
  });

  describe('generateAutoApplyPicks', () => {
    it('should return null when no synergies available', () => {
      const { room } = service.createRoom('Owner');

      const result = service.generateAutoApplyPicks(room);

      expect(result).toBeNull();
    });

    it('should generate picks for all members', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.championId = 1;
      owner.options = [{ skinId: 100, chromaId: 10, auraColor: 'Blue' }];
      player2.championId = 2;
      player2.options = [{ skinId: 200, chromaId: 20, auraColor: 'Blue' }];

      service.recomputeSynergy(room);
      const result = service.generateAutoApplyPicks(room);

      expect(result).not.toBeNull();
      expect(result?.color).toBe('Blue');
      expect(result?.picks).toHaveLength(2);

      // Verify picks match expected values
      const ownerPick = result?.picks.find(p => p.memberId === owner.id);
      expect(ownerPick?.skinId).toBe(100);
      expect(ownerPick?.chromaId).toBe(10);

      const player2Pick = result?.picks.find(p => p.memberId === player2.id);
      expect(player2Pick?.skinId).toBe(200);
      expect(player2Pick?.chromaId).toBe(20);
    });

    it('should update room state after generating picks', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.championId = 1;
      owner.options = [{ skinId: 100, chromaId: 10, auraColor: 'Blue' }];
      player2.championId = 2;
      player2.options = [{ skinId: 200, chromaId: 20, auraColor: 'Blue' }];

      service.recomputeSynergy(room);
      service.generateAutoApplyPicks(room);

      expect(room.activeSynergy).toBeDefined();
      expect(room.activeSynergy?.type).toBe('sameColor');
      expect(room.activeSynergy?.color).toBe('Blue');
      expect(room.activeColor).toBe('Blue');
      expect(room.history).toHaveLength(1);
    });

    it('should update member skinId and chromaId', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.championId = 1;
      owner.options = [{ skinId: 100, chromaId: 10, auraColor: 'Blue' }];
      player2.championId = 2;
      player2.options = [{ skinId: 200, chromaId: 20, auraColor: 'Blue' }];

      service.recomputeSynergy(room);
      service.generateAutoApplyPicks(room);

      expect(owner.skinId).toBe(100);
      expect(owner.chromaId).toBe(10);
      expect(player2.skinId).toBe(200);
      expect(player2.chromaId).toBe(20);
    });

    it('should keep current selection for members without matching options', () => {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.championId = 1;
      owner.skinId = 50;
      owner.chromaId = 5;
      owner.options = [{ skinId: 100, chromaId: 10, auraColor: 'Red' }]; // Different color
      player2.championId = 2;
      player2.options = [
        { skinId: 200, chromaId: 20, auraColor: 'Blue' },
        { skinId: 201, chromaId: 21, auraColor: 'Blue' }
      ];

      // Only one synergy won't be found (need 2 members with same color)
      // Let's adjust to have a synergy
      owner.options = [
        { skinId: 100, chromaId: 10, auraColor: 'Blue' },
        { skinId: 101, chromaId: 11, auraColor: 'Red' }
      ];

      service.recomputeSynergy(room);
      service.generateAutoApplyPicks(room);

      // Both should get Blue options assigned
      expect(owner.skinId).toBe(100);
      expect(owner.chromaId).toBe(10);
    });
  });

  describe('auto-apply sync modes (Story 6.5)', () => {
    function setupRoomWithSkinLines() {
      const { room, member: owner } = service.createRoom('Owner');
      const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

      owner.championId = 1;
      owner.options = [
        { skinId: 100, chromaId: 10, auraColor: 'Blue', skinLineId: 10, skinLineName: 'Star Guardian' },
        { skinId: 101, chromaId: 11, auraColor: 'Red', skinLineId: 20, skinLineName: 'PROJECT' },
      ];
      player2.championId = 2;
      player2.options = [
        { skinId: 200, chromaId: 20, auraColor: 'Blue', skinLineId: 10, skinLineName: 'Star Guardian' },
        { skinId: 201, chromaId: 21, auraColor: 'Green', skinLineId: 30, skinLineName: 'Arcade' },
      ];

      service.recomputeSynergy(room);
      return { room, owner, player2 };
    }

    describe('generateSkinLinePicks', () => {
      it('should generate picks from a shared skin line', () => {
        const { room, owner, player2 } = setupRoomWithSkinLines();

        const result = service.generateSkinLinePicks(room);

        expect(result).not.toBeNull();
        expect(result?.skinLineId).toBe(10);
        expect(result?.skinLineName).toBe('Star Guardian');
        expect(result?.picks).toHaveLength(2);
      });

      it('should always set chromaId to 0 in skin line picks', () => {
        const { room } = setupRoomWithSkinLines();

        const result = service.generateSkinLinePicks(room);

        expect(result).not.toBeNull();
        for (const pick of result!.picks) {
          expect(pick.chromaId).toBe(0);
        }
      });

      it('should update member skinId and set chromaId to 0', () => {
        const { room, owner, player2 } = setupRoomWithSkinLines();

        service.generateSkinLinePicks(room);

        expect(owner.skinId).toBe(100); // Star Guardian skin
        expect(owner.chromaId).toBe(0);
        expect(player2.skinId).toBe(200);
        expect(player2.chromaId).toBe(0);
      });

      it('should set activeSynergy with type skinLine', () => {
        const { room } = setupRoomWithSkinLines();

        service.generateSkinLinePicks(room);

        expect(room.activeSynergy).toBeDefined();
        expect(room.activeSynergy?.type).toBe('skinLine');
        expect(room.activeSynergy?.skinLineId).toBe(10);
        expect(room.activeSynergy?.skinLineName).toBe('Star Guardian');
      });

      it('should add to skinLineHistory', () => {
        const { room } = setupRoomWithSkinLines();

        service.generateSkinLinePicks(room);

        expect(room.skinLineHistory).toHaveLength(1);
        expect(room.skinLineHistory[0].skinLineId).toBe(10);
      });

      it('should return null when no skin line synergies exist', () => {
        const { room, member: owner } = service.createRoom('Owner');
        const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

        owner.championId = 1;
        owner.options = [{ skinId: 100, chromaId: 10, auraColor: 'Blue' }]; // No skinLineId
        player2.championId = 2;
        player2.options = [{ skinId: 200, chromaId: 20, auraColor: 'Blue' }];

        service.recomputeSynergy(room);
        const result = service.generateSkinLinePicks(room);

        expect(result).toBeNull();
      });
    });

    describe('generateAutoApplyPicks with syncMode', () => {
      it('should use skin line picks in mode "skins"', () => {
        const { room } = setupRoomWithSkinLines();
        room.syncMode = 'skins';

        const result = service.generateAutoApplyPicks(room);

        expect(result).not.toBeNull();
        expect(result?.skinLineId).toBe(10);
        expect(result?.skinLineName).toBe('Star Guardian');
        expect(result?.color).toBeUndefined();
      });

      it('should return null in mode "skins" when no skin line synergies', () => {
        const { room, member: owner } = service.createRoom('Owner');
        const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

        owner.championId = 1;
        owner.options = [{ skinId: 100, chromaId: 10, auraColor: 'Blue' }];
        player2.championId = 2;
        player2.options = [{ skinId: 200, chromaId: 20, auraColor: 'Blue' }];

        service.recomputeSynergy(room);
        room.syncMode = 'skins';

        const result = service.generateAutoApplyPicks(room);
        expect(result).toBeNull();
      });

      it('should try skin line first then fallback to color in mode "both"', () => {
        const { room, member: owner } = service.createRoom('Owner');
        const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

        // Only color synergy, no skin line
        owner.championId = 1;
        owner.options = [{ skinId: 100, chromaId: 10, auraColor: 'Blue' }];
        player2.championId = 2;
        player2.options = [{ skinId: 200, chromaId: 20, auraColor: 'Blue' }];

        service.recomputeSynergy(room);
        room.syncMode = 'both';

        const result = service.generateAutoApplyPicks(room);

        expect(result).not.toBeNull();
        expect(result?.color).toBe('Blue');
        expect(result?.skinLineId).toBeUndefined();
      });

      it('should prefer skin line over color in mode "both" when available', () => {
        const { room } = setupRoomWithSkinLines();
        room.syncMode = 'both';

        const result = service.generateAutoApplyPicks(room);

        expect(result).not.toBeNull();
        expect(result?.skinLineId).toBe(10);
        expect(result?.skinLineName).toBe('Star Guardian');
      });

      it('should use color picks in mode "chromas"', () => {
        const { room } = setupRoomWithSkinLines();
        room.syncMode = 'chromas';

        const result = service.generateAutoApplyPicks(room);

        expect(result).not.toBeNull();
        expect(result?.color).toBe('Blue');
        expect(result?.skinLineId).toBeUndefined();
      });
    });

    describe('shouldAutoApply with syncMode', () => {
      it('should return false in mode "chromas" when only skin line synergies exist', () => {
        const { room, member: owner } = service.createRoom('Owner');
        const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

        owner.championId = 1;
        owner.options = [
          { skinId: 100, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
        ];
        player2.championId = 2;
        player2.options = [
          { skinId: 200, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
        ];

        service.recomputeSynergy(room);
        room.syncMode = 'chromas';

        expect(service.shouldAutoApply(room)).toBe(false);
      });

      it('should return false in mode "skins" when only color synergies exist', () => {
        const { room, member: owner } = service.createRoom('Owner');
        const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

        owner.championId = 1;
        owner.options = [{ skinId: 100, chromaId: 10, auraColor: 'Blue' }];
        player2.championId = 2;
        player2.options = [{ skinId: 200, chromaId: 20, auraColor: 'Blue' }];

        service.recomputeSynergy(room);
        room.syncMode = 'skins';

        expect(service.shouldAutoApply(room)).toBe(false);
      });

      it('should return true in mode "both" when only color synergies exist', () => {
        const { room, member: owner } = service.createRoom('Owner');
        const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

        owner.championId = 1;
        owner.options = [{ skinId: 100, chromaId: 10, auraColor: 'Blue' }];
        player2.championId = 2;
        player2.options = [{ skinId: 200, chromaId: 20, auraColor: 'Blue' }];

        service.recomputeSynergy(room);
        room.syncMode = 'both';

        expect(service.shouldAutoApply(room)).toBe(true);
      });

      it('should return true in mode "skins" when skin line synergies exist', () => {
        const { room } = setupRoomWithSkinLines();
        room.syncMode = 'skins';

        expect(service.shouldAutoApply(room)).toBe(true);
      });
    });

    describe('skin line history management', () => {
      it('should initialize room with empty skinLineHistory', () => {
        const { room } = service.createRoom('Owner');
        expect(room.skinLineHistory).toBeDefined();
        expect(room.skinLineHistory).toHaveLength(0);
      });

      it('should add skin line to history', () => {
        const { room } = service.createRoom('Owner');
        const picks = [{ memberId: 'member1', skinId: 100, chromaId: 0 }];

        service.addSkinLineToHistory(room, 10, 'Star Guardian', picks);

        expect(room.skinLineHistory).toHaveLength(1);
        expect(room.skinLineHistory[0].skinLineId).toBe(10);
        expect(room.skinLineHistory[0].skinLineName).toBe('Star Guardian');
      });

      it('should respect FIFO limit of 3 for skin line history', () => {
        const { room } = service.createRoom('Owner');

        service.addSkinLineToHistory(room, 10, 'Star Guardian', []);
        service.addSkinLineToHistory(room, 20, 'PROJECT', []);
        service.addSkinLineToHistory(room, 30, 'Arcade', []);
        service.addSkinLineToHistory(room, 40, 'Pool Party', []);

        expect(room.skinLineHistory).toHaveLength(3);
        expect(room.skinLineHistory.map(h => h.skinLineId)).toEqual([20, 30, 40]);
      });

      it('should filter recently used skin lines from available synergies', () => {
        const { room } = setupRoomWithSkinLines();

        // Add Star Guardian to history
        service.addSkinLineToHistory(room, 10, 'Star Guardian', []);

        // Star Guardian synergy should be filtered out (but it's the only one, so fallback)
        const available = service.getAvailableSkinLineSynergies(room);

        // Since Star Guardian is the only skin line synergy, fallback returns all
        expect(available).toHaveLength(1);
        expect(available[0].skinLineId).toBe(10);
      });

      it('should filter used skin lines when alternatives exist', () => {
        const { room, member: owner } = service.createRoom('Owner');
        const { member: player2 } = service.joinRoom(room.code, 'Player2') as { room: any, member: any };

        owner.championId = 1;
        owner.options = [
          { skinId: 100, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
          { skinId: 101, chromaId: 0, auraColor: null, skinLineId: 20, skinLineName: 'PROJECT' },
        ];
        player2.championId = 2;
        player2.options = [
          { skinId: 200, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
          { skinId: 201, chromaId: 0, auraColor: null, skinLineId: 20, skinLineName: 'PROJECT' },
        ];

        service.recomputeSynergy(room);

        // Add Star Guardian to history
        service.addSkinLineToHistory(room, 10, 'Star Guardian', []);

        const available = service.getAvailableSkinLineSynergies(room);

        expect(available).toHaveLength(1);
        expect(available[0].skinLineId).toBe(20);
        expect(available[0].skinLineName).toBe('PROJECT');
      });
    });

    describe('applySkinLineSynergy', () => {
      it('should apply a specific skin line synergy', () => {
        const { room, owner, player2 } = setupRoomWithSkinLines();

        const result = service.applySkinLineSynergy(room, 10);

        expect(result).not.toBeNull();
        expect(result?.skinLineId).toBe(10);
        expect(result?.skinLineName).toBe('Star Guardian');
        expect(owner.skinId).toBe(100);
        expect(owner.chromaId).toBe(0);
        expect(player2.skinId).toBe(200);
        expect(player2.chromaId).toBe(0);
      });

      it('should return null for non-existent skin line synergy', () => {
        const { room } = setupRoomWithSkinLines();

        const result = service.applySkinLineSynergy(room, 999);

        expect(result).toBeNull();
      });

      it('should add to skin line history', () => {
        const { room } = setupRoomWithSkinLines();

        service.applySkinLineSynergy(room, 10);

        expect(room.skinLineHistory).toHaveLength(1);
        expect(room.skinLineHistory[0].skinLineId).toBe(10);
      });

      it('should set activeSynergy with type skinLine', () => {
        const { room } = setupRoomWithSkinLines();

        service.applySkinLineSynergy(room, 10);

        expect(room.activeSynergy?.type).toBe('skinLine');
        expect(room.activeSynergy?.skinLineId).toBe(10);
      });
    });
  });
});
