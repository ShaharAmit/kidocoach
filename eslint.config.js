// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
    rules: {
      // SDK 57 adds compiler diagnostics; keep existing Animated/ref patterns non-blocking.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  }
]);
