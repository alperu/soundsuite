/**
 * Jest config for the sidecar.
 *
 * The sidecar had no test harness before task #45: the root jest.config.js has
 * `roots: ['<rootDir>/src']`, which excludes this subtree entirely, and
 * sideCar/package.json carries no test dependencies. Jest and ts-jest resolve
 * from the repo root's node_modules, so run this from the repo root:
 *
 *   npx jest --config sideCar/jest.config.js
 *
 * There is deliberately no `test` script in sideCar/package.json — adding one
 * is outside this task's territory. Add it when convenient.
 *
 * The transform overrides sideCar/tsconfig.json's `module: esnext` /
 * `moduleResolution: bundler` / `isolatedModules`, none of which Jest can run.
 * Suites are node-environment: this is server-only code.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        moduleResolution: 'node',
        isolatedModules: false,
        esModuleInterop: true,
        jsx: 'react-jsx',
        target: 'ES2020',
        lib: ['dom', 'esnext'],
        allowJs: true,
        strict: true,
        skipLibCheck: true,
        paths: { '@/*': ['./src/*'] },
      },
    }],
  },
  testTimeout: 15000,
};
