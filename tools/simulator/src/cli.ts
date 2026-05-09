/**
 * SkinPicker socket simulator — interactive CLI.
 *
 * Spawns one or more fake players that talk the real Socket.IO + REST API
 * of `SkinPicker-Back`. Two design principles:
 *
 *  1. Behaviour mirrors a real LCU-backed player. A freshly-spawned client
 *     joins the room in **lobby** state — no champion, no skin, no
 *     `owned-options`. The user explicitly drives transitions to
 *     champion-select, just like a real player would by pressing "lock"
 *     in the LoL client. This avoids the previous footgun where every
 *     fake player auto-appeared as ready/in-draft and the operator could
 *     trigger group rerolls without their own client being in champ select.
 *
 *  2. No raw IDs / hex codes / rgba strings to remember. Every choice
 *     (champion, skin line, color, skin/chroma, member to kick) goes
 *     through an interactive picker that lists what is available now,
 *     with previews where it makes sense.
 */

import * as readline from "readline";
import { FakeClient } from "./fake-client";
import {
  AskFn,
  pickChampion,
  pickColorSynergy,
  pickRoomCode,
  pickRoomMember,
  pickSkinAndChromaFromOptions,
  pickSkinLineSynergy,
} from "./pickers";
import { pickOptimalChampions } from "./auto-draft";
import { fetchChampionAlias } from "./cdragon.service";

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

const clients: FakeClient[] = [];
let clientCounter = 1;

let rl: readline.Interface;
let currentPromptText = "";

// ---------------------------------------------------------------------------
// Draft orchestrator
// ---------------------------------------------------------------------------

/**
 * Serializes auto-follow picks across all fakes. Each FakeClient calls
 * `requestPick(client)` from its `autoPickRequester` hook; the orchestrator
 * processes the queue strictly sequentially, with a 1-second gap between
 * the end of one pick and the start of the next.
 *
 * Why centralized:
 *  - Per-fake random staggers don't reliably produce 4 different champions
 *    when 4 fakes fire on the same room-state event (they read identical
 *    `latestRoomState` snapshots, so each computes the same optimal pick).
 *  - Sequencing them serially means the 2nd fake processes its pick AFTER
 *    the 1st has emitted `update-selection`, so the server has already
 *    broadcast a fresh room-state with fake1's champion locked. Fake2's
 *    `latestRoomState` excludes fake1's choice, picks something different,
 *    and so on for fake3/fake4.
 *
 * Each pick goes through a final re-validation right before firing — if
 * the trigger has gone away in the meantime (e.g. a `[9]` reset cleared
 * everyone), we skip silently rather than picking from thin air.
 */
class DraftOrchestrator {
  private queue: FakeClient[] = [];
  private running = false;

  /** Gap between the end of one pick and the start of the next. */
  private readonly gapMs = 1000;

  requestPick(client: FakeClient): void {
    if (this.queue.includes(client)) return; // already queued
    this.queue.push(client);
    if (!this.running) {
      void this.runQueue();
    }
  }

  private async runQueue(): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const client = this.queue.shift()!;

        // Re-validate. Conditions can have changed between queueing and
        // running: client may have been picked manually via [c]/[A], may
        // have left the room, or auto-follow may have been turned off.
        if (
          client.lifecycle !== "lobby" ||
          !client.autoFollowEnabled ||
          !client.roomSocket
        ) {
          continue;
        }
        const stillSomeoneElse =
          client.latestRoomState?.members?.some(
            (m) => m.id !== client.memberId && m.championId > 0
          ) ?? false;
        if (!stillSomeoneElse) {
          client.notify(
            `${DIM}auto-pick annulé — plus personne en champion select${RESET}`
          );
          continue;
        }

        try {
          await client.autoPickChampion();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          client.notify(`${DIM}auto-pick error: ${msg}${RESET}`);
        }

        // 1-second cooldown — gives the server's broadcast of the picker's
        // new championId time to land in everyone else's `latestRoomState`
        // so the next fake's exclude-set is correct.
        if (this.queue.length > 0) {
          await sleep(this.gapMs);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

const orchestrator = new DraftOrchestrator();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Centralized FakeClient factory. Wraps `new FakeClient(...)` so every
 * client created by the CLI is automatically wired to the orchestrator
 * — there's no codepath that creates a fake without it.
 */
function createClient(
  puuid: string,
  summonerName: string,
  role: "owner" | "guest",
  friendPuuids: string[] = []
): FakeClient {
  const c = new FakeClient(puuid, summonerName, role, friendPuuids, logEvent);
  c.autoPickRequester = (client) => orchestrator.requestPick(client);
  return c;
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

function createRl(): readline.Interface {
  const iface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  iface.on("close", () => {
    cleanupAndExit();
  });

  return iface;
}

/**
 * Print an event line without clobbering whatever prompt is currently shown.
 * The fake-client logger uses this so async server events don't visually
 * eat the user's typing prompt.
 */
function logEvent(message: string): void {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  console.log(message);
  if (currentPromptText) {
    process.stdout.write(currentPromptText);
  }
}

const ask: AskFn = (question: string) =>
  new Promise<string>((resolve) => {
    currentPromptText = question;
    rl.question(question, (answer) => {
      currentPromptText = "";
      resolve(answer.trim());
    });
  });

function cleanupAndExit(): void {
  console.log(`\n${DIM}Déconnexion de tous les clients...${RESET}`);
  for (const c of clients) {
    c.disconnect();
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function nextDefaultName(): string {
  return `SimPlayer${clientCounter}`;
}

function nextPuuid(): string {
  // Server requires /^[A-Za-z0-9_-]{16,128}$/ — simulator format is fine.
  return `fake-puuid-${String(clientCounter).padStart(20, "0")}`;
}

function listOwners(): Array<{ code: string; ownerName: string }> {
  return clients
    .filter((c) => c.role === "owner" && c.roomCode)
    .map((c) => ({ code: c.roomCode, ownerName: c.summonerName }));
}

function withProgress(label: string) {
  return (current: number, total: number) => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`${DIM}${label} ${current}/${total}${RESET}`);
    if (current === total) {
      process.stdout.write("\n");
    }
  };
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

async function mainMenu(): Promise<void> {
  while (true) {
    console.log(`
${BOLD}${CYAN}=== SkinPicker Simulator ===${RESET}
${GREEN}[1]${RESET} Ajouter un owner ${DIM}(crée une room, lobby)${RESET}
${GREEN}[2]${RESET} Ajouter un guest ${DIM}(rejoint une room par code, lobby)${RESET}
${GREEN}[3]${RESET} Quick-spawn ${DIM}(1 owner + N guests d'un coup)${RESET}
${GREEN}[4]${RESET} Lister les clients
${GREEN}[5]${RESET} Piloter un client ${DIM}(actions champ-select, lock, reroll, etc.)${RESET}
${GREEN}[7]${RESET} ${BOLD}Auto-draft${RESET} ${DIM}— faire pick tous les lobby clients d'un coup, optimisé pour la synergie${RESET}
${GREEN}[8]${RESET} Toggle auto-follow ${DIM}sur tous les clients en lobby (réagit dès que quelqu'un d'autre pick)${RESET}
${GREEN}[9]${RESET} ${BOLD}Reset draft${RESET} ${DIM}— remet tous les fakes en lobby pour pouvoir refaire un test${RESET}
${GREEN}[6]${RESET} Quitter`);

    const choice = await ask(`\n${BOLD}Choix > ${RESET}`);

    switch (choice) {
      case "1":
        await createOwner();
        break;
      case "2":
        await createGuest();
        break;
      case "3":
        await quickSpawn();
        break;
      case "4":
        listClients();
        break;
      case "5":
        await pilotMenu();
        break;
      case "7":
        await autoDraftAll();
        break;
      case "8":
        toggleAutoFollowAll();
        break;
      case "9":
        resetDraftAll();
        break;
      case "6":
        cleanupAndExit();
        return;
      default:
        console.log(`${DIM}Choix invalide.${RESET}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Top-level actions
// ---------------------------------------------------------------------------

/**
 * Create an owner. The fake player joins the room in **lobby** state — no
 * champion, no skin, no owned-options. To get them into champion select,
 * use the pilot menu.
 */
async function createOwner(): Promise<void> {
  const defaultName = nextDefaultName();
  const nameInput = await ask(
    `Nom du joueur ${DIM}(défaut: ${defaultName})${RESET}: `
  );
  const name = nameInput || defaultName;

  const targetPuuid = await ask(
    `PUUID d'un vrai joueur à inviter ${DIM}(optionnel, Enter pour passer)${RESET}: `
  );
  const friendPuuids = targetPuuid ? [targetPuuid] : [];

  const puuid = nextPuuid();
  clientCounter++;

  const client = createClient(puuid, name, "owner", friendPuuids);
  clients.push(client);

  try {
    console.log(`${DIM}Connexion au serveur...${RESET}`);
    await client.connectIdentity();
    await client.connectRoom();
    await client.createRoom();

    console.log(
      `\n${BOLD}${GREEN}Owner créé.${RESET} Room: ${BOLD}${CYAN}${client.roomCode}${RESET} ${DIM}— état: lobby (pas en draft)${RESET}`
    );
    console.log(
      `${DIM}Utilise le menu "Piloter" pour le faire entrer en champ select.${RESET}`
    );

    if (targetPuuid) {
      client.invitePlayer(targetPuuid);
    }
  } catch (err) {
    handleSpawnError(client, err);
  }
}

async function createGuest(): Promise<void> {
  const code = await pickRoomCode(ask, listOwners());
  if (!code) {
    console.log(`${DIM}Annulé.${RESET}`);
    return;
  }

  const defaultName = nextDefaultName();
  const nameInput = await ask(
    `Nom du joueur ${DIM}(défaut: ${defaultName})${RESET}: `
  );
  const name = nameInput || defaultName;

  const puuid = nextPuuid();
  clientCounter++;

  const client = createClient(puuid, name, "guest");
  clients.push(client);

  try {
    console.log(`${DIM}Connexion au serveur...${RESET}`);
    await client.connectIdentity();
    await client.connectRoom();
    await client.joinRoom(code);

    console.log(
      `\n${BOLD}${GREEN}Guest créé.${RESET} Room: ${client.roomCode} ${DIM}— état: lobby${RESET}`
    );
  } catch (err) {
    handleSpawnError(client, err);
  }
}

/**
 * One-shot spawn of a fresh room with N total players (1 owner + N-1 guests).
 * Convenient for "I want to test 3-person synergy now" scenarios.
 */
async function quickSpawn(): Promise<void> {
  const totalInput = await ask(
    `Combien de joueurs ${DIM}(2-5, défaut 3)${RESET}: `
  );
  let total = parseInt(totalInput, 10);
  if (isNaN(total) || total < 2) total = 3;
  if (total > 5) total = 5;

  const followInput = await ask(
    `Activer auto-follow ${BOLD}sur tous les fakes${RESET} ? ${DIM}(Y/n — réagissent dès que toi tu pick)${RESET} `
  );
  const enableAutoFollow = followInput.trim().toLowerCase() !== "n";

  // Owner
  const ownerName = `SimOwner${clientCounter}`;
  const ownerPuuid = nextPuuid();
  clientCounter++;
  const owner = createClient(ownerPuuid, ownerName, "owner");
  clients.push(owner);

  try {
    console.log(`${DIM}Spawn owner ${ownerName}...${RESET}`);
    await owner.connectIdentity();
    await owner.connectRoom();
    await owner.createRoom();
  } catch (err) {
    handleSpawnError(owner, err);
    return;
  }

  // Guests
  for (let i = 1; i < total; i++) {
    const name = `SimGuest${clientCounter}`;
    const puuid = nextPuuid();
    clientCounter++;
    const guest = createClient(puuid, name, "guest");
    clients.push(guest);
    try {
      console.log(`${DIM}Spawn guest ${name}...${RESET}`);
      await guest.connectIdentity();
      await guest.connectRoom();
      await guest.joinRoom(owner.roomCode);
    } catch (err) {
      handleSpawnError(guest, err);
    }
  }

  // Apply auto-follow last so each client has its room-state snapshot first.
  if (enableAutoFollow) {
    for (const c of clients) {
      if (c.lifecycle === "lobby") c.setAutoFollow(true);
    }
  }

  console.log(
    `\n${BOLD}${GREEN}${total} clients spawnés${RESET} dans la room ${BOLD}${CYAN}${owner.roomCode}${RESET}.`
  );
  if (enableAutoFollow) {
    console.log(
      `${MAGENTA}👁 Auto-follow ON${RESET} ${DIM}— ils picker automatiquement dès qu'un autre membre choisit un champion.${RESET}`
    );
  } else {
    console.log(
      `${DIM}Tous en lobby. Utilise [7] Auto-draft pour les faire pick d'un coup, ou [5] Piloter individuellement.${RESET}`
    );
  }
}

function handleSpawnError(client: FakeClient, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.log(`${RED}Erreur: ${message}${RESET}`);
  client.disconnect();
  const idx = clients.indexOf(client);
  if (idx >= 0) clients.splice(idx, 1);
}

function listClients(): void {
  if (clients.length === 0) {
    console.log(`${DIM}Aucun client actif.${RESET}`);
    return;
  }
  console.log(`\n${BOLD}Clients actifs:${RESET}`);
  for (let i = 0; i < clients.length; i++) {
    console.log(`  ${GREEN}[${i + 1}]${RESET} ${clients[i].getStatus()}`);
  }
}

// ---------------------------------------------------------------------------
// Auto-draft (batch — main menu [7])
// ---------------------------------------------------------------------------

/**
 * Run a coordinated auto-draft across every client currently in lobby.
 * Asks for an optional target champion (the one the operator is going to
 * play), shows the proposed picks (with "shared lines" tags), then fires
 * `enterChampSelect` on each client in parallel.
 */
async function autoDraftAll(): Promise<void> {
  const lobbyClients = clients.filter((c) => c.lifecycle === "lobby");
  if (lobbyClients.length === 0) {
    console.log(`${YELLOW}Aucun client en lobby — rien à auto-draft.${RESET}`);
    return;
  }

  // Optional target — anchors the optimization on a specific champion.
  const targetId = await askChampionOptional(
    `${DIM}Champion cible — celui que TU vas jouer ${BOLD}(Enter pour optimiser entre les fakes seulement)${RESET}${DIM} : ${RESET}`
  );

  // Exclude any champion already locked in the room (any client). Avoids
  // two fakes converging on the same champ.
  const exclude = new Set<number>();
  for (const c of clients) {
    if (c.lifecycle === "in-draft" && c.championId > 0) {
      exclude.add(c.championId);
    }
  }

  console.log(
    `${DIM}Calcul des picks optimaux pour ${lobbyClients.length} client(s)...${RESET}`
  );
  const picks = await pickOptimalChampions(lobbyClients.length, {
    target: targetId ?? undefined,
    excludeIds: exclude,
  });

  if (picks.length === 0) {
    console.log(`${YELLOW}Pas de candidat trouvé.${RESET}`);
    return;
  }

  // Resolve aliases for display.
  const aliases = await Promise.all(
    picks.map((p) => fetchChampionAlias(p.championId))
  );

  console.log(`\n${BOLD}Picks proposés :${RESET}`);
  for (let i = 0; i < lobbyClients.length && i < picks.length; i++) {
    const p = picks[i];
    const tag =
      p.sharedLines > 0
        ? `${GREEN}${p.sharedLines}${RESET} lignée${p.sharedLines > 1 ? "s" : ""} en commun`
        : `${DIM}${p.totalLines} lignées au total${RESET}`;
    console.log(
      `  ${lobbyClients[i].summonerName} → ${BOLD}${aliases[i]}${RESET} ${DIM}(#${p.championId})${RESET}  — ${tag}`
    );
  }

  const confirm = await ask(`\nConfirmer ? ${DIM}(Y/n)${RESET} `);
  if (confirm.trim().toLowerCase() === "n") {
    console.log(`${DIM}Annulé.${RESET}`);
    return;
  }

  // Fire all picks in parallel — they hit the server independently.
  const results = await Promise.allSettled(
    lobbyClients.slice(0, picks.length).map((client, i) =>
      client.enterChampSelect(picks[i].championId)
    )
  );
  const failures = results.filter((r) => r.status === "rejected").length;
  if (failures === 0) {
    console.log(`${GREEN}Auto-draft terminé.${RESET}`);
  } else {
    console.log(
      `${YELLOW}Auto-draft terminé avec ${failures} échec(s) — voir les logs.${RESET}`
    );
  }
}

/**
 * Optional champion picker that returns null on empty input. Same fuzzy
 * search behavior as the regular pickChampion but doesn't yell "Aucun
 * champion trouvé" on Enter — Enter is a valid "no target" signal here.
 */
async function askChampionOptional(prompt: string): Promise<number | null> {
  const input = (await ask(prompt)).trim();
  if (!input) return null;
  // Re-use pickChampion's logic by passing the input as if it were typed
  // into its prompt. We do it inline so we don't double-prompt.
  const asId = parseInt(input, 10);
  if (!isNaN(asId) && String(asId) === input && asId > 0) return asId;
  // Defer to pickChampion's fuzzy logic via a synthetic ask that returns
  // the input once, then empty (cancel).
  let consumed = false;
  const oneShot: AskFn = async () => {
    if (!consumed) {
      consumed = true;
      return input;
    }
    return "";
  };
  return pickChampion(oneShot);
}

/**
 * Reset every in-draft client back to lobby so the next auto-draft (or
 * auto-follow re-fire) can run with the same set of clients. Useful for
 * iterative testing — locking a champion is normally a one-shot, but
 * here it's just an `update-selection` with championId=0 emitted per
 * client, which makes the server clear their options and recompute synergy.
 *
 * Behavioural note for auto-follow: if any other room member is still in
 * champion select (typically the operator's real LCU client when testing
 * the live app), the per-fake auto-follow listener will re-fire as soon
 * as their lifecycle flips back to "lobby" — so the cycle "reset → fakes
 * re-pick optimal champions" is fully automatic.
 */
function resetDraftAll(): void {
  const draftClients = clients.filter((c) => c.lifecycle === "in-draft");
  if (draftClients.length === 0) {
    console.log(`${YELLOW}Aucun client en draft à reset.${RESET}`);
    return;
  }
  for (const c of draftClients) {
    c.leaveChampSelect();
  }
  console.log(
    `${GREEN}${draftClients.length} client(s) remis en lobby.${RESET}`
  );
  const followers = clients.filter(
    (c) => c.lifecycle === "lobby" && c.autoFollowEnabled
  );
  if (followers.length > 0) {
    console.log(
      `${DIM}${followers.length} client(s) ont l'auto-follow ON — ils re-picker dès qu'un autre membre est en champion select.${RESET}`
    );
  } else {
    console.log(
      `${DIM}Tu peux maintenant relancer [7] Auto-draft pour faire un nouveau test.${RESET}`
    );
  }
}

/**
 * Toggle auto-follow ON for every lobby client (or OFF if it's already on
 * for all of them). Convenience for "I'm about to start a custom game,
 * activate the watcher on all my fakes".
 */
function toggleAutoFollowAll(): void {
  const lobbyClients = clients.filter((c) => c.lifecycle === "lobby");
  if (lobbyClients.length === 0) {
    console.log(`${YELLOW}Aucun client en lobby.${RESET}`);
    return;
  }
  const allOn = lobbyClients.every((c) => c.autoFollowEnabled);
  const next = !allOn;
  for (const c of lobbyClients) c.setAutoFollow(next);
  console.log(
    `${GREEN}Auto-follow ${next ? "ON" : "OFF"} sur ${lobbyClients.length} client(s) en lobby.${RESET}`
  );
  if (next) {
    console.log(
      `${DIM}Ils picker un champion synergique dès qu'un autre membre apparaît avec un champion choisi.${RESET}`
    );
  }
}

// ---------------------------------------------------------------------------
// Pilot menu
// ---------------------------------------------------------------------------

async function pilotMenu(): Promise<void> {
  if (clients.length === 0) {
    console.log(`${DIM}Aucun client actif.${RESET}`);
    return;
  }

  listClients();
  const idxRaw = await ask("\nNuméro du client à piloter > ");
  const idx = parseInt(idxRaw, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= clients.length) {
    console.log(`${YELLOW}Sélection invalide.${RESET}`);
    return;
  }
  await pilotClient(clients[idx]);
}

async function pilotClient(client: FakeClient): Promise<void> {
  while (true) {
    const idx = clients.indexOf(client);
    if (idx < 0) {
      // Client got removed (disconnected, kicked, etc.) — go back.
      console.log(`${DIM}Ce client n'est plus actif.${RESET}`);
      return;
    }

    const draftLabel = client.inDraft
      ? `${BOLD}draft${RESET} (${client.championAlias} #${client.championId})`
      : `${DIM}lobby${RESET}`;
    const lockLabel = client.skinLockEnabled
      ? `${MAGENTA}🔒 lock ON${RESET}`
      : `${DIM}🔓 lock OFF${RESET}`;
    const followLabel = client.autoFollowEnabled
      ? `${MAGENTA}👁 auto-follow ON${RESET}`
      : `${DIM}👁 auto-follow OFF${RESET}`;

    console.log(`
${BOLD}=== Piloter ${client.summonerName} (${client.role}) ===${RESET}
  Room: ${CYAN}${client.roomCode || "—"}${RESET}   État: ${draftLabel}
  ${lockLabel}   ${followLabel}

${BOLD}Commun :${RESET}
  ${GREEN}[s]${RESET} Afficher l'état de la room
  ${GREEN}[c]${RESET} ${client.inDraft ? "Changer de champion (manuel)" : "Entrer en champion select (manuel)"}
  ${GREEN}[A]${RESET} ${client.inDraft ? `${DIM}Auto-pick (déjà en draft)${RESET}` : `${BOLD}Auto-pick maintenant${RESET} ${DIM}(champion optimal)${RESET}`}
  ${GREEN}[F]${RESET} Toggle auto-follow ${DIM}(pick auto dès qu'un autre membre choisit)${RESET}
  ${client.inDraft ? `${GREEN}[u]${RESET} Sortir de champion select (retour lobby)` : DIM + "[u] (déjà en lobby)" + RESET}
  ${GREEN}[k]${RESET} Toggle match-lock 🔒

${BOLD}${client.isOwner ? "Owner :" : "Guest :"}${RESET}${client.isOwner
      ? `
  ${GREEN}[a]${RESET} Appliquer une lignée de skin (synergy)
  ${GREEN}[r]${RESET} Reroll par couleur (synergy)
  ${GREEN}[i]${RESET} Inviter un joueur (PUUID)
  ${GREEN}[K]${RESET} Kick un membre`
      : `
  ${GREEN}[g]${RESET} Suggérer une couleur/chroma (depuis tes options)`}

${BOLD}Sortie :${RESET}
  ${GREEN}[L]${RESET} Quitter la room (leave-room propre)
  ${GREEN}[x]${RESET} Disconnect brutal
  ${GREEN}[q]${RESET} Retour au menu principal`);

    const choice = (await ask(`\n${BOLD}Action > ${RESET}`)).trim();

    switch (choice) {
      case "s":
        console.log(`\n${client.prettyRoomState()}`);
        break;
      case "c":
        await actionPickChampion(client);
        break;
      case "A":
        await actionAutoPick(client);
        break;
      case "F":
        client.toggleAutoFollow();
        break;
      case "u":
        client.leaveChampSelect();
        break;
      case "k":
        client.toggleMatchLock();
        break;
      case "a":
        if (!client.isOwner) {
          console.log(`${YELLOW}Owner only.${RESET}`);
          break;
        }
        await actionApplySkinLine(client);
        break;
      case "r":
        if (!client.isOwner) {
          console.log(`${YELLOW}Owner only.${RESET}`);
          break;
        }
        await actionReroll(client);
        break;
      case "i":
        if (!client.isOwner) {
          console.log(`${YELLOW}Owner only.${RESET}`);
          break;
        }
        await actionInvite(client);
        break;
      case "K":
        if (!client.isOwner) {
          console.log(`${YELLOW}Owner only.${RESET}`);
          break;
        }
        await actionKick(client);
        break;
      case "g":
        if (client.isOwner) {
          console.log(
            `${YELLOW}Les guests utilisent suggest-color, pas l'owner.${RESET}`
          );
          break;
        }
        await actionSuggestColor(client);
        break;
      case "L":
        client.leaveRoomGracefully();
        clients.splice(clients.indexOf(client), 1);
        console.log(`${DIM}Client retiré.${RESET}`);
        return;
      case "x":
        client.disconnect();
        clients.splice(clients.indexOf(client), 1);
        console.log(`${DIM}Client retiré.${RESET}`);
        return;
      case "q":
        return;
      default:
        console.log(`${DIM}Action inconnue.${RESET}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pilot actions
// ---------------------------------------------------------------------------

async function actionPickChampion(client: FakeClient): Promise<void> {
  const championId = await pickChampion(ask);
  if (!championId) {
    console.log(`${DIM}Annulé.${RESET}`);
    return;
  }
  try {
    if (client.inDraft) {
      await client.changeChampion(championId, withProgress("Chromas..."));
    } else {
      await client.enterChampSelect(championId, withProgress("Chromas..."));
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.log(`${RED}Erreur: ${m}${RESET}`);
  }
}

/**
 * Single-client auto-pick. Optionally takes an explicit target champion
 * — useful when no other member has picked yet, so inference would
 * otherwise fall through to "any champion in many lines".
 */
async function actionAutoPick(client: FakeClient): Promise<void> {
  if (client.inDraft) {
    console.log(
      `${YELLOW}${client.summonerName} est déjà en draft. Sors-le d'abord avec [u].${RESET}`
    );
    return;
  }
  const target = await askChampionOptional(
    `${DIM}Champion cible (Enter pour inférer depuis la room) : ${RESET}`
  );
  await client.autoPickChampion(target ?? undefined);
}

async function actionApplySkinLine(client: FakeClient): Promise<void> {
  const synergy = await pickSkinLineSynergy(ask, client.latestRoomState);
  if (!synergy) {
    console.log(`${DIM}Annulé.${RESET}`);
    return;
  }
  client.applySkinLineSynergy(synergy.skinLineId);
  console.log(
    `${DIM}apply-skin-line-synergy envoyé pour "${synergy.skinLineName}".${RESET}`
  );
}

async function actionReroll(client: FakeClient): Promise<void> {
  const synergy = await pickColorSynergy(ask, client.latestRoomState);
  if (!synergy) {
    console.log(`${DIM}Annulé.${RESET}`);
    return;
  }
  client.requestGroupReroll(synergy.color);
  console.log(`${DIM}request-group-reroll envoyé pour ${synergy.color}.${RESET}`);
}

async function actionInvite(client: FakeClient): Promise<void> {
  const targetPuuid = await ask("PUUID du joueur à inviter: ");
  if (!targetPuuid) {
    console.log(`${YELLOW}PUUID requis.${RESET}`);
    return;
  }
  client.invitePlayer(targetPuuid);
}

async function actionKick(client: FakeClient): Promise<void> {
  const target = await pickRoomMember(
    ask,
    client.latestRoomState,
    client.memberId
  );
  if (!target) {
    console.log(`${DIM}Annulé.${RESET}`);
    return;
  }
  const confirm = await ask(
    `Confirmer le kick de "${target.name}" ? ${DIM}(y/N)${RESET} `
  );
  if (confirm.toLowerCase() !== "y") {
    console.log(`${DIM}Annulé.${RESET}`);
    return;
  }
  client.kickMember(target.id);
}

async function actionSuggestColor(client: FakeClient): Promise<void> {
  if (!client.inDraft || !client.options.length) {
    console.log(
      `${YELLOW}Tu dois d'abord entrer en champion select (action [c]) avant de suggérer une couleur.${RESET}`
    );
    return;
  }
  const pick = await pickSkinAndChromaFromOptions(
    ask,
    client.options,
    client.championId
  );
  if (!pick) {
    console.log(`${DIM}Annulé.${RESET}`);
    return;
  }
  client.suggestColor(pick.skinId, pick.chromaId);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    `${BOLD}${CYAN}
  ╔══════════════════════════════════════╗
  ║     SkinPicker Socket Simulator      ║
  ╚══════════════════════════════════════╝${RESET}
  ${DIM}Serveur attendu sur localhost:4000${RESET}
  ${DIM}Les nouveaux clients démarrent en LOBBY. Trois manières de les faire entrer en draft :${RESET}
    ${GREEN}•${RESET} ${BOLD}[7] Auto-draft${RESET} — fait pick tous les lobby clients d'un coup, optimisé pour la synergie
    ${GREEN}•${RESET} ${BOLD}[3] Quick-spawn + auto-follow${RESET} — ils réagissent quand TU pick dans ta vraie partie
    ${GREEN}•${RESET} ${BOLD}[5] Piloter${RESET} — sélection manuelle un par un (avec [A] auto-pick / [F] toggle follow)
`
  );

  rl = createRl();

  process.on("SIGINT", cleanupAndExit);

  await mainMenu();
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
