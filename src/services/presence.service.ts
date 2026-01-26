import type { Socket } from "socket.io";
import { logger } from "../utils/logger";

/**
 * Information stored for each connected user
 */
export interface ConnectionInfo {
  socketId: string;
  summonerName: string;
  connectedAt: Date;
}

/**
 * PresenceManager tracks which users are connected by PUUID.
 * Used to determine friend online status and route invitations.
 */
class PresenceManager {
  // PUUID -> ConnectionInfo
  private connections = new Map<string, ConnectionInfo>();

  // SocketId -> PUUID (reverse lookup)
  private socketToPuuid = new Map<string, string>();

  // PUUID -> friends list (stored during identify for offline notifications)
  private friendsMap = new Map<string, string[]>();

  /**
   * Register a user's presence after identity verification
   * @param socket - The socket instance
   * @param puuid - The user's PUUID
   * @param summonerName - The user's summoner name
   */
  identify(socket: Socket, puuid: string, summonerName: string): void {
    // Clean up any existing connection for this PUUID (reconnection case)
    const existingInfo = this.connections.get(puuid);
    if (existingInfo) {
      this.socketToPuuid.delete(existingInfo.socketId);
      logger.debug(`[presence] Replaced existing connection for ${puuid}`);
    }

    this.connections.set(puuid, {
      socketId: socket.id,
      summonerName,
      connectedAt: new Date(),
    });
    this.socketToPuuid.set(socket.id, puuid);

    // Join the user's personal room for targeted messaging
    socket.join(`user:${puuid}`);

    logger.info(`[presence] ${summonerName} (${puuid}) identified`);
  }

  /**
   * Handle user disconnection
   * @param socketId - The socket ID that disconnected
   * @returns The PUUID of the disconnected user, or null if not found
   */
  disconnect(socketId: string): string | null {
    const puuid = this.socketToPuuid.get(socketId);
    if (!puuid) {
      return null;
    }

    this.connections.delete(puuid);
    this.socketToPuuid.delete(socketId);
    this.friendsMap.delete(puuid);

    logger.info(`[presence] ${puuid} disconnected`);
    return puuid;
  }

  /**
   * Check if a user is currently online
   * @param puuid - The PUUID to check
   */
  isOnline(puuid: string): boolean {
    return this.connections.has(puuid);
  }

  /**
   * Get list of online friends from a list of PUUIDs
   * @param friendPuuids - Array of friend PUUIDs to check
   * @returns Array of PUUIDs that are currently online
   */
  getOnlineFriends(friendPuuids: string[]): string[] {
    return friendPuuids.filter((puuid) => this.isOnline(puuid));
  }

  /**
   * Get the socket ID for a user
   * @param puuid - The user's PUUID
   */
  getSocketId(puuid: string): string | null {
    return this.connections.get(puuid)?.socketId ?? null;
  }

  /**
   * Get the summoner name for a user
   * @param puuid - The user's PUUID
   */
  getSummonerName(puuid: string): string | null {
    return this.connections.get(puuid)?.summonerName ?? null;
  }

  /**
   * Get PUUID from socket ID (reverse lookup)
   * @param socketId - The socket ID
   */
  getPuuidBySocketId(socketId: string): string | null {
    return this.socketToPuuid.get(socketId) ?? null;
  }

  /**
   * Store the friends list for a user (for offline notifications)
   * @param puuid - The user's PUUID
   * @param friends - Array of friend PUUIDs
   */
  setFriends(puuid: string, friends: string[]): void {
    this.friendsMap.set(puuid, friends);
  }

  /**
   * Get the stored friends list for a user
   * @param puuid - The user's PUUID
   */
  getFriends(puuid: string): string[] | null {
    return this.friendsMap.get(puuid) ?? null;
  }

  /**
   * Get the connection info for a user
   * @param puuid - The user's PUUID
   */
  getConnectionInfo(puuid: string): ConnectionInfo | null {
    return this.connections.get(puuid) ?? null;
  }

  /**
   * Get total number of connected users (for monitoring)
   */
  getConnectionCount(): number {
    return this.connections.size;
  }
}

// Export singleton instance
export const presenceManager = new PresenceManager();
