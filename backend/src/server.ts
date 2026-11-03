import 'dotenv/config';
import { loadConfig } from './config.js';
import { AppDatabase } from './db.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = new AppDatabase(config.databasePath);
if (config.demoMode) db.seed(new Date());
const app = await buildApp({ config, db });

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

await app.listen({ host: config.host, port: config.port });
