/** `npm run recommendations:update` — rebuild per-user recommendation rows + related artists. */
import { createDb, closeDb, applyMigrations } from '@d7/database';
import { LinearScoringProvider, refreshRelatedArtists } from '@d7/service-recommendations';

async function main() {
  const db = await createDb();
  await applyMigrations(db);
  const engine = new LinearScoringProvider();
  const t0 = Date.now();
  const stats = await engine.computeAndPersist(db, { limit: 60 });
  const related = await refreshRelatedArtists(db);
  process.stdout.write(
    `recommendations: computed=${stats.computed} skipped=${stats.skipped} users=${stats.users} errors=${stats.errors} in ${Date.now() - t0}ms\n` +
      `related artists: ${JSON.stringify(related)}\n`,
  );
  await closeDb();
  setTimeout(() => process.exit(0), 120);
}

main().catch((err) => {
  process.stderr.write(`recommendation update failed: ${(err as Error).message}\n`);
  process.exit(1);
});
