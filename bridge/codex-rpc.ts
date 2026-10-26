import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { connect } from 'node:net';
import { WebSocket } from 'ws';

export interface RpcMessage { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number } }

/** Shared sockets speak WebSocket, while a private app-server uses JSONL stdio. */
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams | null = null;
  private socket: WebSocket | null = null;
  private queued: string[] = [];
  private nextId = 0;
  private pending = new Map<string, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  closed = false;
  constructor(cli: string, home: string, args: string[], onMessage: (message: RpcMessage) => void, onClose: () => void) {
    const receive = (text: string): void => {
      if (this.closed) return;
      try {
        const reply = JSON.parse(text) as RpcMessage;
        // Server requests have their own ID namespace and can collide with client IDs.
        if (reply.method) { onMessage(reply); return; }
        const pending = this.pending.get(String(reply.id));
        if (!pending) return;
        this.pending.delete(String(reply.id)); clearTimeout(pending.timer);
        if (reply.error) pending.reject(new Error(`Codex RPC ${reply.error.code ?? 'error'} during ${pending.method}. Check the installed CLI's protocol support.`));
        else pending.resolve(reply.result);
      } catch { this.close(); }
    };
    const failed = (): void => this.close();
    if (args[0] === 'proxy') {
      const index = args.indexOf('--sock'), path = index < 0 ? join(home, 'app-server-control/app-server-control.sock') : args[index + 1]!;
      const socket = this.socket = new WebSocket('ws://localhost', { createConnection: () => connect({ path }), handshakeTimeout: 3000, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false, followRedirects: false });
      socket.on('open', () => { for (const text of this.queued) socket.send(text); this.queued = []; });
      socket.on('message', data => receive(String(data)));
      socket.on('error', failed); socket.on('close', () => { this.close(); onClose(); });
      return;
    }
    const child = this.child = spawn(cli, ['app-server', ...args], { env: { ...process.env, CODEX_HOME: home }, stdio: 'pipe' });
    child.stderr.resume();
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 32 * 1024 * 1024) { this.close(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line.trim()) receive(line);
      }
    });
    child.on('error', failed); child.on('exit', failed); child.stdin.on('error', failed);
    child.once('close', onClose);
  }
  send(message: RpcMessage): void {
    if (this.closed) throw new Error('Codex connection closed.');
    const text = JSON.stringify(message);
    if (this.socket) {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(text);
      else this.queued.push(text);
    } else this.child!.stdin.write(text + '\n');
  }
  request<T>(method: string, params: Record<string, unknown>, timeout = 15000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex connection closed.'));
    return new Promise<T>((resolve, reject) => {
      const id = `threadboard:${++this.nextId}`;
      const timer = setTimeout(() => this.close(), timeout);
      this.pending.set(id, { method, resolve: value => resolve(value as T), reject, timer });
      this.send({ id, method, params });
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`Codex connection closed or timed out during ${p.method}.`)); }
    this.pending.clear(); this.queued = []; this.child?.kill(); this.socket?.terminate();
  }
}
