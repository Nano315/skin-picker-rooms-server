import { Router } from "express";
import * as RoomController from "../controllers/room.controller";

const router = Router();

router.post("/", RoomController.createRoom);
router.post("/bot", RoomController.createBotRoom);
router.post("/join", RoomController.joinRoom);
router.post("/:code/bots", RoomController.addBots);

export default router;
