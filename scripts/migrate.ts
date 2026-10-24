/**
 * Applies pending database migrations. Run as a release step before starting new API instances:
 *   npm run db:migrate
 */
import { connect } from '../src/bootstrap';
import { getConfig } from '../src/config/env';
import { disconnectDatabase } from '../src/db/connection';
import { runMigrations } from '../src/migrations';

const config = getConfig();
await connect(config);
try {
  const applied = await runMigrations(config);
  console.log(
    applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date.',
  );
} finally {
  await disconnectDatabase();
}
