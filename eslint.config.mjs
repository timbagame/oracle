import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "coverage/**", "idl/**", "*.sqlite", "*.db"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.bunBuiltin },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-binary-expression": "error",
      "no-control-regex": "off",
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
      "no-unsafe-finally": "off",
    },
  },
  {
    files: ["tests/**"],
    rules: {
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
  eslintConfigPrettier,
);
