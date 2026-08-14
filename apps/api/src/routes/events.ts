import { ownerAuth } from '../auth.js';
import type { App } from '../types.js';
import { z } from 'zod';

const eventQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
});

const eventHistoryQuerySchema = eventQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  waitSeconds: z.coerce.number().int().min(0).max(25).default(0),
});

export async function registerEventRoutes(app: App): Promise<void> {
  app.get('/api/events/history', { preHandler: ownerAuth(app, 'events:read') }, async (request) => {
    const query = eventHistoryQuerySchema.parse(request.query);
    const deadline = Date.now() + query.waitSeconds * 1_000;
    let events: Awaited<ReturnType<typeof loadEvents>> = [];
    do {
      events = await loadEvents(app, request.authUser!.id, query.after ?? 0, query.limit);
      if (events.length > 0 || Date.now() >= deadline) break;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(500, deadline - Date.now())),
      );
    } while (Date.now() < deadline);
    return {
      events,
      nextCursor: events.at(-1)?.id ?? String(query.after ?? 0),
      timedOut: query.waitSeconds > 0 && events.length === 0,
    };
  });

  app.get('/api/events', { preHandler: ownerAuth(app, 'events:read') }, async (request, reply) => {
    const userId = request.authUser!.id;
    const query = eventQuerySchema.parse(request.query);
    const requestedCursor = query.after ?? Number(request.headers['last-event-id'] ?? 0);
    let cursor =
      Number.isSafeInteger(requestedCursor) && requestedCursor >= 0 ? requestedCursor : 0;

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': agent-pool stream connected\n\n');

    let closed = false;
    let polling = false;
    let interval: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    reply.raw.on('close', () => {
      closed = true;
      if (interval) clearInterval(interval);
      if (heartbeat) clearInterval(heartbeat);
    });

    const sendNewEvents = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        const result = await app.db.query<{
          id: string;
          type: string;
          data: Record<string, unknown>;
          created_at: Date;
        }>(
          `SELECT id::text, type, data, created_at FROM user_events
           WHERE user_id = $1 AND id > $2 ORDER BY id ASC LIMIT 100`,
          [userId, cursor],
        );
        for (const event of result.rows) {
          cursor = Number(event.id);
          reply.raw.write(`id: ${event.id}\n`);
          reply.raw.write(`event: ${event.type}\n`);
          reply.raw.write(
            `data: ${JSON.stringify({ id: event.id, type: event.type, at: event.created_at.toISOString(), data: event.data })}\n\n`,
          );
        }
      } catch (error) {
        request.log.error({ error }, 'SSE event poll failed');
      } finally {
        polling = false;
      }
    };
    await sendNewEvents();
    interval = setInterval(() => void sendNewEvents(), 1_000);
    heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(`: pulse ${Date.now()}\n\n`);
    }, 15_000);
  });
}

async function loadEvents(app: App, userId: string, after: number, limit: number) {
  const result = await app.db.query<{
    id: string;
    type: string;
    data: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id::text, type, data, created_at FROM user_events
     WHERE user_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
    [userId, after, limit],
  );
  return result.rows.map((event) => ({
    id: event.id,
    type: event.type,
    at: event.created_at.toISOString(),
    data: event.data,
  }));
}
