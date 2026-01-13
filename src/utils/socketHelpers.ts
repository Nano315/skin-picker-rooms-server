import type { Room, Member } from "../types";
import { RoomService } from "../services/room.service";
import { logger } from "./logger";

/**
 * Gets a room by ID, logging a warning if not found.
 * @returns The room if found, null otherwise.
 */
export function getRoomOrWarn(
  roomService: RoomService,
  roomId: string,
  eventName: string
): Room | null {
  const room = roomService.getRoom(roomId);
  if (!room) {
    logger.warn(`[${eventName}] room ${roomId} not found`);
    return null;
  }
  return room;
}

/**
 * Gets a member from a room by ID, logging a warning if not found.
 * @returns The member if found, null otherwise.
 */
export function getMemberOrWarn(
  room: Room,
  memberId: string,
  eventName: string
): Member | null {
  const member = room.members.get(memberId);
  if (!member) {
    logger.warn(`[${eventName}] member ${memberId} not found in room ${room.id}`);
    return null;
  }
  return member;
}

/**
 * Gets both room and member, logging warnings if either is not found.
 * Convenience function combining getRoomOrWarn and getMemberOrWarn.
 * @returns Object with room and member, or null values if not found.
 */
export function getRoomAndMemberOrWarn(
  roomService: RoomService,
  roomId: string,
  memberId: string,
  eventName: string
): { room: Room | null; member: Member | null } {
  const room = getRoomOrWarn(roomService, roomId, eventName);
  if (!room) {
    return { room: null, member: null };
  }
  const member = getMemberOrWarn(room, memberId, eventName);
  return { room, member };
}
