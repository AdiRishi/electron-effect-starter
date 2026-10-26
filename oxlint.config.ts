import { defineConfig } from "oxlint";

const RESTRICTED_IMPORT_PATHS = [
  {
    name: "@app/client-runtime",
    message:
      "Import from an explicit @app/client-runtime/* subpath. The package has no root export.",
  },
  {
    name: "@app/shared",
    message: "Import from an explicit @app/shared/* subpath. The package has no root export.",
  },
];

const TEST_FILES = ["**/*.{test,spec}.{ts,tsx}", "**/tests/**", "**/test/**"];

export default defineConfig({
  ignorePatterns: [
    // A bare "repos" prunes the directory walk; "repos/**" ignores the files themselves.
    "repos",
    "repos/**",
    "dist",
    "dist-electron",
    "release",
    "node_modules",
    "**/routeTree.gen.ts",
  ],
  plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
  jsPlugins: ["./oxlint-plugin-app/index.ts"],
  categories: {
    correctness: "warn",
    suspicious: "warn",
    perf: "warn",
  },
  rules: {
    "oxc/no-accumulating-spread": "error",
    "eslint/no-control-regex": "off",
    "typescript/no-this-alias": "off",
    "unicorn/prefer-add-event-listener": "off",
    "unicorn/prefer-string-starts-ends-with": "off",
    "unicorn/prefer-set-has": "off",
    "unicorn/prefer-array-find": "off",
    "unicorn/no-new-array": "off",
    "unicorn/no-array-reverse": "off",
    "unicorn/no-array-sort": "off",
    "unicorn/consistent-function-scoping": "off",
    "react/no-object-type-as-default-prop": "off",
    "react/react-in-jsx-scope": "off",
    "react/no-array-index-key": "error",
    "react/no-unstable-nested-components": "error",
    "typescript/no-extraneous-class": "error",
    "eslint/no-empty-pattern": "error",
    "eslint/no-new": "error",
    "unicorn/no-useless-spread": "error",
    "eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
    ],
    "eslint/no-unsafe-optional-chaining": "error",
    "eslint/no-unneeded-ternary": "error",
    "unicorn/no-useless-fallback-in-spread": "error",
    "unicorn/require-module-specifiers": "error",
    "oxc/no-map-spread": "off",
    "eslint/no-shadow": "off",
    "eslint/no-await-in-loop": "off",
    "eslint/no-underscore-dangle": "off",
    "eslint/no-restricted-imports": ["error", { paths: RESTRICTED_IMPORT_PATHS }],
    "app/namespace-node-imports": "error",
    "app/no-global-process-runtime": "error",
    "app/no-inline-schema-compile": "error",
    "app/no-low-value-comments": "error",
    "app/no-manual-effect-runtime-in-tests": "error",
    "app/no-polling-loop-in-tests": "error",
    "app/no-real-time-wait-in-tests": "error",
    "app/no-test-in-loop": "error",
    "app/no-test-timeout-or-unreasoned-skip": "error",
    "app/no-wall-clock-in-tests": "error",
    "app/prefer-catch-tags": "error",
    "app/prefer-effect-fn": "error",
    "app/require-suppression-reason": "error",
  },
  overrides: [
    {
      files: TEST_FILES,
      rules: { "app/prefer-effect-fn": "off" },
    },
    {
      files: ["apps/web/tests/**/*.test.{ts,tsx}"],
      rules: { "app/require-disposable-render": "error" },
    },
    {
      files: ["apps/web/tests/**/*.browser.test.{ts,tsx}"],
      rules: { "app/no-frame-waits-in-browser-tests": "error" },
    },
    {
      files: ["packages/shared/src/HostProcess.ts"],
      rules: { "app/no-global-process-runtime": "off" },
    },
    {
      // Repo tooling and Electron bootstrap shims run before any Effect runtime exists.
      files: ["scripts/**", "apps/desktop/scripts/**"],
      rules: { "app/no-global-process-runtime": "off" },
    },
    {
      // React Compiler owns memoization.
      files: ["apps/web/src/**/*.{ts,tsx}"],
      rules: {
        "react/exhaustive-effect-dependencies": "error",
        "react/globals": "error",
        "react/hooks": "error",
        "react/immutability": "error",
        "react/jsx-no-constructed-context-values": "off",
        "react/memo-dependencies": "error",
        "react/preserve-manual-memoization": "error",
        "react/purity": "error",
        "react/refs": "error",
        "react/set-state-in-effect": "error",
        "react/set-state-in-render": "error",
        "react/static-components": "error",
        "react/unsupported-syntax": "error",
        "app/no-manual-memo": "error",
      },
    },
    {
      // React Compiler caches use* functions only if they call a hook.
      files: ["apps/web/src/**/*.{ts,tsx}"],
      rules: { "app/no-hookless-use-function": "error" },
    },
  ],
});
