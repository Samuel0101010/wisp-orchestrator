import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { ZodError } from 'zod';

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

export function wrap(fn: Handler): RouteHandlerMethod {
  return async function handler(this: unknown, req, reply) {
    try {
      return await fn(req, reply);
    } catch (err) {
      if (err instanceof ZodError) {
        reply.code(400);
        return {
          error: 'validation_error',
          issues: err.issues.map((i) => ({
            path: i.path,
            message: i.message,
            code: i.code,
          })),
        };
      }
      throw err;
    }
  };
}
