// Configuration PM2.
//
// Les DEUX instances tournent en NODE_ENV=production. C'est volontaire : dans
// le code, `NODE_ENV !== "production"` commande des assouplissements de
// securite — ajout de localhost a l'allow-list CORS (server.ts) et exposition
// des endpoints de test `POST /rooms/bot` et `POST /rooms/:code/bots`
// (room.routes.ts). L'instance de staging etant joignable publiquement comme la
// production, elle ne doit pas en beneficier.
//
// Si un comportement specifique au staging devient necessaire, passer par une
// variable dediee (par ex. APP_ENV) plutot que de degrader NODE_ENV.
module.exports = {
  apps: [
    {
      name: 'skin-picker-rooms-server',
      script: 'dist/server.js',
      cwd: '/home/ubuntu/Skin-Picker/skin-picker-rooms-server',
      env: {
        NODE_ENV: 'production',
        APP_ENV: 'production',
        PORT: 4000,
      },
      // L'etat des rooms est entierement en memoire : une fuite finit par
      // saturer le process. Le balayage periodique (RoomService.sweep) borne la
      // croissance, ce garde-fou attrape ce qui lui echapperait.
      max_memory_restart: '512M',
      // Evite une boucle de redemarrage serree si le process crashe au boot.
      min_uptime: '30s',
      max_restarts: 10,
      restart_delay: 2000,
    },
    {
      name: 'skin-picker-rooms-server-staging',
      script: 'dist/server.js',
      cwd: '/home/ubuntu/Skin-Picker/skin-picker-rooms-server-staging',
      env: {
        // Voir le commentaire d'en-tete : production, pas 'staging'.
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        PORT: 4001,
      },
      max_memory_restart: '512M',
      min_uptime: '30s',
      max_restarts: 10,
      restart_delay: 2000,
    },
  ],
};
