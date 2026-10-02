import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  // Plain Node scripts, such as the package's bundling and smoke test.
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);
