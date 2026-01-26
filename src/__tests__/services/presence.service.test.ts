import { presenceManager } from "../../services/presence.service";

// Mock socket
const createMockSocket = (id: string) => ({
  id,
  join: jest.fn(),
  leave: jest.fn(),
});

describe("PresenceManager", () => {
  beforeEach(() => {
    // Reset the presenceManager state between tests
    // Since it's a singleton, we need to manually clear its maps
    // Access private members for testing
    (presenceManager as any).connections.clear();
    (presenceManager as any).socketToPuuid.clear();
    (presenceManager as any).friendsMap.clear();
  });

  describe("identify", () => {
    it("should track user after identify", () => {
      const mockSocket = createMockSocket("socket-1");

      presenceManager.identify(mockSocket as any, "puuid-123", "Player1");

      expect(presenceManager.isOnline("puuid-123")).toBe(true);
      expect(presenceManager.getSummonerName("puuid-123")).toBe("Player1");
      expect(presenceManager.getSocketId("puuid-123")).toBe("socket-1");
      expect(mockSocket.join).toHaveBeenCalledWith("user:puuid-123");
    });

    it("should replace existing connection on re-identify", () => {
      const mockSocket1 = createMockSocket("socket-1");
      const mockSocket2 = createMockSocket("socket-2");

      presenceManager.identify(mockSocket1 as any, "puuid-123", "Player1");
      presenceManager.identify(mockSocket2 as any, "puuid-123", "Player1-Reconnected");

      expect(presenceManager.isOnline("puuid-123")).toBe(true);
      expect(presenceManager.getSocketId("puuid-123")).toBe("socket-2");
      expect(presenceManager.getSummonerName("puuid-123")).toBe("Player1-Reconnected");
      // Old socket should be removed from reverse lookup
      expect(presenceManager.getPuuidBySocketId("socket-1")).toBeNull();
    });
  });

  describe("disconnect", () => {
    it("should cleanup after disconnect", () => {
      const mockSocket = createMockSocket("socket-1");
      presenceManager.identify(mockSocket as any, "puuid-123", "Player1");

      const result = presenceManager.disconnect("socket-1");

      expect(result).toBe("puuid-123");
      expect(presenceManager.isOnline("puuid-123")).toBe(false);
      expect(presenceManager.getSocketId("puuid-123")).toBeNull();
      expect(presenceManager.getPuuidBySocketId("socket-1")).toBeNull();
    });

    it("should return null for unknown socket", () => {
      const result = presenceManager.disconnect("unknown-socket");
      expect(result).toBeNull();
    });

    it("should cleanup friends list on disconnect", () => {
      const mockSocket = createMockSocket("socket-1");
      presenceManager.identify(mockSocket as any, "puuid-123", "Player1");
      presenceManager.setFriends("puuid-123", ["friend-1", "friend-2"]);

      presenceManager.disconnect("socket-1");

      expect(presenceManager.getFriends("puuid-123")).toBeNull();
    });
  });

  describe("getOnlineFriends", () => {
    it("should return only online friends", () => {
      const mockSocket1 = createMockSocket("socket-1");
      const mockSocket2 = createMockSocket("socket-2");

      presenceManager.identify(mockSocket1 as any, "puuid-1", "Player1");
      presenceManager.identify(mockSocket2 as any, "puuid-2", "Player2");

      const onlineFriends = presenceManager.getOnlineFriends([
        "puuid-1",
        "puuid-2",
        "puuid-3", // offline
      ]);

      expect(onlineFriends).toEqual(["puuid-1", "puuid-2"]);
    });

    it("should return empty array if no friends are online", () => {
      const onlineFriends = presenceManager.getOnlineFriends([
        "puuid-1",
        "puuid-2",
      ]);

      expect(onlineFriends).toEqual([]);
    });
  });

  describe("getPuuidBySocketId", () => {
    it("should return puuid for known socket", () => {
      const mockSocket = createMockSocket("socket-1");
      presenceManager.identify(mockSocket as any, "puuid-123", "Player1");

      expect(presenceManager.getPuuidBySocketId("socket-1")).toBe("puuid-123");
    });

    it("should return null for unknown socket", () => {
      expect(presenceManager.getPuuidBySocketId("unknown")).toBeNull();
    });
  });

  describe("friends management", () => {
    it("should store and retrieve friends list", () => {
      const mockSocket = createMockSocket("socket-1");
      presenceManager.identify(mockSocket as any, "puuid-123", "Player1");

      presenceManager.setFriends("puuid-123", ["friend-1", "friend-2", "friend-3"]);

      const friends = presenceManager.getFriends("puuid-123");
      expect(friends).toEqual(["friend-1", "friend-2", "friend-3"]);
    });

    it("should return null for user without friends set", () => {
      const mockSocket = createMockSocket("socket-1");
      presenceManager.identify(mockSocket as any, "puuid-123", "Player1");

      expect(presenceManager.getFriends("puuid-123")).toBeNull();
    });
  });

  describe("getConnectionCount", () => {
    it("should return correct connection count", () => {
      expect(presenceManager.getConnectionCount()).toBe(0);

      const mockSocket1 = createMockSocket("socket-1");
      const mockSocket2 = createMockSocket("socket-2");

      presenceManager.identify(mockSocket1 as any, "puuid-1", "Player1");
      expect(presenceManager.getConnectionCount()).toBe(1);

      presenceManager.identify(mockSocket2 as any, "puuid-2", "Player2");
      expect(presenceManager.getConnectionCount()).toBe(2);

      presenceManager.disconnect("socket-1");
      expect(presenceManager.getConnectionCount()).toBe(1);
    });
  });
});
