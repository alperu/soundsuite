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
 * `@typescript-eslint` rules are enabled by it — see `eslint-config-next/typescript`
 * if the team wants those (it is a large baseline; measured in the task notes).
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
