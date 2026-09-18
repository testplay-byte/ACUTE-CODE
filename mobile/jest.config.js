/**
 * Jest — pure-logic tests only (no screen snapshots, no native bridge): the
 * link layer is dependency-injected TS, the store backends are jest-mocked,
 * and nothing imports react-native at test time. jest-expo supplies the
 * babel/expo transform pipeline; @/* maps to src/* like the app's tsconfig.
 */

module.exports = {
  preset: "jest-expo",
  rootDir: ".",
  roots: ["<rootDir>/src"],
  testMatch: ["<rootDir>/src/**/*.test.ts", "<rootDir>/src/**/*.test.tsx"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  setupFiles: ["<rootDir>/jest.setup.js"],
  transformIgnorePatterns: [
    // The canonical jest-expo allowlist (from the installed preset itself):
    // the RN/Expo ecosystem ships ESM that babel must transform — the
    // preset's own setup files included.
    "/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation))",
    "/node_modules/react-native-reanimated/plugin/",
    "/node_modules/@react-native/babel-preset/",
  ],
  clearMocks: true,
};
