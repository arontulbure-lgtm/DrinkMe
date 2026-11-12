const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Exclude server/node_modules from Metro file watcher
config.resolver.blockList = [
  /server[\/\\]node_modules[\/\\].*/,
];

module.exports = config;
