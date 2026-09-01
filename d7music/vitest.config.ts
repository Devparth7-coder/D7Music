import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const p = (d: string) => resolve(process.cwd(), d);

export default defineConfig({
  resolve: {
    alias: {
      '@d7/types': p('packages/types/src/index.ts'),
      '@d7/config': p('packages/config/src/index.ts'),
      '@d7/database': p('packages/database/src/index.ts'),
      '@d7/music-providers': p('packages/music-providers/src/index.ts'),
      '@d7/ui': p('packages/ui/src/index.ts'),
      '@d7/cache': p('packages/cache/src/index.ts'),
      '@d7/audio-storage': p('packages/audio-storage/src/index.ts'),
      '@d7/service-ai-assistant': p('services/ai-assistant/src/index.ts'),
      '@d7/api': p('apps/api/src/index.ts'),
      '@d7/service-release-sync': p('services/release-sync/src/index.ts'),
      '@d7/service-recommendations': p('services/recommendation-engine/src/index.ts'),
      '@d7/service-search': p('services/search/src/index.ts'),
      '@d7/service-notifications': p('services/notifications/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'services/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: 'forks',
  },
});
