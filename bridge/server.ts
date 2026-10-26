import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Board } from './board.ts';
import type { BoardAction } from './types.ts';
import type { DesktopSource, DesktopEnvironment } from './desktop.ts';
import type { Configuration } from './config.ts';

export function makeServer(board: Board, demo: boolean, desktopSource?: DesktopSource | (() => DesktopSource | undefined), configuration?: Configuration) {
  const clients = new Set<ServerResponse>();
  const publish = (): void => {
    const data = `data: ${JSON.stringify({ ...board.view, demo, provider: configuration?.get().provider ?? 't3' })}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 128 * 1024) { client.destroy(); clients.delete(client); }
      else client.write(data);
    }
  };
  board.on('change', publish);
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body));
  };
  const body = async (req: IncomingMessage, limit = 4096): Promise<unknown> => {
    let text = '';
    for await (const chunk of req) { text += String(chunk); if (Buffer.byteLength(text) > limit) throw new Error('Request too large'); }
    return JSON.parse(text);
  };
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    const address = server.address();
    const host = `127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    if (req.headers.host !== host) { json(res, 403, { error: 'Use the bridge’s 127.0.0.1 address.' }); return; }
    const path = new URL(req.url ?? '/', `http://${host}`).pathname;
    try {
      if (path.startsWith('/desktop/')) {
        const desktop = typeof desktopSource === 'function' ? desktopSource() : desktopSource;
        if (!desktop || req.headers.origin !== 't3code://app') { json(res,403,{error:'T3 desktop origin required'}); return; }
        res.setHeader('access-control-allow-origin','t3code://app'); res.setHeader('vary','Origin');
        if(req.method==='OPTIONS'){res.setHeader('access-control-allow-methods','POST, GET');res.setHeader('access-control-allow-headers','content-type, x-threadboard-desktop');res.writeHead(204);res.end();return;}
        if(req.method==='GET'&&path==='/desktop/adapter.js'){
          const reader=await readFile(fileURLToPath(new URL('./thread-messages.js',import.meta.url)),'utf8');
          const adapter=await readFile(fileURLToPath(new URL('./desktop-adapter.js',import.meta.url)),'utf8');
          res.writeHead(200,{'content-type':'text/javascript'});res.end(reader+'\n'+adapter.replace("import {createMessageReader} from './thread-messages.js';",''));return;
        }
        if(req.method==='POST'&&path==='/desktop/attach'){json(res,200,{token:desktop.token});return;}
        if(req.method==='POST'&&path==='/desktop/snapshot'&&req.headers['x-threadboard-desktop']===desktop.token){
          const data=await body(req,4*1024*1024) as {environments:DesktopEnvironment[];result?:{id:string;ok:boolean}};
          desktop.receive(data.environments);
          if(data.result&&typeof data.result.id==='string'&&typeof data.result.ok==='boolean')desktop.result(data.result.id,data.result.ok);
          void board.refresh(); json(res,200,{commands:data.result?[]:desktop.commands()});return;
        }
        json(res,403,{error:'Invalid desktop channel'});return;
      }
      if (req.method === 'GET' && path === '/api/config') { json(res, 200, configuration?.get() ?? null); return; }
      if (req.method === 'POST' && path === '/api/config') {
        if (!configuration) { json(res, 404, { error: 'Configuration is unavailable in demo mode.' }); return; }
        if (req.headers.origin !== `http://${host}` || !req.headers['content-type']?.startsWith('application/json')) { json(res, 403, { error: 'Invalid request origin' }); return; }
        const input = await body(req);
        await board.configure(() => configuration.set(input));
        json(res, 200, configuration.get()); return;
      }
      if (req.method === 'GET' && path === '/api/state') { json(res, 200, { ...board.view, demo, provider: configuration?.get().provider ?? 't3' }); return; }
      if (req.method === 'GET' && path === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ ...board.view, demo, provider: configuration?.get().provider ?? 't3' })}\n\n`);
        clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'POST' && (path === '/api/action' || path === '/api/demo')) {
        if (req.headers.origin !== `http://${host}` || !req.headers['content-type']?.startsWith('application/json')) { json(res, 403, { error: 'Invalid request origin' }); return; }
        const data = await body(req) as Record<string, unknown>;
        if (!data || typeof data !== 'object') throw new Error('Invalid request');
        if (path === '/api/demo') {
          if (!demo) { json(res, 404, { error: 'Not found' }); return; }
          await board.demoState(Number(data.key), String(data.state));
        } else {
          if (!['select', 'next', 'stop', 'settle', 'scroll','choose','confirm','question','page'].includes(String(data.action)) || !Number.isInteger(data.key) || !Number.isInteger(data.token)) throw new Error('Invalid action');
          await board.act(data as unknown as BoardAction);
        }
        json(res, 200, { ok: true }); return;
      }
      const files: Record<string, [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
      const file = files[path];
      if (req.method === 'GET' && file) {
        res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' });
        res.end(await readFile(fileURLToPath(new URL(`../simulator/${file[0]}`, import.meta.url)))); return;
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : 'Action failed' }); }
  });
  server.on('close', () => { board.off('change', publish); for (const client of clients) client.destroy(); });
  return server;
}
