import { Request, Response } from "express";
import { RoomService, verifyMemberToken } from "../services/room.service";
import { logger } from "../utils/logger";

const roomService = RoomService.getInstance();

export const createRoom = (req: Request, res: Response) => {
  try {
    const name = String(req.body?.name ?? "").trim() || "Player";
    const { room, member } = roomService.createRoom(name);

    res.json({
      roomId: room.id,
      code: room.code,
      memberId: member.id,
      memberToken: member.token,
      owner: true,
      room: roomService.serializeRoom(room),
    });
  } catch (err) {
    logger.error(`Error creating room: ${err}`);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export const createBotRoom = (req: Request, res: Response) => {
  try {
    const { room, member } = roomService.createBotRoom();

    res.json({
      roomId: room.id,
      code: room.code,
      memberId: member.id,
      memberToken: member.token,
      owner: false, // The requester is NOT the owner
      room: roomService.serializeRoom(room),
    });
  } catch (err) {
    logger.error(`Error creating bot room: ${err}`);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export const joinRoom = (req: Request, res: Response) => {
  try {
    const code = String(req.body?.code ?? "").trim().toUpperCase();
    const name = String(req.body?.name ?? "").trim() || "Player";

    const result = roomService.joinRoom(code, name);

    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const { room, member } = result;

    res.json({
      roomId: room.id,
      code: room.code,
      memberId: member.id,
      memberToken: member.token,
      owner: room.ownerId === member.id,
      room: roomService.serializeRoom(room),
    });
  } catch (err) {
    logger.error(`Error joining room: ${err}`);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export const addBots = (req: Request, res: Response) => {
  try {
    const rawCode = String(req.params.code ?? "").trim().toUpperCase();
    const room = roomService.getRoomByCode(rawCode);

    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    const body = req.body ?? {};

    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const memberToken = typeof body.memberToken === "string" ? body.memberToken : "";

    const requester = room.members.get(memberId);
    if (!requester) {
      logger.warn(`[addBots] Rejected: unknown member ${memberId} in room ${room.code}`);
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!verifyMemberToken(requester.token, memberToken)) {
      logger.warn(`[addBots] Rejected: invalid memberToken for ${memberId} in room ${room.code}`);
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (room.ownerId !== requester.id) {
      logger.warn(`[addBots] Rejected: ${requester.id} is not owner of room ${room.code}`);
      return res.status(403).json({ error: "Only the room owner can add bots" });
    }

    const rawCount = Number(body.count ?? 1);
    const count = Number.isFinite(rawCount) ? Math.max(1, Math.floor(rawCount)) : 1;

    const bots = roomService.addBots(room, count, body);

    logger.info(`Added ${bots.length} bots to room ${room.code} (by owner ${requester.id})`);

    res.json({
      ok: true,
      added: bots.length,
      room: roomService.serializeRoom(room),
      bots,
    });
  } catch (err) {
    logger.error(`Error adding bots: ${err}`);
    res.status(500).json({ error: "Internal Server Error" });
  }
};
