import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

/**
 * Flat config for ESLint 9.
 *
 * `eslint-config-next` 16 ships flat configs directly — wrapping them in
 * `FlatCompat` (the pre-16 recipe) hands the legacy loader a config it can't
 * validate, and the validator then crashes trying to stringify a circular
 * object rather than reporting anything useful. Import the entry point instead.
 *
 * Note this pulls in Next's rules and the TS *parser*, but no
 * `@typescript-eslint` rules are enabled by it.
 *
 * DECISION (task #43): the TypeScript rule set stays OFF, deliberately.
 *
 * Turning it on means adding `eslint-config-next/typescript` after
 * core-web-vitals. That was measured, not guessed: it produces 1242 errors and
 * 237 warnings, of which 1151 are `@typescript-eslint/no-explicit-any` and 188
 * `no-unused-vars`. Nothing else moves materially. So the question is really
 * "do we want to burn down 1151 `any`s", and nobody has asked for that; a rule
 * whose violations are never fixed is noise that trains people to ignore lint.
 *
 * Consequence handled at the same time: because those rules never ran, the
 * codebase had accumulated 46 `// eslint-disable-next-line @typescript-eslint/...`
 * comments suppressing rules that do not exist here. `eslint --fix` removed
 * them (they reported as "unused eslint-disable directive"), so the remaining
 * directives all reference rules that actually run.
 *
 * Revisit when either is true: someone commits to the `any` burn-down as
 * scheduled work, or a bug lands that `no-explicit-any` / `no-unused-vars`
 * would plausibly have caught. Re-measure before flipping — the baseline moves.
 */
const eslintConfig = [
  {
    // Flat config ignores only node_modules and .git by default. Everything
    // here is generated, vendored, or a copy of the repo — glob each with a
    // leading `**/` so nested builds (sideCar/.next) are caught too, not just
    // the ones at the root.
    ignores: [
      // Agent worktrees are whole copies of the repo: linting them reports
      // every problem several times over and drowns the real baseline.
      '.claude/**',
      '**/.next/**',
      '**/out/**',
      '**/build/**',
      '**/dist/**',
      '**/coverage/**',
      'data/**',
      'logs/**',
      'public/**',
      // Deploy scripts, and the credentials file that sits beside them.
      'scripts/private/**',
      'prisma/generated/**',
      'marketing/**',
      '**/next-env.d.ts',
      '**/*.min.js',
    ],
  },
  ...nextCoreWebVitals,
];

export default eslintConfig;
