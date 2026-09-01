/**
 * Process entry point. Keeps exactly one job: boot the context, listen, and shut the
 * schedulers down before the runtime exits — a half-stopped sync timer is how you get a
 * "phantom" run in the log five seconds after Ctrl-C.
 */
import { buildServer } from './app.js';
import { env } from '@d7/config';

async function main() {
  const { app } = await buildServer();

  const shutdown = async (signal: string) => {
    app.d7.log.info(`received ${signal}, shutting down`);
    const timer = setTimeout(() => {
      app.d7.log.warn('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 8000);
    timer.unref();
    try {
      await app.close();
      clearTimeout(timer);
      process.exit(0);
    } catch (err) {
      app.d7.log.error('shutdown failed', { message: (err as Error).message });
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: env.API_HOST, port: env.API_PORT });
    app.d7.log.info(`D7music API listening on http://${env.API_HOST}:${env.API_PORT}`, {
      env: env.NODE_ENV,
      webOrigin: env.WEB_ORIGIN,
      publicUrl: env.API_PUBLIC_URL,
    });
    if (env.secretsAreDefault && !env.isProd) {
      app.d7.log.warn('APP_SECRET is the built-in dev default — fine locally, fatal in production');
    }
  } catch (err) {
    app.d7.log.error('failed to start', { message: (err as Error).message, stack: (err as Error).stack?.split('\n')[1]?.trim() });
    process.exit(1);
  }
}

void main();
