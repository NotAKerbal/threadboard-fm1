import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { T3Client } from './t3.ts';
import { DesktopSource } from './desktop.ts';
import { CodexSource } from './codex.ts';
import { ClaudeSource } from './claude.ts';
import type { ShellSnapshot, Thread, ThreadSource } from './types.ts';

export const providers = ['t3', 'codex', 'claude'] as const;
export type Provider = typeof providers[number];
export interface SourceConfig { provider: Provider; homes: Record<Provider, string>; codexSocket?: string }
export interface Configuration { get(): SourceConfig; set(input: unknown): Promise<void> }
type Source = (ThreadSource & { close(): Promise<void> });
export type SourceFactory = (config: SourceConfig) => Promise<Source>;

function homePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw new Error('Enter an absolute home directory.');
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(expanded)) throw new Error('Enter an absolute home directory, such as ~/.codex.');
  return resolve(expanded);
}
function validate(input: unknown): SourceConfig {
  const c = input as SourceConfig | null;
  if (!c || !providers.includes(c.provider) || !c.homes) throw new Error('Choose T3 Code, Codex, or Claude Code.');
  return { provider: c.provider, homes: { t3: homePath(c.homes.t3), codex: homePath(c.homes.codex), claude: homePath(c.homes.claude) }, ...(c.codexSocket ? { codexSocket: homePath(c.codexSocket) } : {}) };
}

export class ConfiguredSource implements ThreadSource, Configuration {
  onChange?: () => void;
  private config: SourceConfig;
  private stateDir: string;
  private source: Source | null = null;
  private factory: SourceFactory;
  constructor(config: SourceConfig, stateDir: string, options: { t3Cli?: string; codexCli?: string; claudeCli?: string; factory?: SourceFactory } = {}) {
    this.config = validate(config); this.stateDir = stateDir;
    this.factory = options.factory ?? (async c => {
      if (c.provider === 'codex') return new CodexSource(c.homes.codex, stateDir, options.codexCli, c.codexSocket);
      if (c.provider === 'claude') return new ClaudeSource(c.homes.claude, stateDir, options.claudeCli);
      let environmentId: string;
      try { environmentId = (await readFile(join(c.homes.t3, 'userdata/environment-id'), 'utf8')).trim(); }
      catch { throw new Error(`No T3 Code environment at ${c.homes.t3}. Start T3 Code or choose another source in settings.`); }
      if (!/^[\w-]+$/.test(environmentId)) throw new Error('Invalid T3 environment identity.');
      return new DesktopSource(new T3Client(options.t3Cli, c.homes.t3), environmentId);
    });
  }
  static async read(stateDir: string): Promise<SourceConfig> {
    try { return validate(JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { provider: 't3', homes: { t3: join(homedir(), '.t3'), codex: homePath(process.env.CODEX_HOME ?? join(homedir(), '.codex')), claude: homePath(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')) } };
    }
  }
  get(): SourceConfig { return structuredClone(this.config); }
  async set(input: unknown): Promise<void> {
    const next = validate(input);
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const path = join(this.stateDir, 'config.json');
    await writeFile(`${path}.tmp`, JSON.stringify(next) + '\n', { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    await this.close(); this.config = next;
  }
  get environmentId(): string { return this.source?.environmentId ?? ''; }
  get capabilities(): { stop: boolean; answer: boolean } { return this.source?.capabilities ?? (this.config.provider === 't3' ? { stop: true, answer: true } : { stop: false, answer: false }); }
  get integration() { return this.source?.integration; }
  get desktop(): DesktopSource | undefined { return this.source instanceof DesktopSource ? this.source : undefined; }
  async snapshot(): Promise<ShellSnapshot> {
    this.source ??= await this.factory(this.config);
    this.source.onChange = () => this.onChange?.();
    return this.source.snapshot();
  }
  async readThread(thread: Thread): Promise<void> { await this.source?.readThread?.(thread); }
  async dispatch(command: Record<string, unknown>): Promise<void> {
    if (!this.source) throw new Error('Connect a thread source first.');
    await this.source.dispatch(command);
  }
  async openThread(id: string): Promise<void> {
    if (!this.source) throw new Error('Connect a thread source first.');
    await this.source.openThread(id);
  }
  async close(): Promise<void> { await this.source?.close(); this.source = null; }
}
