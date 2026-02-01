module.exports = {
  apps: [
    {
      name: 'skin-picker-rooms-server',
      script: 'dist/server.js',
      cwd: '/home/ubuntu/Skin-Picker/skin-picker-rooms-server',
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
    },
    {
      name: 'skin-picker-rooms-server-staging',
      script: 'dist/server.js',
      cwd: '/home/ubuntu/Skin-Picker/skin-picker-rooms-server-staging',
      env: {
        NODE_ENV: 'staging',
        PORT: 4001,
      },
    },
  ],
};
