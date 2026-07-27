import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, epochOfSlot, slotOfTimestamp } from './config.js';
import { registry } from './metrics.js';
import { countReorgs, getReorgs, getStartedAt, loadSnapshot, redis, type ClientSnapshot } from './store.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

interface TagView {
  number: number;
  hash: string;
  timestamp: number;
  slot: number;
  epoch: number;
  ageSeconds: number;
}

function toTagView(block: ClientSnapshot['safe'], now: number): TagView | null {
  if (!block) return null;
  const slot = slotOfTimestamp(block.timestamp);
  return {
    number: block.number,
    hash: block.hash,
    timestamp: block.timestamp,
    slot,
    epoch: epochOfSlot(slot),
    ageSeconds: now - block.timestamp,
  };
}

export function createServer() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/state', async (_req, res) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const snapshots = await Promise.all(config.clients.map((client) => loadSnapshot(client.id)));

      const clients = config.clients.map((client, index) => {
        const snapshot = snapshots[index];
        return {
          id: client.id,
          label: client.label,
          version: client.version,
          releaseUrl: client.releaseUrl,
          online: snapshot?.online ?? false,
          error: snapshot ? snapshot.error : 'no data yet',
          updatedAt: snapshot?.updatedAt ?? null,
          trackedSafeBlocks: snapshot?.trackedSafeBlocks ?? 0,
          safe: toTagView(snapshot?.safe ?? null, now),
          finalized: toTagView(snapshot?.finalized ?? null, now),
          latest: toTagView(snapshot?.latest ?? null, now),
        };
      });

      const divergence = (['safe', 'finalized'] as const).map((tag) => {
        const a = clients[0]?.[tag];
        const b = clients[1]?.[tag];
        return {
          tag,
          diverged: Boolean(a && b && a.number === b.number && a.hash !== b.hash),
        };
      });

      res.json({
        now,
        startedAt: await getStartedAt(),
        chain: config.chain,
        pollIntervalMs: config.pollIntervalMs,
        epochsShown: config.epochsShown,
        currentSlot: slotOfTimestamp(now),
        clients,
        plannedClients: config.plannedClients,
        divergence,
        reorgCount: await countReorgs(),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/reorgs', async (_req, res) => {
    try {
      res.json({
        startedAt: await getStartedAt(),
        now: Math.floor(Date.now() / 1000),
        reorgs: await getReorgs(),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  });

  app.get('/healthz', async (_req, res) => {
    try {
      await redis.ping();
      res.json({ status: 'ok' });
    } catch (error) {
      res.status(503).json({ status: 'degraded', error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.use(express.static(publicDir, { maxAge: '5m', index: 'index.html' }));

  return app;
}
