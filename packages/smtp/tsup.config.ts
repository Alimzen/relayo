import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // Resolve @alimzen/core through its published types, so they are referenced rather than inlined.
  dts: { compilerOptions: { customConditions: [] } },
  sourcemap: true,
  clean: true,
  target: 'node20',
});
