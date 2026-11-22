// @ts-check
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// The project never uses the em dash (U+2014); built from its code point so this file stays free of it.
const EM_DASH = String.fromCharCode(0x2014);

export default tseslint.config(
  {
    ignores: [
      "dist",
      "artifacts",
      "node_modules",
      // The video editing toolkit (Python, templates) and recorded test data are not app code.
      "toolkit",
      "server/test/support/fixtures",
      // Local agent data, including git worktrees with their own copy of the sources.
      ".claude",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-syntax": [
        "error",
        ...[
          `Literal[value=/${EM_DASH}/]`,
          `JSXText[value=/${EM_DASH}/]`,
          `TemplateElement[value.raw=/${EM_DASH}/]`,
        ].map((selector) => ({ selector, message: "Use a plain dash instead of an em dash." })),
      ],
    },
  },
  {
    // Components reach the backend and the store only through `@/lib/appEnv`, so tests can give
    // every test its own mock backend and store (`src/test/app.tsx`).
    files: ["src/app/**/*.{ts,tsx}", "src/features/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/ipc",
              importNames: ["api"],
              message: "Use useApi() from @/lib/appEnv.",
            },
            {
              name: "@/lib/store",
              importNames: ["useAppStore", "createAppStore"],
              message: "Use useAppState() or useAppStoreApi() from @/lib/appEnv.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs}", "vite.config.ts"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    // The server (docs/SPEC.md section 3): plain JavaScript, checked by `npm run server:typecheck`.
    files: ["server/**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: globals.node },
    rules: {
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-restricted-syntax": [
        "error",
        ...[`Literal[value=/${EM_DASH}/]`, `TemplateElement[value.raw=/${EM_DASH}/]`].map(
          (selector) => ({ selector, message: "Use a plain dash instead of an em dash." }),
        ),
      ],
    },
  },
  {
    // The in-page half of the end-to-end harness runs in the app's webview, not in Node.
    files: ["scripts/e2e/page/**/*.js"],
    languageOptions: { sourceType: "script", globals: globals.browser },
  },
  prettier,
);
