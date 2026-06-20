import { createServer } from 'node:http';
import { latest, history, markets } from './db.js';

const PORT = Number(process.env.PORT ?? 8787);

function json(res: import('node:http').ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

// GET /health
// GET /markets                     → latest yes/no per market
// GET /yesno/latest?oracle=0x..    → most recent tick
// GET /yesno/history?oracle=0x..&limit=500 → series (ascending)
export function startServer(): void {
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const oracle = url.searchParams.get('oracle') ?? '';
      const limit = Math.min(2000, Number(url.searchParams.get('limit') ?? 500));

      if (url.pathname === '/health') return json(res, 200, { ok: true });
      if (url.pathname === '/markets') return json(res, 200, await markets());
      if (url.pathname === '/yesno/latest') {
        if (!oracle) return json(res, 400, { error: 'oracle required' });
        return json(res, 200, await latest(oracle));
      }
      if (url.pathname === '/yesno/history') {
        if (!oracle) return json(res, 400, { error: 'oracle required' });
        return json(res, 200, await history(oracle, limit));
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  }).listen(PORT, () => console.log(`[server] http://localhost:${PORT}`));
}
