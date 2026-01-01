import { Request, Response } from "express";
import { RoomService } from "../services/room.service";
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
      // @ts-ignore
      return res.status(result.status).json({ error: result.error });
    }

    const { room, member } = result;

    res.json({
      roomId: room.id,
      code: room.code,
      memberId: member.id,
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
    const rawCount = Number(body.count ?? 1);
    const count = Number.isFinite(rawCount) ? Math.max(1, Math.floor(rawCount)) : 1;

    const bots = roomService.addBots(room, count, body);

    logger.info(`Added ${bots.length} bots to room ${room.code}`);

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
