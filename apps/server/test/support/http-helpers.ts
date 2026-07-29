import type { FastifyInstance } from 'fastify';

export function json(reply: Awaited<ReturnType<FastifyInstance['inject']>>): any {
  return reply.json() as any;
}
