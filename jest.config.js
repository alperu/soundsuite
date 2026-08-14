module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  // `setupFiles`, NOT `setupFilesAfterEnv`: these have to land before the
  // module registry evaluates a test's imports. See jest.polyfills.js.
  setupFiles: ['<rootDir>/jest.polyfills.js'],
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx', '**/?(*.)+(spec|test).ts', '**/?(*.)+(spec|test).tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', {
      tsconfig: {
        jsx: 'react-jsx',
        allowJs: true,
      },
    }],
  },
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
  ],
  testTimeout: 30000, // 30 seconds for OCR tests
  transformIgnorePatterns: [
    // `@xenova/transformers` is ESM ("export * from './pipelines.js'") and went
    // untransformed, so any suite importing it died at parse with
    // "Unexpected token 'export'" before running a test (task #84).
    'node_modules/(?!(chokidar|p-queue|p-timeout|eventemitter3|@langchain|@haxall|haystack-core|@xenova)/)',
  ],
};
