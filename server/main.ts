// The entry of the server: `node server/main.ts`. The settings come from the environment (SPEC.md, section 5).
import { startServer } from './app.ts';
import { loadConfig } from './config.ts';

try {
  const server = await startServer({ config: loadConfig() });
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      server.close().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error(error);
          process.exit(1);
        },
      );
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
