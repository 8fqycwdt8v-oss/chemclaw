// ESLint v9 flat config — agent-claw.
//
// Rationale: eslint v9 prefers flat config; legacy `.eslintrc.cjs` requires
// `ESLINT_USE_FLAT_CONFIG=false` and a typescript-eslint v6 chain. Using
// flat config keeps us on the supported track and matches typescript-eslint
// v8's first-class flat-config exports.
//
// Strict-type-checked is the recommended preset; we soften the noisiest
// rules to `warn` for PR-1 so the gate stays practical. PR-4
// (refactor/typesafety) tightens these back to `error` after the explicit
// `any` casts in `sandbox.ts`, `step.ts`, etc. are paid down.

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
      // PR-1 baseline: keep these noisy rules as warnings so CI stays
      // green. PR-4 (refactor/typesafety) flips them back to error after
      // the documented `any`-cast paydown.
      // TODO(PR-4): cap any-casts; flip these back to 'error'.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-enum-comparison': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-confusing-void-expression': 'warn',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/unbound-method': 'warn',
      '@typescript-eslint/restrict-plus-operands': 'warn',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/only-throw-error': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-deprecated': 'warn',
      // Empty-object-type triggers on common Fastify type widening; warn for now.
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/return-await': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/no-unnecessary-type-arguments': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
      '@typescript-eslint/prefer-reduce-type-parameter': 'warn',
      '@typescript-eslint/consistent-type-definitions': 'warn',
      '@typescript-eslint/dot-notation': 'warn',
      '@typescript-eslint/consistent-generic-constructors': 'warn',
      '@typescript-eslint/no-dynamic-delete': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-meaningless-void-operator': 'warn',
      '@typescript-eslint/no-duplicate-type-constituents': 'warn',
      '@typescript-eslint/prefer-promise-reject-errors': 'warn',
      '@typescript-eslint/no-array-delete': 'warn',
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/no-mixed-enums': 'warn',
      '@typescript-eslint/prefer-includes': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
      '@typescript-eslint/no-invalid-void-type': 'error',
      '@typescript-eslint/no-unnecessary-type-parameters': 'warn',
      '@typescript-eslint/no-unnecessary-type-conversion': 'error',
      // PR-1 paydown: prefer-promise-reject-errors flipped to error after
      // wrapping signal.reason narrowing in lifecycle.ts.

      // Plain ESLint rules that strict-type-checked also enables.
      'no-empty': 'warn',
      'no-control-regex': 'warn',
      'no-useless-escape': 'warn',
      'no-prototype-builtins': 'warn',
      'prefer-const': 'warn',
      'no-undef': 'off', // typescript handles this
      // Allow underscore-prefixed unused locals, which are intentional.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
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
