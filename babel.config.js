const path = require('path');

// babel-preset-expo comes with the expo package and is no longer hoisted to the top-level node_modules
// (since the SDK 54 patch updates), so it is resolved from expo's own folder. Same version as `expo`
// expects, and no extra dependency to keep in step.
const babelPresetExpo = require.resolve('babel-preset-expo', {
  paths: [path.dirname(require.resolve('expo/package.json')), __dirname],
});

module.exports = function(api) {
  api.cache(true);
  return {
    presets: [babelPresetExpo, 'nativewind/babel'],
    plugins: ['react-native-reanimated/plugin'],
  };
};
