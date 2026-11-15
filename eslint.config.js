import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.next-*/**", // isolated demo builds (NEXT_DIST_DIR)
      "**/.venv/**",
      "artifacts/**", // demo recording/editing scripts, not product code
      "**/dist/**",
      "**/build/**",
      "packages/app/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Inline-styles React codebase; underscore-args are the local idiom.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
          caughtErrors: "none",
        },
      ],
      // Zod schemas and R3F props lean on inference; explicit any is rare
      // but intentional where present.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
