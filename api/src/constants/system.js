module.exports.core = {
  server: { port: 3000 },
  storage: {
    path: './.storage',
    config: { path: './.storage/config' },
    tmp: { path: '/tmp/double-take' },
  },
};

module.exports.dev = {
  mqtt: { host: 'double-take-mqtt' },
};
