import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@alimzen/source'] },
  ssr: { resolve: { conditions: ['@alimzen/source'] } },
});
