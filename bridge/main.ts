import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board } from './board.ts';
import { makeServer } from './server.ts';
import { T3Client } from './t3.ts';
import { MidiBridge } from './midi.ts';
import { DesktopSource } from './desktop.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (flag: string, fallback: string): string => { const i = args.indexOf(flag); return i === -1 ? fallback : args[i + 1] ?? fallback; };
const demo = args.includes('--demo');
const stateDir = resolve(option('--state-dir', join(root, '.state')));
const port = Number(option('--port', demo ? '4782' : '4781'));
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port');
let lock: Awaited<ReturnType<typeof open>> | null = null;
const lockPath = join(stateDir, 'bridge.lock');
if (!demo) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const pid = Number((await readFile(lockPath, 'utf8')).trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid bridge lock. Inspect .state/bridge.lock before removing it.');
    try { process.kill(pid, 0); throw new Error('Another Threadboard bridge is already running.'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      await unlink(lockPath); lock = await open(lockPath, 'wx', 0o600);
    }
  }
  await lock.writeFile(String(process.pid));
}
const t3Home = option('--t3-home', join(process.env.HOME!, '.t3'));
const local = demo ? null : new T3Client(option('--t3-cli', process.env.T3CODE_CLI_PATH ?? 't3'), t3Home);
const client = local ? new DesktopSource(local, (await readFile(join(t3Home, 'userdata/environment-id'), 'utf8')).trim()) : null;
const board = new Board(client, stateDir, demo);
const midi = demo || args.includes('--no-midi') ? null : new MidiBridge(board, join(root, 'output/threadboard-midi'), option('--midi-name', 'Felucca'));
const server = makeServer(board, demo, client ?? undefined);
let closing = false;
let interval: NodeJS.Timeout | null = null;
async function close(): Promise<void> {
  if (closing) return; closing = true;
  if (interval) clearInterval(interval);
  midi?.close();
  server.closeAllConnections(); server.close();
  await client?.close();
  await lock?.close();
  if (lock) await unlink(lockPath).catch(() => undefined);
}
process.on('SIGINT', () => { void close().finally(() => process.exit()); });
process.on('SIGTERM', () => { void close().finally(() => process.exit()); });
server.on('error', error => { console.error(error.message); void close().finally(() => process.exit(1)); });
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log(`Threadboard ${demo ? 'demo' : 'bridge'}: http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`);
});
await board.refresh();
midi?.start();
interval = setInterval(() => { void board.refresh(); }, 2000);
if (args.includes('--smoke')) {
  console.log(JSON.stringify({ connected: board.view.connected, assigned: board.view.slots.filter(s => s.threadId).length, overflow: board.view.overflow, error: board.view.error }));
  await close(); process.exit(board.view.connected ? 0 : 1);
}
