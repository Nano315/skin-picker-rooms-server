import { logger } from "./logger";

/**
 * Rate limiting par socket pour les evenements Socket.IO.
 *
 * Les limiteurs `express-rate-limit` de server.ts sont des middlewares EXPRESS :
 * Socket.IO est attache directement au serveur HTTP et intercepte /socket.io/
 * avant qu'Express ne voie la requete. Aucun evenement socket n'etait donc
 * limite — alors que c'est la surface d'attaque reelle (un client peut emettre
 * en boucle serree, et chaque `owned-options` declenche `recomputeSynergy` puis
 * une rediffusion complete de la room a tous les membres).
 *
 * Implementation : token bucket. Pas de timer, pas d'allocation par evenement,
 * O(1) et deux nombres en memoire par bucket — le cout doit rester negligeable
 * devant ce qu'il protege.
 */

/** Debit soutenu et rafale autorises pour l'ensemble des evenements d'un socket. */
const GLOBAL_CAPACITY = 60;
const GLOBAL_REFILL_PER_SEC = 20;

/**
 * Evenements dont le traitement est couteux cote serveur : ils declenchent un
 * recalcul de synergie et/ou une generation de picks rediffusee a toute la room.
 *
 * `update-selection` en est volontairement ABSENT. Il ne recalcule pas la
 * synergie (il ecrit des champs puis rediffuse l'etat), et surtout il est emis
 * a CHAQUE changement de selection sans debounce cote client
 * (`useRooms.ts`, effet sur `[joined, selection]`). Le classer ici throttlait un
 * joueur qui enchaine les rerolls — c'est-a-dire l'interaction principale de
 * l'application. Il reste couvert par le seau global.
 */
const EXPENSIVE_EVENTS = new Set([
  "owned-options",
  "request-group-reroll",
  "apply-skin-line-synergy",
]);
/**
 * Ces trois evenements sont declenches par un clic. La capacite laisse de la
 * marge a un utilisateur impatient, tout en bornant un client abusif : au-dela,
 * la protection releve d'une limite de connexions par IP au niveau de
 * l'infrastructure, pas d'un compteur par socket.
 */
const EXPENSIVE_CAPACITY = 20;
const EXPENSIVE_REFILL_PER_SEC = 5;

/** `identify` reconstruit la presence et notifie les amis : strictement borne. */
const IDENTIFY_CAPACITY = 5;
const IDENTIFY_REFILL_PER_SEC = 0.2;

/** Intervalle minimal entre deux logs de depassement, par socket (ms). */
const LOG_THROTTLE_MS = 5000;

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  tryConsume(): boolean {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + elapsedSec * this.refillPerSec
      );
      this.lastRefill = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export interface SocketRateLimiter {
  /**
   * @returns true si l'evenement peut etre traite, false s'il doit etre ignore.
   */
  allow(eventName: string): boolean;
  /** Nombre total d'evenements rejetes sur ce socket (pour les logs/metrics). */
  droppedCount(): number;
}

/**
 * Desactive en test, comme les limiteurs Express : les suites d'integration
 * emettent en rafale et n'ont pas a etre ralenties.
 */
const DISABLED =
  process.env.NODE_ENV === "test" || process.env.DISABLE_RATE_LIMIT === "true";

/**
 * @param socketId identifiant utilise dans les logs
 * @param options `enabled` force l'activation malgre NODE_ENV=test — sert
 *        uniquement aux tests du limiteur lui-meme, les suites d'integration
 *        devant rester non ralenties.
 */
export function createSocketRateLimiter(
  socketId: string,
  options?: { enabled?: boolean }
): SocketRateLimiter {
  const enabled = options?.enabled ?? !DISABLED;
  if (!enabled) {
    return { allow: () => true, droppedCount: () => 0 };
  }

  const global = new TokenBucket(GLOBAL_CAPACITY, GLOBAL_REFILL_PER_SEC);
  const expensive = new TokenBucket(EXPENSIVE_CAPACITY, EXPENSIVE_REFILL_PER_SEC);
  const identify = new TokenBucket(IDENTIFY_CAPACITY, IDENTIFY_REFILL_PER_SEC);

  let dropped = 0;
  let lastLog = 0;

  const reject = (eventName: string, scope: string): false => {
    dropped++;
    const now = Date.now();
    if (now - lastLog > LOG_THROTTLE_MS) {
      lastLog = now;
      logger.warn(
        `[rate-limit] socket ${socketId} exceeded ${scope} budget on "${eventName}" (${dropped} events dropped so far)`
      );
    }
    return false;
  };

  return {
    allow(eventName: string): boolean {
      // Le seau global s'applique a tout, y compris aux evenements couteux :
      // un client ne doit pas pouvoir contourner la limite globale en
      // alternant les types d'evenements.
      if (!global.tryConsume()) return reject(eventName, "global");

      if (eventName === "identify" && !identify.tryConsume()) {
        return reject(eventName, "identify");
      }
      if (EXPENSIVE_EVENTS.has(eventName) && !expensive.tryConsume()) {
        return reject(eventName, "expensive");
      }
      return true;
    },
    droppedCount: () => dropped,
  };
}
