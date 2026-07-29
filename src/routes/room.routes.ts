import { Router } from "express";
import * as RoomController from "../controllers/room.controller";

const router = Router();

router.post("/", RoomController.createRoom);
router.post("/join", RoomController.joinRoom);

// --- Helpers de test ---
// `createBotRoom` et `addBots` servent au simulateur et aux tests d'integration.
// Ils etaient montes en production, ou `addBots` offrait a tout owner de room
// une surface d'attaque supplementaire (construction d'une RegExp a partir du
// body). On ne les expose donc plus hors developpement/test.
if (process.env.NODE_ENV !== "production") {
  router.post("/bot", RoomController.createBotRoom);
  router.post("/:code/bots", RoomController.addBots);
}

export default router;
