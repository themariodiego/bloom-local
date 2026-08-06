import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { router } from './routes.js';
import { WEB_DIST } from './paths.js';
import { ClaudeError } from './claude.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.use('/api', router);

  // Serve the built frontend when it exists (production / Electron).
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(WEB_DIST, 'index.html'));
    });
  }

  // eslint-disable-next-line no-unused-vars -- Express needs the 4-arg shape
  app.use((err, _req, res, _next) => {
    const status = err instanceof ClaudeError ? 502 : 500;
    if (!(err instanceof ClaudeError)) console.error('[bloom]', err);
    res.status(status).json({
      error: err.message || 'Something went wrong.',
      kind: err instanceof ClaudeError ? err.kind : 'server_error',
    });
  });

  return app;
}

/** Start on `port`, or on a free port when 0 is passed. Resolves the real port. */
export function startServer(port = 0) {
  return new Promise((resolve, reject) => {
    const server = createApp().listen(port, '127.0.0.1');
    server.once('listening', () =>
      resolve({ server, port: server.address().port }),
    );
    server.once('error', reject);
  });
}
