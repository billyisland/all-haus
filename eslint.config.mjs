import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

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

// THE HOOKS RULES ARE LIVE HERE, AND THIS IS THE ONLY LINT PASS THE WEB HAS.
//
// Until 2026-09-06 the story was that React/hooks/a11y/next-image rules were
// owned by `next lint` (web/package.json), a separate pass "left for later".
// It had never run: web/ carried no ESLint dependency and no config, so the CI
// step opened Next's interactive setup prompt, read EOF, and exited 1 on every
// run the job ever had — and since it preceded vitest, the web suite never
// executed in CI either. Sized against the real code (CONSOLIDATED-TODO §11,
// "CI has two RED jobs", item 8): the a11y rules found nothing, rules-of-hooks
// found nothing, no-img-element flagged the deliberate `<img>` for arbitrary-
// host media, no-unescaped-entities flagged apostrophes in prose. The one rule
// that earns its place is `exhaustive-deps` — §0v item 13(c) was exactly its
// bug class (an inline arrow in a dependency array restarting an effect every
// render, invisible to tsc and to tests). So that rule and its sibling live
// here, in the pass that already parses web/src type-aware, and `next lint` is
// gone: one lint pass that means one thing.
//
// The two are set by name rather than via the plugin's `recommended` preset,
// which since v6 also ships the React Compiler rule set — a different, much
// larger decision. `exhaustive-deps` is a WARNING under the standing 0-errors
// rule (warnings are accepted hygiene debt); `rules-of-hooks` is an ERROR
// because a violation is a bug by construction and there are none today.
const reactHooksRules = {
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/exhaustive-deps': 'warn',
};

// The source still carries inline `eslint-disable` comments targeting a11y and
// next-image rule names from the retired `next lint` era; declare those as
// no-ops so the directives stay valid instead of erroring "rule not found".
// Nothing enforces them, and that is now a decision rather than a gap.
const noop = () => ({ create: () => ({}) });
const externalRuleStubs = (names) => ({
  rules: Object.fromEntries(names.map((n) => [n, noop()])),
});
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
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11yStub,
      '@next/next': nextStub,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: { ...sharedRules, ...reactHooksRules },
  },
);
