import * as readline from "readline";
import { FakeClient } from "./fake-client";
import { searchChampion, ChampionSearchResult } from "./cdragon.service";

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";

const clients: FakeClient[] = [];
let clientCounter = 1;

let rl: readline.Interface;
let currentPromptText = "";

// --- Readline helpers ---

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

function logEvent(message: string): void {
  // Clear current line, print event, re-display prompt
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  console.log(message);
  if (currentPromptText) {
    process.stdout.write(currentPromptText);
  }
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    currentPromptText = question;
    rl.question(question, (answer) => {
      currentPromptText = "";
      resolve(answer.trim());
    });
  });
}

function cleanupAndExit(): void {
  console.log(`\n${DIM}Déconnexion de tous les clients...${RESET}`);
  for (const c of clients) {
    c.disconnect();
  }
  process.exit(0);
}

// --- Champion Selection ---

async function askChampion(): Promise<number | null> {
  const input = await ask(
    `Champion ${DIM}(nom ou ID, ex: yasuo, 157)${RESET}: `
  );
  if (!input) return null;

  // If numeric, treat as ID directly
  const asId = parseInt(input, 10);
  if (!isNaN(asId) && asId > 0 && String(asId) === input.trim()) {
    return asId;
  }

  // Search by name
  console.log(`${DIM}Recherche...${RESET}`);
  const results = await searchChampion(input);

  if (results.length === 0) {
    console.log(`${YELLOW}Aucun champion trouvé pour "${input}".${RESET}`);
    return null;
  }

  // Exact match (score 0) → auto-select
  if (results[0].score === 0 && results.filter((r) => r.score === 0).length === 1) {
    const match = results[0];
    console.log(`${GREEN}→ ${match.name}${RESET} (ID: ${match.id})`);
    return match.id;
  }

  // Multiple results → let user pick
  const shown = results.slice(0, 10);
  console.log(`\n${BOLD}Résultats :${RESET}`);
  for (let i = 0; i < shown.length; i++) {
    console.log(
      `  ${GREEN}[${i + 1}]${RESET} ${shown[i].name} ${DIM}(ID: ${shown[i].id})${RESET}`
    );
  }

  const pick = await ask(`\nNuméro ${DIM}(ou Enter pour annuler)${RESET}: `);
  const idx = parseInt(pick, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= shown.length) {
    return null;
  }

  return shown[idx].id;
}

// --- Main Menu ---

async function mainMenu(): Promise<void> {
  while (true) {
    console.log(
      `\n${BOLD}${CYAN}=== SkinPicker Simulator ===${RESET}
${GREEN}[1]${RESET} Créer un faux client (owner) — crée une room et attend des joueurs
${GREEN}[2]${RESET} Créer un faux client (guest) — rejoint une room existante
${GREEN}[3]${RESET} Lister les clients actifs
${GREEN}[4]${RESET} Piloter un client
${GREEN}[5]${RESET} Quitter`
    );

    const choice = await ask(`\n${BOLD}Choix > ${RESET}`);

    switch (choice) {
      case "1":
        await createOwner();
        break;
      case "2":
        await createGuest();
        break;
      case "3":
        listClients();
        break;
      case "4":
        await pilotClient();
        break;
      case "5":
        cleanupAndExit();
        return;
      default:
        console.log(`${DIM}Choix invalide.${RESET}`);
    }
  }
}

// --- Flow [1]: Create Owner ---

async function createOwner(): Promise<void> {
  const defaultName = `SimPlayer${clientCounter}`;
  const nameInput = await ask(
    `Nom du joueur ${DIM}(défaut: ${defaultName})${RESET}: `
  );
  const name = nameInput || defaultName;

  const championId = await askChampion();
  if (!championId) return;

  // Puuid must match /^[A-Za-z0-9_-]{16,128}$/ on the server
  const puuid = `fake-puuid-${String(clientCounter).padStart(20, "0")}`;
  clientCounter++;

  // Ask for real player PUUID to invite (optional)
  const targetPuuid = await ask(
    `PUUID du vrai joueur à inviter ${DIM}(optionnel, Enter pour passer)${RESET}: `
  );
  const friendPuuids = targetPuuid ? [targetPuuid] : [];

  const client = new FakeClient(puuid, name, "owner", friendPuuids, logEvent);
  clients.push(client);

  try {
    console.log(`${DIM}Connexion au serveur...${RESET}`);
    await client.connectIdentity();
    await client.connectRoom();
    await client.createRoom();
    await client.selectChampion(championId, (current, total) => {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(
        `${DIM}Fetching chroma colors... ${current}/${total}${RESET}`
      );
    });
    console.log(""); // newline after progress

    console.log(
      `\n${BOLD}${GREEN}Client owner créé !${RESET} Code room: ${BOLD}${CYAN}${client.roomCode}${RESET}`
    );

    // Auto-invite if PUUID provided
    if (targetPuuid) {
      client.invitePlayer(targetPuuid);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`${YELLOW}Erreur: ${message}${RESET}`);
    client.disconnect();
    clients.splice(clients.indexOf(client), 1);
  }
}

// --- Flow [2]: Create Guest ---

async function createGuest(): Promise<void> {
  const codeInput = await ask("Code room: ");
  if (!codeInput) {
    console.log(`${YELLOW}Code room requis.${RESET}`);
    return;
  }

  const defaultName = `SimPlayer${clientCounter}`;
  const nameInput = await ask(
    `Nom du joueur ${DIM}(défaut: ${defaultName})${RESET}: `
  );
  const name = nameInput || defaultName;

  const championId = await askChampion();
  if (!championId) return;

  // Puuid must match /^[A-Za-z0-9_-]{16,128}$/ on the server
  const puuid = `fake-puuid-${String(clientCounter).padStart(20, "0")}`;
  clientCounter++;

  const client = new FakeClient(puuid, name, "guest", [], logEvent);
  clients.push(client);

  try {
    console.log(`${DIM}Connexion au serveur...${RESET}`);
    await client.connectIdentity();
    await client.connectRoom();
    await client.joinRoom(codeInput.toUpperCase());
    await client.selectChampion(championId, (current, total) => {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(
        `${DIM}Fetching chroma colors... ${current}/${total}${RESET}`
      );
    });
    console.log(""); // newline after progress

    console.log(`\n${BOLD}${GREEN}Client guest créé !${RESET}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`${YELLOW}Erreur: ${message}${RESET}`);
    client.disconnect();
    clients.splice(clients.indexOf(client), 1);
  }
}

// --- Flow [3]: List Clients ---

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

// --- Flow [4]: Pilot Client ---

async function pilotClient(): Promise<void> {
  if (clients.length === 0) {
    console.log(`${DIM}Aucun client actif.${RESET}`);
    return;
  }

  listClients();

  const idx = parseInt(await ask("\nNuméro du client > "), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= clients.length) {
    console.log(`${YELLOW}Sélection invalide.${RESET}`);
    return;
  }

  const client = clients[idx];
  await pilotSubMenu(client);
}

async function pilotSubMenu(client: FakeClient): Promise<void> {
  const isOwner = client.role === "owner";

  while (true) {
    console.log(
      `\n${BOLD}Piloter: ${client.summonerName}${RESET} (${client.role})
${isOwner ? `${GREEN}[a]${RESET} Appliquer une synergie skin line` : ""}
${isOwner ? `${GREEN}[b]${RESET} Reroll couleur` : ""}
${isOwner ? `${GREEN}[c]${RESET} Inviter un joueur` : ""}
${!isOwner ? `${GREEN}[d]${RESET} Suggérer une couleur` : ""}
${GREEN}[e]${RESET} Afficher l'état de la room
${GREEN}[f]${RESET} Déconnecter ce client
${GREEN}[r]${RESET} Retour au menu principal`
    );

    const choice = await ask(`\n${BOLD}Action > ${RESET}`);

    switch (choice.toLowerCase()) {
      case "a":
        if (!isOwner) break;
        await actionApplySkinLine(client);
        break;
      case "b":
        if (!isOwner) break;
        await actionReroll(client);
        break;
      case "c":
        if (!isOwner) break;
        await actionInvite(client);
        break;
      case "d":
        if (isOwner) break;
        await actionSuggestColor(client);
        break;
      case "e":
        console.log(`\n${client.getStatus()}`);
        break;
      case "f":
        client.disconnect();
        clients.splice(clients.indexOf(client), 1);
        console.log(`${DIM}Client déconnecté.${RESET}`);
        return;
      case "r":
        return;
      default:
        console.log(`${DIM}Action invalide.${RESET}`);
    }
  }
}

async function actionApplySkinLine(client: FakeClient): Promise<void> {
  const input = await ask("Skin Line ID: ");
  const skinLineId = parseInt(input, 10);
  if (isNaN(skinLineId)) {
    console.log(`${YELLOW}ID invalide.${RESET}`);
    return;
  }
  client.applySkinLineSynergy(skinLineId);
  console.log(`${DIM}Synergie skin line envoyée.${RESET}`);
}

async function actionReroll(client: FakeClient): Promise<void> {
  const color = await ask("Couleur (ex: rgba(98,72,255,0.5)): ");
  if (!color) {
    console.log(`${YELLOW}Couleur requise.${RESET}`);
    return;
  }
  const skinLineInput = await ask(
    `Skin Line ID ${DIM}(optionnel, Enter pour ignorer)${RESET}: `
  );
  const skinLineId = skinLineInput ? parseInt(skinLineInput, 10) : undefined;

  client.requestGroupReroll(
    "sameColor",
    color,
    isNaN(skinLineId as number) ? undefined : skinLineId
  );
  console.log(`${DIM}Reroll envoyé.${RESET}`);
}

async function actionInvite(client: FakeClient): Promise<void> {
  const targetPuuid = await ask("PUUID du joueur à inviter: ");
  if (!targetPuuid) {
    console.log(`${YELLOW}PUUID requis.${RESET}`);
    return;
  }
  client.invitePlayer(targetPuuid);
}

async function actionSuggestColor(client: FakeClient): Promise<void> {
  const skinInput = await ask("Skin ID: ");
  const skinId = parseInt(skinInput, 10);
  if (isNaN(skinId)) {
    console.log(`${YELLOW}ID invalide.${RESET}`);
    return;
  }
  const chromaInput = await ask("Chroma ID: ");
  const chromaId = parseInt(chromaInput, 10);
  if (isNaN(chromaId)) {
    console.log(`${YELLOW}ID invalide.${RESET}`);
    return;
  }
  client.suggestColor(skinId, chromaId);
}

// --- Entry Point ---

async function main(): Promise<void> {
  console.log(
    `${BOLD}${CYAN}
  ╔══════════════════════════════════════╗
  ║     SkinPicker Socket Simulator      ║
  ╚══════════════════════════════════════╝${RESET}
  ${DIM}Assurez-vous que le serveur SkinPicker tourne sur localhost:4000${RESET}
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
