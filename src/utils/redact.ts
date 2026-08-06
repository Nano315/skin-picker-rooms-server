/**
 * Tronque un PUUID pour les logs.
 *
 * Un PUUID identifie durablement un compte Riot, et les logs du serveur sont
 * ecrits sur disque sans expiration : les conserver en entier revient a tenir
 * un registre permanent de qui a utilise le service et quand. Les 8 premiers
 * caracteres suffisent a correler des lignes entre elles pendant un diagnostic,
 * ce qui est le seul besoin reel.
 *
 * A utiliser dans TOUT log qui touche a un PUUID. Ne jamais logger un
 * memberToken, meme tronque : c'est un secret d'authentification.
 */
export function redactPuuid(puuid: string): string {
  if (!puuid) return "(vide)";
  return `${puuid.slice(0, 8)}…`;
}
