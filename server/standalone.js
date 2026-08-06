/** Run the backend on its own (browser mode / `npm run dev`). */
import { startServer } from './index.js';

const port = Number(process.env.PORT ?? 4317);
const { port: actual } = await startServer(port);

console.log(`Bloom server  →  http://localhost:${actual}`);
