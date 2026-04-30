// ESLint v9 flat config — agent-claw.
//
// Rationale: eslint v9 prefers flat config; legacy `.eslintrc.cjs` requires
// `ESLINT_USE_FLAT_CONFIG=false` and a typescript-eslint v6 chain. Using
// flat config keeps us on the supported track and matches typescript-eslint
// v8's first-class flat-config exports.
//
// Status (post PR-1 paydown campaign):
//   - 40 rules from the strict-type-checked preset are now flipped to
//     `error` and locked in via CI. New violations on those rules fail
//     the build.
//   - 8 rules remain on `warn` — all high-volume rules that need
//     genuine per-site code work to pay down:
//       * no-explicit-any            (top-level any reduction)
//       * no-unsafe-assignment       (~26 sites; mostly pg row types)
//       * no-unsafe-member-access    (~28 sites; mostly pg row types)
//       * no-unsafe-return           (~10 sites; pg row types)
//       * restrict-template-expressions (~98 sites; needs typed locals)
//       * no-unnecessary-condition   (~65 sites; needs guard rewrites)
//       * require-await              (~15 intentional async-contract conformance)
//       * no-useless-escape          (~16 cosmetic, inside char classes)
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
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-enum-comparison': 'error',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'warn',
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
      '@typescript-eslint/no-unnecessary-condition': 'warn',
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
      'no-useless-escape': 'warn',
      'no-prototype-builtins': 'error',
      'prefer-const': 'error',
      'no-undef': 'off', // typescript handles this
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
