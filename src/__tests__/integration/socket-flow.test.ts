// Ensure we use real socket.io, not the mock
jest.unmock('socket.io');

import { httpServer, io } from '../../server';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import type { Server } from 'http';
import request from 'supertest';
import { RoomService } from '../../services/room.service';

describe('Socket.io Integration Flow', () => {
  let server: Server;
  let clientSocket1: ClientSocket;
  let clientSocket2: ClientSocket;
  let port: number;
  let roomCode: string;
  let roomId: string;
  let member1Id: string;
  let member2Id: string;
  let member1Token: string;
  let member2Token: string;

  beforeAll((done) => {
    server = httpServer.listen(0, () => {
      const address = server.address();
      if (typeof address === 'object' && address !== null) {
        port = address.port;
      }
      done();
    });
  });

  afterAll((done) => {
    io.close();
    server.close(done);
  });
  
  beforeEach(async () => {
    // Reset room service singleton for a clean state
    const roomService = RoomService.getInstance();
    (roomService as any).rooms.clear();
    (roomService as any).roomsByCode.clear();

    // 1. Create a room via HTTP
    const createRes = await request(httpServer)
      .post('/rooms')
      .send({ name: 'Owner' });
    
    expect(createRes.status).toBe(200);
    roomCode = createRes.body.room.code;
    roomId = createRes.body.room.id;
    member1Id = createRes.body.memberId;
    member1Token = createRes.body.memberToken;

    // 2. Join the room via HTTP
    const joinRes = await request(httpServer)
      .post('/rooms/join')
      .send({ code: roomCode, name: 'Player2' });

    expect(joinRes.status).toBe(200);
    member2Id = joinRes.body.memberId;
    member2Token = joinRes.body.memberToken;
  });

  afterEach(() => {
    clientSocket1?.disconnect();
    clientSocket2?.disconnect();
  });

  it('should reflect selection updates to other members in the room', (done) => {
    // Connect both clients to the socket server
    const client1Address = `http://localhost:${port}`;
    clientSocket1 = Client(client1Address, { forceNew: true });
    clientSocket2 = Client(client1Address, { forceNew: true });

    let connectedClients = 0;
    let updateSent = false;

    const onConnect = () => {
        connectedClients++;
        if (connectedClients === 2) {
            // Both clients are connected, now join rooms
            clientSocket1.emit('join-room', { roomId, memberId: member1Id, memberToken: member1Token });
            clientSocket2.emit('join-room', { roomId, memberId: member2Id, memberToken: member2Token });
        }
    };

    clientSocket1.on('connect', onConnect);
    clientSocket2.on('connect', onConnect);

    // Listen for room-state updates on client 2
    clientSocket2.on('room-state', (roomState) => {
      // Only check after we've sent the update
      if (!updateSent) return;

      try {
        const updatedMember = roomState.members.find((m: any) => m.id === member1Id);
        expect(updatedMember).toBeDefined();
        expect(updatedMember.skinId).toBe(123);
        expect(updatedMember.chromaId).toBe(456);
        done();
      } catch (error) {
        done(error);
      }
    });

    // After some time to ensure joins are processed, client 1 sends an update
    setTimeout(() => {
        updateSent = true;
        clientSocket1.emit('update-selection', {
            roomId,
            memberId: member1Id,
            memberToken: member1Token,
            skinId: 123,
            chromaId: 456,
        });
    }, 500); // Give time for server to process join events
  });

  it('should handle multiple members updating selections simultaneously', (done) => {
    const client1Address = `http://localhost:${port}`;
    clientSocket1 = Client(client1Address, { forceNew: true });
    clientSocket2 = Client(client1Address, { forceNew: true });

    let connectedClients = 0;
    let updateCount = 0;

    const onConnect = () => {
        connectedClients++;
        if (connectedClients === 2) {
            clientSocket1.emit('join-room', { roomId, memberId: member1Id, memberToken: member1Token });
            clientSocket2.emit('join-room', { roomId, memberId: member2Id, memberToken: member2Token });
        }
    };

    clientSocket1.on('connect', onConnect);
    clientSocket2.on('connect', onConnect);

    // Track updates received on client 1
    clientSocket1.on('room-state', (roomState) => {
      const m1 = roomState.members.find((m: any) => m.id === member1Id);
      const m2 = roomState.members.find((m: any) => m.id === member2Id);

      // Check if both members have updated their selections
      if (m1?.skinId === 111 && m2?.skinId === 222) {
        try {
          expect(m1.chromaId).toBe(1111);
          expect(m2.chromaId).toBe(2222);
          done();
        } catch (error) {
          done(error);
        }
      }
    });

    // Both clients send updates after joining
    setTimeout(() => {
        clientSocket1.emit('update-selection', {
            roomId,
            memberId: member1Id,
            memberToken: member1Token,
            skinId: 111,
            chromaId: 1111,
        });
        clientSocket2.emit('update-selection', {
            roomId,
            memberId: member2Id,
            memberToken: member2Token,
            skinId: 222,
            chromaId: 2222,
        });
    }, 500);
  });

  it('should allow non-owner client to rejoin after disconnect (while owner stays)', (done) => {
    const clientAddress = `http://localhost:${port}`;
    clientSocket1 = Client(clientAddress, { forceNew: true }); // Owner
    clientSocket2 = Client(clientAddress, { forceNew: true }); // Player2 (will disconnect/reconnect)

    let connectedClients = 0;
    let hasPlayer2Disconnected = false;

    const onConnect = () => {
      connectedClients++;
      if (connectedClients === 2) {
        // Both connected, have them join the room
        clientSocket1.emit('join-room', { roomId, memberId: member1Id, memberToken: member1Token });
        clientSocket2.emit('join-room', { roomId, memberId: member2Id, memberToken: member2Token });

        // After joining, disconnect player2 and have them rejoin via HTTP then socket
        setTimeout(() => {
          hasPlayer2Disconnected = true;
          clientSocket2.disconnect();

          // After disconnect, rejoin via HTTP (as new member) and socket
          setTimeout(async () => {
            const joinRes = await request(httpServer)
              .post('/rooms/join')
              .send({ code: roomCode, name: 'Player2Rejoined' });

            expect(joinRes.status).toBe(200);
            const newMemberId = joinRes.body.memberId;
            const newMemberToken = joinRes.body.memberToken;

            // Connect with new socket and join
            clientSocket2 = Client(clientAddress, { forceNew: true });
            clientSocket2.on('connect', () => {
              clientSocket2.emit('join-room', { roomId, memberId: newMemberId, memberToken: newMemberToken });
            });

            clientSocket2.on('room-state', (roomState) => {
              try {
                // Room should now have the owner and the rejoined player
                expect(roomState.members.length).toBeGreaterThanOrEqual(2);
                const rejoinedMember = roomState.members.find((m: any) => m.id === newMemberId);
                expect(rejoinedMember).toBeDefined();
                expect(rejoinedMember.name).toBe('Player2Rejoined');
                done();
              } catch (error) {
                done(error);
              }
            });
          }, 100);
        }, 300);
      }
    };

    clientSocket1.on('connect', onConnect);
    clientSocket2.on('connect', onConnect);
  }, 10000); // Increase timeout for reconnection test

  describe('suggest-color event (Bug Fix Story 1.1)', () => {
    it('should broadcast color-suggestion-received with correct memberId', (done) => {
      const clientAddress = `http://localhost:${port}`;
      clientSocket1 = Client(clientAddress, { forceNew: true }); // Owner
      clientSocket2 = Client(clientAddress, { forceNew: true }); // Player2 (suggester)

      let connectedClients = 0;

      const onConnect = () => {
        connectedClients++;
        if (connectedClients === 2) {
          clientSocket1.emit('join-room', { roomId, memberId: member1Id, memberToken: member1Token });
          clientSocket2.emit('join-room', { roomId, memberId: member2Id, memberToken: member2Token });
        }
      };

      clientSocket1.on('connect', onConnect);
      clientSocket2.on('connect', onConnect);

      // Owner listens for color suggestions
      clientSocket1.on('color-suggestion-received', (payload) => {
        try {
          // Verify payload structure and values
          expect(payload.memberId).toBe(member2Id); // Uses memberId, not senderId
          expect(payload.senderName).toBe('Player2');
          expect(payload.skinId).toBe(1001);
          expect(payload.chromaId).toBe(1001001);
          done();
        } catch (error) {
          done(error);
        }
      });

      // Player2 sends a color suggestion after joining
      setTimeout(() => {
        clientSocket2.emit('suggest-color', {
          roomId,
          memberId: member2Id,
          memberToken: member2Token,
          skinId: 1001,
          chromaId: 1001001,
        });
      }, 500);
    });

    it('should allow owner to receive their own suggestion', (done) => {
      const clientAddress = `http://localhost:${port}`;
      clientSocket1 = Client(clientAddress, { forceNew: true }); // Owner

      clientSocket1.on('connect', () => {
        clientSocket1.emit('join-room', { roomId, memberId: member1Id, memberToken: member1Token });
      });

      // Owner listens for color suggestions (including their own)
      clientSocket1.on('color-suggestion-received', (payload) => {
        try {
          expect(payload.memberId).toBe(member1Id);
          expect(payload.senderName).toBe('Owner');
          expect(payload.skinId).toBe(2002);
          expect(payload.chromaId).toBe(2002002);
          done();
        } catch (error) {
          done(error);
        }
      });

      // Owner sends their own suggestion (edge case)
      setTimeout(() => {
        clientSocket1.emit('suggest-color', {
          roomId,
          memberId: member1Id,
          memberToken: member1Token,
          skinId: 2002,
          chromaId: 2002002,
        });
      }, 500);
    });

    it('should include all required fields in color-suggestion-received payload', (done) => {
      const clientAddress = `http://localhost:${port}`;
      clientSocket1 = Client(clientAddress, { forceNew: true }); // Owner
      clientSocket2 = Client(clientAddress, { forceNew: true }); // Player2

      let connectedClients = 0;

      const onConnect = () => {
        connectedClients++;
        if (connectedClients === 2) {
          clientSocket1.emit('join-room', { roomId, memberId: member1Id, memberToken: member1Token });
          clientSocket2.emit('join-room', { roomId, memberId: member2Id, memberToken: member2Token });
        }
      };

      clientSocket1.on('connect', onConnect);
      clientSocket2.on('connect', onConnect);

      clientSocket1.on('color-suggestion-received', (payload) => {
        try {
          // Verify all required fields exist
          expect(payload).toHaveProperty('memberId');
          expect(payload).toHaveProperty('senderName');
          expect(payload).toHaveProperty('skinId');
          expect(payload).toHaveProperty('chromaId');

          // Verify correct types
          expect(typeof payload.memberId).toBe('string');
          expect(typeof payload.senderName).toBe('string');
          expect(typeof payload.skinId).toBe('number');
          expect(typeof payload.chromaId).toBe('number');

          done();
        } catch (error) {
          done(error);
        }
      });

      setTimeout(() => {
        clientSocket2.emit('suggest-color', {
          roomId,
          memberId: member2Id,
          memberToken: member2Token,
          skinId: 999,
          chromaId: 9999,
        });
      }, 500);
    });
  });



  describe('apply-skin-line-synergy (Story 6.6)', () => {
    it('should apply a skin line synergy and broadcast combo + room state', (done) => {
      const clientAddress = `http://localhost:${port}`;
      clientSocket1 = Client(clientAddress, { forceNew: true });
      clientSocket2 = Client(clientAddress, { forceNew: true });

      let connectedClients = 0;
      let applySent = false;

      const onConnect = () => {
        connectedClients++;
        if (connectedClients === 2) {
          clientSocket1.emit('join-room', { roomId, memberId: member1Id, memberToken: member1Token });
          clientSocket2.emit('join-room', { roomId, memberId: member2Id, memberToken: member2Token });
        }
      };

      clientSocket1.on('connect', onConnect);
      clientSocket2.on('connect', onConnect);

      // First, submit options with shared skin line
      setTimeout(() => {
        clientSocket1.emit('owned-options', {
          roomId,
          memberId: member1Id,
          memberToken: member1Token,
          championId: 1,
          championAlias: 'Ahri',
          options: [
            { skinId: 103015, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
          ],
        });
        clientSocket2.emit('owned-options', {
          roomId,
          memberId: member2Id,
          memberToken: member2Token,
          championId: 2,
          championAlias: 'Lux',
          options: [
            { skinId: 103017, chromaId: 0, auraColor: null, skinLineId: 10, skinLineName: 'Star Guardian' },
          ],
        });
      }, 500);

      // Wait for options processing + auto-apply cooldown, then apply skin line synergy
      setTimeout(() => {
        applySent = true;
        clientSocket1.emit('apply-skin-line-synergy', {
          roomId,
          memberId: member1Id,
          memberToken: member1Token,
          skinLineId: 10,
        });
      }, 2000);

      clientSocket2.on('group-apply-combo', (payload) => {
        if (!applySent) return; // Ignore auto-apply events
        try {
          expect(payload.picks).toBeDefined();
          expect(payload.picks.length).toBeGreaterThanOrEqual(2);
          done();
        } catch (error) {
          done(error);
        }
      });
    }, 10000);

    it('should reject apply-skin-line-synergy with invalid skinLineId', (done) => {
      const clientAddress = `http://localhost:${port}`;
      clientSocket1 = Client(clientAddress, { forceNew: true });

      clientSocket1.on('connect', () => {
        clientSocket1.emit('join-room', { roomId, memberId: member1Id, memberToken: member1Token });
      });

      clientSocket1.on('error', (payload) => {
        try {
          expect(payload.code).toBe('INVALID_PAYLOAD');
          done();
        } catch (error) {
          done(error);
        }
      });

      setTimeout(() => {
        clientSocket1.emit('apply-skin-line-synergy', {
          roomId,
          memberId: member1Id,
          memberToken: member1Token,
          skinLineId: 99999,
        });
      }, 500);
    });
  });

  describe('send-room-invite already_in_room check', () => {
    // Regression: the previous implementation compared Member.id (a random UUID
    // generated per room membership) against targetPuuid and never matched,
    // so users could be spammed with invites for rooms they were already in.
    // The fix resolves the target's current socket via the presence manager
    // and checks whether that socket is registered as a member of this room.

    it('should emit invite-failed with reason "already_in_room" when the invitee is already in the invited room', (done) => {
      const clientAddress = `http://localhost:${port}`;
      clientSocket1 = Client(clientAddress, { forceNew: true }); // inviter (owner)
      clientSocket2 = Client(clientAddress, { forceNew: true }); // target (already in room)

      // Distinct PUUIDs long enough to pass the server's length validation.
      const inviterPuuid = 'puuid-inviter-00000000000000000000';
      const targetPuuid = 'puuid-target-000000000000000000000';

      let connectedClients = 0;

      const onConnect = () => {
        connectedClients++;
        if (connectedClients < 2) return;

        // Identify both sockets so invites are routable, and mark them as
        // mutual friends so the check at step 2 passes.
        clientSocket1.emit('identify', {
          puuid: inviterPuuid,
          summonerName: 'Inviter',
          friends: [targetPuuid],
        });
        clientSocket2.emit('identify', {
          puuid: targetPuuid,
          summonerName: 'Target',
          friends: [inviterPuuid],
        });

        // Have both sockets join the room so socketToMember is populated.
        clientSocket1.emit('join-room', { roomId, memberId: member1Id, memberToken: member1Token });
        clientSocket2.emit('join-room', { roomId, memberId: member2Id, memberToken: member2Token });
      };

      clientSocket1.on('connect', onConnect);
      clientSocket2.on('connect', onConnect);

      clientSocket1.on('invite-failed', (payload) => {
        try {
          expect(payload.reason).toBe('already_in_room');
          done();
        } catch (error) {
          done(error);
        }
      });

      // Trigger the invite after the joins are processed.
      setTimeout(() => {
        clientSocket1.emit('send-room-invite', {
          targetPuuid,
          roomCode,
        });
      }, 500);
    });

    it('should emit invite-sent when the invitee is online but not in the invited room', (done) => {
      const clientAddress = `http://localhost:${port}`;
      clientSocket1 = Client(clientAddress, { forceNew: true }); // inviter (owner)
      clientSocket2 = Client(clientAddress, { forceNew: true }); // target (online, no room)

      const inviterPuuid = 'puuid-inviter-11111111111111111111';
      const targetPuuid = 'puuid-target-111111111111111111111';

      let connectedClients = 0;

      const onConnect = () => {
        connectedClients++;
        if (connectedClients < 2) return;

        clientSocket1.emit('identify', {
          puuid: inviterPuuid,
          summonerName: 'Inviter',
          friends: [targetPuuid],
        });
        clientSocket2.emit('identify', {
          puuid: targetPuuid,
          summonerName: 'Target',
          friends: [inviterPuuid],
        });

        // Only the inviter joins the room; the target stays outside.
        clientSocket1.emit('join-room', { roomId, memberId: member1Id, memberToken: member1Token });
      };

      clientSocket1.on('connect', onConnect);
      clientSocket2.on('connect', onConnect);

      clientSocket1.on('invite-failed', (payload) => {
        done(new Error(`Unexpected invite-failed: ${payload.reason}`));
      });

      clientSocket1.on('invite-sent', (payload) => {
        try {
          expect(payload.targetPuuid).toBe(targetPuuid);
          done();
        } catch (error) {
          done(error);
        }
      });

      setTimeout(() => {
        clientSocket1.emit('send-room-invite', {
          targetPuuid,
          roomCode,
        });
      }, 500);
    });
  });

});
