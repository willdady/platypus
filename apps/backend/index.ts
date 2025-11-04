import { serve } from '@hono/node-server'
import app from './src/server.ts';

const PORT = process.env.PORT || '3000';

const main = async () => {
  console.clear();
  console.log(`Serving on port: ${PORT}`);
  serve({
    fetch: app.fetch,
    port: parseInt(PORT),
  });
};

await main();

// Needed for top-level await to work
export {};