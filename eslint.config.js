// ESLint 9 flat config, one convention for every TS workspace (ADR-0005).
// No core eslint "recommended" preset: typescript-eslint's recommended set
// replaces it, and no-undef stays off because TypeScript already covers it.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // design/demos are the owner's reference mockups, not product code —
    // they don't meet (and don't need to meet) our lint rules.
    ignores: ["**/dist/**", "coverage/**", "src-tauri/target/**", "design/demos/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Names starting with "_" mark deliberately-unused type-level assertions (see shared/src/index.test.ts).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
