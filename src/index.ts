import { config } from './config.js';
import { initClientMetrics } from './metrics.js';
import { Monitor } from './poller.js';
import { getChainId } from './rpc.js';
import { createServer } from './server.js';
import { initStartedAt, redis } from './store.js';

async function main(): Promise<void> {
  const startedAt = await initStartedAt(Math.floor(Date.now() / 1000));
  console.log(`[fcr-monitor] monitoring since ${new Date(startedAt * 1000).toISOString()}`);

  initClientMetrics(config.clients.map((client) => client.id));

  // A sanity check only — a failure here is logged, not fatal, since the node
  // may simply be starting up alongside us.
  for (const client of config.clients) {
    try {
      const chainId = await getChainId(client.rpcUrl, config.rpcTimeoutMs);
      console.log(`[fcr-monitor] ${client.label} -> chainId ${chainId}`);
    } catch (error) {
      console.warn(
        `[fcr-monitor] ${client.label} unreachable at startup: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const seen = new Set(config.clients.map((client) => client.rpcUrl));
  if (seen.size < config.clients.length) {
    console.warn(
      '[fcr-monitor] WARNING: both clients are configured with the same RPC URL. ' +
        'The dashboard will compare a node against itself and can never show cross-client divergence.',
    );
  }

  const monitor = new Monitor(config.clients);
  await monitor.start();

  const server = createServer().listen(config.port, config.host, () => {
    console.log(`[fcr-monitor] listening on ${config.host}:${config.port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[fcr-monitor] ${signal} received, shutting down`);
    monitor.stop();
    server.close();
    await redis.quit().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[fcr-monitor] fatal:', error);
  process.exit(1);
});
