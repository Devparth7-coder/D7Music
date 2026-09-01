/** Programmatic entry for tests and for embedding the API in another process. */
export { buildServer, createContext, type AppContext, type CreateContextOptions } from './app.js';
export { buildCurrentUser, SESSION_COOKIE } from './plugins/session.js';
export { envelopeFor, ApiError } from './lib/http.js';
export { parseRange } from './routes/media.js';
export { verifyStripeSignature } from './routes/subscription.js';
export { oauthConfig, linkOAuthAccount } from './routes/auth.js';
export { applyShelfFilter } from './routes/home.js';
/** Vercel / serverless plumbing: the (req, res) bridge and the cron job surface. */
export { createHandler, getHandler, getServer, resolveRequestPath } from './vercel.js';
export { cronTokenMatches, JOB_NAMES, lockNameFor, type JobName } from './routes/jobs.js';
export { resolveStreamDelivery } from './routes/media.js';
