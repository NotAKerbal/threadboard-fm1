import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ackFrame, decodeFrame, MSG, parseAction, snapshotFrames, SysExStream } from './protocol.ts';
import type { Board } from './board.ts';
import type { BoardView } from './types.ts';

export class MidiBridge {
  readonly board: Board;
  readonly binary: string;
  readonly name: string;
  private child: ReturnType<typeof spawn> | null = null;
  private session = randomBytes(4).readUInt32LE() || 1;
  private sent = false;
  private flushing = false;
  private stopped = false;
  private pending: BoardView | null = null;
  private seen = new Map<number, Promise<boolean>>();
  private parser = new SysExStream();
  constructor(board: Board, binary: string, name: string) { this.board = board; this.binary = binary; this.name = name; }
  start(): void {
    const child = spawn(this.binary, ['--name', this.name], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdin!.on('error',()=>{if(!this.stopped)this.board.setMidi({connected:false,name:null,error:'The MIDI helper disconnected. Restart the bridge to reconnect.'});});
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', line => {
      try {
        const msg = JSON.parse(line) as { type: string; connected?: boolean; name?: string; error?: string; bytes?: number[] };
        if (msg.type === 'status') {
          const connected = msg.connected === true;
          if (connected !== this.board.view.midi.connected) {
            this.session = randomBytes(4).readUInt32LE() || 1; this.seen.clear(); this.sent = false; this.parser = new SysExStream();
          }
          this.board.setMidi({ connected, name: msg.name ?? null, error: msg.error ?? null });
        } else if (msg.type === 'midi' && msg.bytes) {
          for (const bytes of this.parser.push(msg.bytes)) void this.receive(bytes);
        }
      } catch { /* Ignore unrelated MIDI and malformed helper output. */ }
    });
    child.on('error', () => this.board.setMidi({ connected: false, name: null, error: 'Build the MIDI helper with npm run build:midi.' }));
    child.on('exit', () => { if (!this.stopped) this.board.setMidi({ connected: false, name: null, error: 'The MIDI helper stopped. Restart the bridge to reconnect.' }); });
    child.stderr!.on('data', () => undefined);
    this.board.on('change', this.update);
    this.update(this.board.view);
  }
  private update = (view: BoardView): void => {
    if (!view.midi.connected || view.slots.length !== 27) return;
    this.pending = structuredClone(view);
    if (!this.flushing) void this.flush();
  };
  private send(bytes: number[]): void {
    if (!this.stopped && this.child?.stdin?.writable) this.child.stdin.write(JSON.stringify({ bytes }) + '\n');
  }
  private async flush(): Promise<void> {
    this.flushing = true;
    try {
      while (this.pending && !this.stopped) {
        const view = this.pending; this.pending = null;
        const session = this.session;
        for (const bytes of snapshotFrames(view, session)) {
          if (this.stopped || session !== this.session || !this.board.view.midi.connected) break;
          this.send(bytes);
          // Leave time for the panel's small SysEx receive ring between frames.
          await delay(12);
        }
        if (session === this.session && this.board.view.midi.connected) this.sent = true;
      }
    } finally { this.flushing = false; }
  }
  private async receive(bytes: number[]): Promise<void> {
    const body = decodeFrame(bytes);
    if (!body) return;
    if (body[1] === MSG.HELLO && body.length === 2) {
      this.session = randomBytes(4).readUInt32LE() || 1; this.seen.clear(); this.sent = false;
      this.update(this.board.view); return;
    }
    if (!this.sent) return;
    const session = this.session;
    const event = parseAction(body, session);
    if (!event) return;
    let result = this.seen.get(event.sequence);
    if (!result) {
      result = this.board.act(event.action).then(() => true, () => false);
      this.seen.set(event.sequence, result);
      if (this.seen.size > 128) this.seen.delete(this.seen.keys().next().value!);
    }
    const success = await result;
    if (session === this.session) this.send(ackFrame(session, event.sequence, success));
  }
  close(): void { this.stopped = true; this.board.off('change', this.update); this.child?.kill(); }
}
