import tseslint from 'typescript-eslint';

// Shared rule set, applied identically to backend services and the web
// frontend so standards don't drift between the two. The promise-safety
// rules are the reason this ESLint setup exists; the rest tames the noise
// from recommendedTypeChecked and keeps light hygiene.
const sharedRules = {
  // --- Promise safety (the reason this ESLint setup exists) ---
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': ['error', {
    checksVoidReturn: {
      arguments: false,   // Fastify route handlers, process.on, etc.
      properties: false,  // { preHandler: async () => {} }
      attributes: false,  // React onClick={async…} — React ignores the returned promise
    },
  }],
  '@typescript-eslint/await-thenable': 'error',

  // --- Disable noisy defaults from recommendedTypeChecked ---
  '@typescript-eslint/no-unsafe-argument': 'off',
  '@typescript-eslint/no-unsafe-assignment': 'off',
  '@typescript-eslint/no-unsafe-call': 'off',
  '@typescript-eslint/no-unsafe-member-access': 'off',
  '@typescript-eslint/no-unsafe-return': 'off',
  '@typescript-eslint/no-unsafe-enum-comparison': 'off',
  '@typescript-eslint/restrict-template-expressions': 'off',
  '@typescript-eslint/require-await': 'off',
  '@typescript-eslint/no-redundant-type-constituents': 'off',
  '@typescript-eslint/no-base-to-string': 'off',
  '@typescript-eslint/unbound-method': 'off',
  '@typescript-eslint/no-unnecessary-type-assertion': 'warn',

  // --- Light code hygiene ---
  '@typescript-eslint/no-unused-vars': ['warn', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
  }],
  '@typescript-eslint/no-explicit-any': 'warn',
  'no-duplicate-imports': 'error',
};

// The web frontend's React/hooks/a11y/next-image rules are owned by `next lint`
// (web/package.json), a separate pass we deliberately leave for later. The
// source carries inline `eslint-disable` comments targeting those rules; declare
// them here as no-ops so this root type-aware pass recognises the directives
// instead of erroring "rule not found". No enforcement happens here — that stays
// with next lint.
const noop = () => ({ create: () => ({}) });
const externalRuleStubs = (names) => ({
  rules: Object.fromEntries(names.map((n) => [n, noop()])),
});
const reactHooksStub = externalRuleStubs(['exhaustive-deps', 'rules-of-hooks']);
const jsxA11yStub = externalRuleStubs([
  'click-events-have-key-events',
  'no-static-element-interactions',
]);
const nextStub = externalRuleStubs(['no-img-element']);

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'web/.next/**', 'migrations/**'],
  },
  {
    // Backend services + shared.
    files: ['*/src/**/*.ts'],
    ignores: ['web/**'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: sharedRules,
  },
  {
    // Operator scripts. They are not deployed and nothing in CI runs them, so
    // they were ignored here for years — which is exactly how a `void
    // refundOutstanding(stripe).finally(...)` came to ship on the path that
    // recovers real money from a live card (§0t NOTE 6). Promise safety is
    // MORE load-bearing here, not less: a script is one process with no
    // supervisor, and a dropped promise is a run that exits reporting success
    // while its work is still in flight or already failed.
    //
    // They sit outside every workspace's own tsconfig (rootDir: src), so each
    // scripts/ directory carries a noEmit tsconfig.json of its own purely to
    // give the type-aware rules a project to read.
    files: ['scripts/**/*.ts', '*/scripts/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: sharedRules,
  },
  {
    // Web frontend — client-side async is exactly where unhandled promises bite.
    files: ['web/src/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    plugins: {
      'react-hooks': reactHooksStub,
      'jsx-a11y': jsxA11yStub,
      '@next/next': nextStub,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: sharedRules,
  },
);
