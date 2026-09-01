/**
 * Vercel Serverless Function entry point.
 *
 * Vercel looks for `api/**` at the project root and turns each file into one function. Ours is a
 * one-line re-export of the real bridge in `apps/api/src/vercel.ts`, so every route the API serves
 * — including `/api/jobs/*` for Vercel Cron — is reachable through this single function via the
 * `rewrites` block in `vercel.json`.
 *
 * This file is not used by `npm run dev`, the Docker image, or systemd; those run `apps/api/src/main.ts`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import vercelHandler from '../apps/api/src/vercel.js';

export default async function request(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await vercelHandler(req, res);
}
