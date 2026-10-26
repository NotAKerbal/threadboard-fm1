import type { BoardAction, BoardView, LightState } from './types.ts';

export const PROTOCOL_VERSION = 5;
export const COMMAND = 0x70;
export const MSG = { BEGIN: 0, SLOT: 1, COMMIT: 2, ACK: 3, ACTION: 4, HELLO: 5, QUESTION:6, RESULT:7 } as const;
export const ACTION = { select: 0, next: 1, stop: 2, settle: 3, scroll: 4,choose:5,confirm:6,question:7,page:8 } as const;
export const STATES: LightState[] = ['empty', 'idle', 'working', 'attention', 'unavailable', 'snoozed'];
export function pack7(bytes: Uint8Array): number[] {
  const result: number[] = []; let acc = 0; let bits = 0;
  for (const b of bytes) { acc |= b << bits; bits += 8; while (bits >= 7) { result.push(acc & 127); acc >>>= 7; bits -= 7; } }
  if (bits) result.push(acc & 127);
  return result;
}
export function unpack7(bytes: number[]): Buffer {
  const out: number[] = []; let acc = 0; let bits = 0;
  for (const b of bytes) { if (b < 0 || b > 127) throw new Error('Invalid SysEx data'); acc |= b << bits; bits += 7; while (bits >= 8) { out.push(acc & 255); acc >>>= 8; bits -= 8; } }
  return Buffer.from(out);
}
export function frame(body: Uint8Array): number[] {
  if (body.length > 300) throw new Error('Threadboard frame is too large');
  const raw = Buffer.alloc(body.length + 7);
  raw[1] = 0x59; raw[2] = COMMAND; raw.writeUIntLE(body.length, 3, 3); raw.set(body, 6);
  raw[raw.length - 1] = ~body.reduce((a, b) => a + b, 0) & 255;
  return [0xf0, ...pack7(raw), 0xf7];
}
export function decodeFrame(bytes: number[]): Buffer | null {
  if (bytes[0] !== 0xf0 || bytes.at(-1) !== 0xf7 || bytes.length > 400) return null;
  const raw = unpack7(bytes.slice(1, -1));
  if (raw.length < 7 || raw[0] !== 0 || raw[1] !== 0x59 || raw[2] !== COMMAND || raw.readUIntLE(3, 3) !== raw.length - 7) return null;
  const body = raw.subarray(6, -1);
  return raw.at(-1) === (~body.reduce((a, b) => a + b, 0) & 255) && body[0] === PROTOCOL_VERSION ? body : null;
}
const text = (s: string, max: number): Buffer => Buffer.from(s.normalize('NFKD').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').slice(0, max), 'ascii');
function header(type: number, session: number, revision: number): Buffer {
  const b = Buffer.alloc(10); b[0] = PROTOCOL_VERSION; b[1] = type; b.writeUInt32LE(session, 2); b.writeUInt32LE(revision, 6); return b;
}
export function snapshotFrames(view: BoardView, session: number): number[][] {
  const frames = [frame(header(MSG.BEGIN, session, view.revision))];
  for (const slot of view.slots) {
    const project = text(slot.project, 30), title = text(slot.title, 80), detail = text(slot.detail, 144);
    const data = Buffer.alloc(9); data[0] = slot.key; data[1] = STATES.indexOf(slot.state); data.writeUInt32LE(slot.token, 2); data[6] = project.length; data[7] = title.length; data[8] = detail.length;
    const notification = Buffer.alloc(4); notification.writeUInt32LE(slot.attentionSerial ?? 0);
    frames.push(frame(Buffer.concat([header(MSG.SLOT, session, view.revision), data, project, title, detail, notification])));
  }
  const q=view.question,question=Buffer.alloc(12),qHeader=text(q?.header??'',30),qText=text(q?.text??'',240);
  if(q){question[0]=1|(q.multiSelect?2:0)|(q.canSubmit?4:0)|(q.submitted?8:0);question[1]=q.index;question[2]=q.total;question[3]=q.page;question[4]=q.pages;question[5]=q.answered;question.writeUInt32LE(q.token,6);}
  question[10]=qHeader.length;question[11]=qText.length;
  frames.push(frame(Buffer.concat([header(MSG.QUESTION,session,view.revision),question,qHeader,qText])));
  const excerpt=view.result??view.preview;
  const result=text(excerpt?.threadId===view.slots[view.selected]?.threadId?excerpt?.text??'':'',1200);
  // Ordered chunks stay inside the FM-1's small SysEx receive buffer.
  for(let offset=0;offset<Math.max(1,result.length);offset+=240){
    const meta=Buffer.alloc(4);meta.writeUInt16LE(result.length,0);meta.writeUInt16LE(offset,2);
    frames.push(frame(Buffer.concat([header(MSG.RESULT,session,view.revision),meta,result.subarray(offset,offset+240)])));
  }
  const meta = Buffer.alloc(4); meta[0] = view.connected ? 1 : 0; meta[1] = view.selected; meta.writeUInt16LE(Math.min(65535, view.overflow), 2);
  frames.push(frame(Buffer.concat([header(MSG.COMMIT, session, view.revision), meta])));
  return frames;
}
export function parseAction(body: Buffer, session: number): { sequence: number; action: BoardAction } | null {
  if (body.length !== 16 || body[1] !== MSG.ACTION || body.readUInt32LE(2) !== session) return null;
  const name = Object.keys(ACTION).find(k => ACTION[k as keyof typeof ACTION] === body[8]) as keyof typeof ACTION | undefined;
  if (!name) return null;
  return { sequence: body.readUInt16LE(6), action: { action: name, key: body[9]!, token: body.readUInt32LE(10), value: body.readInt16LE(14) } };
}
export function ackFrame(session: number, sequence: number, success: boolean): number[] {
  const b = Buffer.alloc(9); b[0] = PROTOCOL_VERSION; b[1] = MSG.ACK; b.writeUInt32LE(session, 2); b.writeUInt16LE(sequence, 6); b[8] = success ? 1 : 0; return frame(b);
}
export class SysExStream {
  private bytes: number[] = [];
  push(chunk: number[]): number[][] {
    const frames: number[][] = [];
    for (const b of chunk) {
      if (b >= 0xf8) continue;
      if (b === 0xf0) this.bytes = [b];
      else if (this.bytes.length && (b < 128 || b === 0xf7)) {
        this.bytes.push(b);
        if (b === 0xf7) { frames.push(this.bytes); this.bytes = []; }
        else if (this.bytes.length > 400) this.bytes = [];
      } else this.bytes = [];
    }
    return frames;
  }
}
