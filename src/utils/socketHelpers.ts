import type { Socket } from "socket.io";
import type { Room, Member } from "../types";
import { RoomService, verifyMemberToken } from "../services/room.service";
import { logger } from "./logger";
import { AppError, formatErrorResponse, ErrorCodes } from "./errors";

/**
 * Throws AppError(UNAUTHORIZED) if the provided token does not match the
 * member's stored secret. Use on every socket action that manipulates a member.
 */
export function assertMemberAuth(
  member: Member,
  providedToken: unknown,
  eventName: string
): void {
  if (!verifyMemberToken(member.token, providedToken)) {
    logger.warn(
      `[${eventName}] Rejected action: invalid memberToken for member ${member.id}`
    );
    throw new AppError(
      ErrorCodes.UNAUTHORIZED,
      "Invalid member token",
      true,
      { memberId: member.id }
    );
  }
}

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
 * Creates a safe handler factory bound to a specific socket.
 * Use this to wrap Socket.io event handlers with try-catch error handling.
 *
 * @param socket - The Socket.io socket instance
 * @returns A function that wraps handlers with error handling
 *
 * @example
 * io.on("connection", (socket) => {
 *   const safe = createSafeHandler(socket);
 *   socket.on("join-room", safe("join-room", (payload) => { ... }));
 * });
 */
export function createSafeHandler(socket: Socket) {
  return function safeHandler<T>(
    eventName: string,
    handler: (payload: T) => void | Promise<void>
  ): (payload: T) => void {
    return (payload: T) => {
      try {
        const result = handler(payload);

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
