import type { Socket } from "socket.io";
import type { Room, Member } from "../types";
import { RoomService } from "../services/room.service";
import { logger } from "./logger";
import { AppError, formatErrorResponse, ErrorCodes } from "./errors";

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

/**
 * Wraps a Socket.io event handler with try-catch error handling.
 * Logs errors appropriately and emits error events to the client.
 *
 * @param eventName - The name of the Socket.io event (for logging)
 * @param handler - The handler function to wrap
 * @returns A wrapped handler function with error handling
 */
export function safeHandler<T>(
  eventName: string,
  handler: (payload: T, socket: Socket) => void | Promise<void>
): (payload: T, socket: Socket) => void {
  return (payload: T, socket: Socket) => {
    try {
      const result = handler(payload, socket);

      // Handle async handlers
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          handleError(eventName, error, payload, socket);
        });
      }
    } catch (error: unknown) {
      handleError(eventName, error, payload, socket);
    }
  };
}

/**
 * Internal function to handle errors consistently.
 */
function handleError<T>(
  eventName: string,
  error: unknown,
  payload: T,
  socket: Socket
): void {
  if (error instanceof AppError) {
    // Operational error - expected, log as warning
    logger.warn(`[${eventName}] ${error.message}`, {
      code: error.code,
      context: error.context,
      socketId: socket.id,
    });

    // Emit error to client
    socket.emit("error", formatErrorResponse(error));
  } else {
    // Programming error - unexpected, log as error with full context
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error(`[${eventName}] Unexpected error: ${errorMessage}`, {
      error: errorMessage,
      stack: errorStack,
      payload,
      socketId: socket.id,
    });

    // Emit generic error to client (don't expose internal details)
    socket.emit("error", {
      code: ErrorCodes.INTERNAL_ERROR,
      message: "An unexpected error occurred",
    });
  }
}
