import { serve } from '@hono/node-server';
import { loadNodeConfig } from './config';
import { createNodeRuntime } from './create-node-app';

async function bootstrap() {
  const config = loadNodeConfig();
  const runtime = createNodeRuntime({ config });

  await runtime.startBackgroundTasks();

  const server = serve(
    {
      fetch: runtime.bundle.app.fetch,
      hostname: config.host,
      port: config.port,
    },
    (info) => {
      console.log(
        JSON.stringify({
          level: 'info',
          msg: `TickBell 2.0 listening on http://${info.address}:${info.port}`,
          runtime: 'node',
          dbPath: config.dbPath,
        }),
      );
    },
  );

  let shuttingDown = false;
  const handleSignal = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: 'info', msg: `Received ${signal}, shutting down gracefully...` }));
    server.close();
    await runtime.shutdown();
    process.exit(0);
  };

  process.once('SIGINT', () => void handleSignal('SIGINT'));
  process.once('SIGTERM', () => void handleSignal('SIGTERM'));
}

void bootstrap();
