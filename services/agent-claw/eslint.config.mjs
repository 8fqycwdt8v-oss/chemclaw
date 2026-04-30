// ESLint v9 flat config — agent-claw.
//
// Rationale: eslint v9 prefers flat config; legacy `.eslintrc.cjs` requires
// `ESLINT_USE_FLAT_CONFIG=false` and a typescript-eslint v6 chain. Using
// flat config keeps us on the supported track and matches typescript-eslint
// v8's first-class flat-config exports.
//
// Status (post PR-1 paydown campaign + PR #38..#43 lint paydown):
//   - 46 rules from the strict-type-checked preset are flipped to
//     `error` and locked in via CI. The complete `no-unsafe-*` family
//     plus the capstone `no-explicit-any` are strictly enforced —
//     every implicit `any` that flows through agent-claw now fails CI.
//   - `no-unnecessary-condition` was the final high-volume warn-gated
//     rule. PRs #38–#43 swept it from 59 surfaced sites to zero, and
//     this config now error-gates it so future regressions break CI.
//     The campaign log is in the PR-43 description.
//   - Tests get extra latitude via the test-file override block below.

import tseslint from 'typescript-eslint';
import js from '@eslint/js';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      // Generated / vendored — not lintable as authored source.
      'src/types/sse.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Use a dedicated tsconfig that includes both src/ and tests/.
        // The default `tsconfig.json` excludes tests because tsc shouldn't
        // emit them, but eslint needs them in the type-aware project graph.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // High-volume rules still on warn — see the file-header status block.
      // Each remaining warn rule has a clear paydown path; flip to 'error'
      // once the surfaced sites are addressed.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-enum-comparison': 'error',
      // Allow number/boolean interpolation in template literals; both
      // produce unambiguous output and are idiomatic in error/log messages.
      // Disallow object/null/undefined interpolation since those produce
      // "[object Object]" / "null" / "undefined" — the no-base-to-string
      // rule (already 'error') catches the same class for objects,
      // restrict-template-expressions catches it for primitives.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: false },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/unbound-method': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-empty-object-type': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-arguments': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-reduce-type-parameter': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/dot-notation': 'error',
      '@typescript-eslint/consistent-generic-constructors': 'error',
      '@typescript-eslint/no-dynamic-delete': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-meaningless-void-operator': 'error',
      '@typescript-eslint/no-duplicate-type-constituents': 'error',
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-mixed-enums': 'error',
      '@typescript-eslint/prefer-includes': 'error',
      '@typescript-eslint/no-unused-expressions': 'error',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
      '@typescript-eslint/no-invalid-void-type': 'error',
      '@typescript-eslint/no-unnecessary-type-parameters': 'error',
      '@typescript-eslint/no-unnecessary-type-conversion': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Plain ESLint rules that strict-type-checked also enables.
      'no-empty': 'error',
      'no-control-regex': 'error',
      'no-useless-escape': 'error',
      'no-prototype-builtins': 'error',
      'prefer-const': 'error',
      'no-undef': 'off', // typescript handles this
    },
  },
  {
    // Async-contract conformance — these files implement interfaces
    // (HookCallback, LlmProvider, Tool.execute) whose signature
    // requires a Promise<X> return. Several implementations don't
    // happen to await anything but must stay `async` to satisfy the
    // contract. require-await would force every site to use
    // Promise.resolve() boilerplate or to be re-shaped against the
    // contract — neither change is worth the noise.
    files: [
      'src/core/hooks/**/*.ts',
      'src/llm/provider.ts',
      'src/tools/builtins/ask_user.ts',
      'src/tools/builtins/draft_section.ts',
      'src/tools/builtins/manage_todos.ts',
      'src/routes/forged-tools.ts',
      'src/routes/healthz.ts',
    ],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Tests get extra latitude: we already audit-fixture aggressively
    // and tests legitimately use `any` for mock typing.
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
