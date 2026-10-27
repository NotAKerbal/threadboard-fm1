import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ShellSnapshot, Thread } from './types.ts';
import { questionRequest, validAnswers } from './desktop-adapter.js';
import { createMessageReader } from './thread-messages.js';

const run = promisify(execFile);
interface Session { sessionId: string; token: string; expiresAt: string }
interface Runtime { origin: string }
interface RpcReply { _tag: string; requestId?: string | number; exit?: { _tag: string; value?: unknown; cause?: unknown } }

export class T3Client {
  readonly cli: string;
  readonly baseDir: string;
  label = 'This Mac';
  environmentId = '';
  private session: Session | null = null;
  private verified = false;
  private origin = '';
  private socket: WebSocket | null = null;
  private ping: NodeJS.Timeout | null = null;
  private nextId = 0;
  private readMessages = createMessageReader(id => this.request(`/api/orchestration/threads/${encodeURIComponent(id)}`));
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(cli = process.env.T3CODE_CLI_PATH ?? 't3', baseDir = join(homedir(), '.t3')) { this.cli = cli; this.baseDir = baseDir; }
  private async command(args: string[]): Promise<string> {
    try {
      const { stdout } = await run(this.cli, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
      return stdout;
    } catch {
      // execFile errors include stdout, which can contain an issued credential.
      throw new Error('T3 CLI command failed. Check that T3 Code is running and T3CODE_CLI_PATH points to its CLI.');
    }
  }
  private async ensureSession(): Promise<void> {
    const runtime = JSON.parse(await readFile(join(this.baseDir, 'userdata', 'server-runtime.json'), 'utf8')) as Runtime;
    const url = new URL(runtime.origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('The bridge requires a local T3 server on 127.0.0.1.');
    if (this.verified && this.session && this.origin === url.origin && Date.parse(this.session.expiresAt) > Date.now() + 5 * 60_000) return;
    await this.close();
    this.origin = url.origin;
    this.session = JSON.parse(await this.command(['auth', 'session', 'issue', '--base-dir', this.baseDir, '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--ttl', '1h', '--label', 'Threadboard FM-1', '--json'])) as Session;
    if (!this.session.token || !this.session.sessionId || !Number.isFinite(Date.parse(this.session.expiresAt))) throw new Error('Unsupported T3 CLI session response.');
    await this.verifyDescriptor();
  }
  private async verifyDescriptor(): Promise<void> {
    const descriptor = await this.request('/.well-known/t3/environment') as { environmentId: string; label?: string; orchestrationProtocolVersion: number };
    if (descriptor.orchestrationProtocolVersion !== 2) throw new Error('This bridge supports T3 orchestration protocol 2.');
    if (typeof descriptor.environmentId !== 'string' || !/^[\w:-]+$/.test(descriptor.environmentId)) throw new Error('Invalid T3 environment identity.');
    this.environmentId = descriptor.environmentId;
    this.label = descriptor.label ?? this.label;
    this.verified = true;
  }
  private async request(path: string, method = 'GET'): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(this.origin + path, { method, redirect: 'error', headers: { authorization: `Bearer ${this.session!.token}`, 'x-t3-orchestration-protocol': '2' }, signal: AbortSignal.timeout(6000) });
    } catch { throw new Error(`Could not reach ${this.label}.`); }
    if (!res.ok) throw new Error(`T3 returned HTTP ${res.status}.`);
    return res.json();
  }
  async snapshot(): Promise<ShellSnapshot> {
    await this.ensureSession();
    const data = await this.request('/api/orchestration/shell') as ShellSnapshot;
    if (data.schemaVersion !== 2 || !Array.isArray(data.threads) || !Array.isArray(data.archivedThreads) || !Array.isArray(data.projects)) throw new Error('Unsupported T3 shell snapshot.');
    const ids = new Set<string>();
    for (const t of [...data.threads, ...data.archivedThreads]) {
      if (typeof t.id !== 'string' || ids.has(t.id) || typeof t.title !== 'string' || typeof t.projectId !== 'string' || !t.lineage || !('settledOverride' in t) || !('pendingRuntimeRequest' in t)) throw new Error('Incomplete T3 thread snapshot. Assignments have been preserved.');
      ids.add(t.id);
    }
    await this.readMessages(data.threads);
    return data;
  }
  async readThread(thread: Thread): Promise<void> {
    if (!thread.pendingRuntimeRequest) return;
    try { thread.questionRequest = questionRequest(await this.request(`/api/orchestration/threads/${encodeURIComponent(thread.id)}`), thread.pendingRuntimeRequest.id); }
    catch { thread.questionRequest = null; }
  }
  private disconnect(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    const ws = this.socket;
    this.socket = null;
    ws?.close();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('T3 command connection closed.')); }
    this.pending.clear();
  }
  private async connectRpc(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    const ticket = await this.request('/api/auth/websocket-ticket/rpc', 'POST') as { ticket: string };
    const url = new URL('/ws', this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('wsTicket', ticket.ticket);
    url.searchParams.set('orchestrationProtocol', '2');
    const ws = new WebSocket(url);
    this.socket = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('T3 command connection timed out.')); }, 6000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to T3 commands.')); }, { once: true });
    });
    ws.addEventListener('message', event => {
      try {
        const raw: unknown = JSON.parse(String(event.data));
        for (const frame of Array.isArray(raw) ? raw : [raw]) {
          const reply = frame as RpcReply;
          if (reply._tag === 'Defect' || reply._tag === 'ClientProtocolError') { this.disconnect(); return; }
          if (reply._tag !== 'Exit') continue;
          const p = this.pending.get(String(reply.requestId));
          if (!p) continue;
          this.pending.delete(String(reply.requestId)); clearTimeout(p.timer);
          if (reply.exit?._tag === 'Success') p.resolve(reply.exit.value);
          else p.reject(new Error('T3 rejected the command. Its thread state has not been changed locally.'));
        }
      } catch { this.disconnect(); }
    });
    ws.addEventListener('close', () => { if (this.socket === ws) this.disconnect(); });
    this.ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ _tag: 'Ping' })); }, 5000);
    this.ping.unref();
    return ws;
  }
  async dispatch(command: Record<string, unknown>): Promise<void> {
    await this.ensureSession();
    if (command.type === 'runtime-request.respond') {
      const fresh = questionRequest(await this.request(`/api/orchestration/threads/${encodeURIComponent(String(command.threadId))}`), String(command.requestId));
      if (!fresh || JSON.stringify(fresh) !== command.questionSignature || !validAnswers(fresh, fresh.kind === 'approval' ? {decision: command.decision} : command.answers)) throw new Error('This T3 request changed before submission.');
      const {questionSignature, ...input} = command;
      command = input;
    }
    const ws = await this.connectRpc();
    const id = String(++this.nextId);
    await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('T3 did not confirm the command. Refresh before retrying.')); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ _tag: 'Request', id, tag: 'orchestration.dispatchCommand', payload: { ...command, commandId: randomUUID() }, headers: [] }));
    });
  }
  async openThread(id: string): Promise<void> {
    const url = `t3code://threads/${encodeURIComponent(this.environmentId)}/${encodeURIComponent(id)}`;
    if (process.platform !== 'darwin') throw new Error('Opening the T3 desktop app currently requires macOS.');
    await run('/usr/bin/open', ['-a', process.env.THREADBOARD_T3_APP ?? 'T3 Code (Nightly)', url], { timeout: 6000 });
  }
  async close(): Promise<void> {
    this.verified = false;
    this.disconnect();
    const session = this.session; this.session = null;
    if (session) await this.command(['auth', 'session', 'revoke', '--base-dir', this.baseDir, session.sessionId]).catch(() => undefined);
  }
}
