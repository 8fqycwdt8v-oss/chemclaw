// ESLint v9 flat config — agent-claw.
//
// Rationale: eslint v9 prefers flat config; legacy `.eslintrc.cjs` requires
// `ESLINT_USE_FLAT_CONFIG=false` and a typescript-eslint v6 chain. Using
// flat config keeps us on the supported track and matches typescript-eslint
// v8's first-class flat-config exports.
//
// Status (post PR-1 paydown campaign):
//   - 45 rules from the strict-type-checked preset are flipped to
//     `error` and locked in via CI. The complete `no-unsafe-*` family
//     plus the capstone `no-explicit-any` are strictly enforced —
//     every implicit `any` that flows through agent-claw now fails CI.
//   - 4 rules remain on `warn` — each is genuine high-volume per-site
//     code work that warrants its own focused PR rather than the
//     rolling-paydown approach used for the other 45:
//       * restrict-template-expressions (~98 sites; needs typed locals
//         around every `\${val}` interpolation of non-string values)
//       * no-unnecessary-condition      (~65 sites; needs guard
//         rewrites where TS proves the check is always true/false)
//       * require-await                 (~15 sites; intentional
//         async-contract conformance for hooks/tools/provider methods
//         that don't happen to await but must return Promises)
//       * no-useless-escape             (~16 cosmetic; regex escapes
//         inside character classes that are legal-but-redundant)
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
      'no-useless-escape': 'error',
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
