import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@relayo/source'] },
  ssr: { resolve: { conditions: ['@relayo/source'] } },
});
