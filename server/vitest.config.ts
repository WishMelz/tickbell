import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Nest relies on decorator metadata (emitDecoratorMetadata), which esbuild does not emit.
// unplugin-swc compiles TypeScript with SWC so DI works inside vitest.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    root: './',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: { NODE_ENV: 'test' },
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
