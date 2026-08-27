// Must be first: this populates process.env before any other module reads it.
import 'dotenv/config';

import { startBot } from './bot/discordBot.js';
import { flushPendingWrites } from './data/dataManager.js';
import { startWebServer } from './web/server.js';

/**
 * Entry point. The web panel and the Discord bot share one process so the panel
 * can call `triggerUpdate()` directly instead of going over the network.
 */
async function main(): Promise<void> {
  const server = await startWebServer();
  const client = await startBot();

  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[app] ${signal} reçu, arrêt en cours…`);

    void (async () => {
      server.close();
      await client.destroy();
      // Let any queued JSON write finish before the process goes away.
      await flushPendingWrites();
      process.exit(0);
    })();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('[app] démarrage impossible:', err);
  process.exit(1);
});
