import { initDb, pool } from './db.js';
import { startIndexer } from './indexer.js';
import { startServer } from './server.js';

async function main() {
  await initDb();
  console.log('[db] ready');
  const stop = startIndexer();
  startServer();

  const shutdown = async () => {
    stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
