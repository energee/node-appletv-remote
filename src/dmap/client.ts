/** Legacy DMAP session and remote client; never accepts modern HAP credentials. */
import { PersistentHttp } from '../util/http.js';
import { NowPlayingInfo, PlaybackState } from '../now-playing-info.js';
import { decodeDmap, encodeDmap, type DmapFields } from './codec.js';

export type DmapCapability = 'available' | 'unknown' | 'unsupported';

/** DMAP support is deliberately separate from AppleTV's AirPlay/MRP transport. */
export class DmapClient {
  readonly protocol = 'dmap' as const;
  private http: PersistentHttp;
  private credentials?: string;
  private session = 0;
  private generation = 0;
  private loginPending?: Promise<void>;
  private latest?: DmapFields;
  constructor(info: { address: string; dmapPort?: number; dmapAddress?: string }) {
    if (!info.dmapPort) throw new Error('No DMAP port available');
    this.http = new PersistentHttp(info.dmapAddress ?? info.address, info.dmapPort, {
      Accept: '*/*', 'Client-DAAP-Version': '3.13', 'Client-ATV-Sharing-Version': '1.2',
      'Client-iTunes-Sharing-Version': '3.15', 'User-Agent': 'Remote/1021',
      'Viewer-Only-Client': '1', 'Content-Type': 'application/x-www-form-urlencoded',
    });
  }

  /** Log in with a legacy pairing GUID or Home Sharing UUID, never HAP JSON/keys. */
  async connect(credentials: string): Promise<void> {
    if (typeof credentials !== 'string' || !/^(0x[0-9a-fA-F]{16}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/.test(credentials)) {
      throw new Error('DMAP requires a pairing GUID or Home Sharing UUID, not HAP credentials');
    }
    this.close();
    const generation = this.generation;
    this.credentials = credentials;
    try { await this.login(); } catch (error) { if (this.generation === generation) this.close(); throw error; }
  }

  private login(): Promise<void> {
    if (this.loginPending) return this.loginPending;
    const pending = this.performLogin();
    this.loginPending = pending;
    void pending.finally(() => { if (this.loginPending === pending) this.loginPending = undefined; }).catch(() => {});
    return pending;
  }

  private async performLogin(): Promise<void> {
    const generation = this.generation;
    if (!this.credentials) throw new Error('DMAP client is not connected');
    const key = this.credentials.startsWith('0x') ? 'pairing-guid' : 'hsgid';
    const response = await this.http.request('GET', `/login?${key}=${encodeURIComponent(this.credentials)}&hasFP=1`);
    if (this.generation !== generation) throw new Error('DMAP connection changed during login');
    if (response.status !== 200) throw new Error(`DMAP login HTTP ${response.status}`);
    const fields = decodeDmap(response.body).mlog as DmapFields | undefined;
    if (!fields || fields.mstt !== 200 || typeof fields.mlid !== 'number' || fields.mlid === 0) throw new Error('Invalid DMAP login session');
    this.session = fields.mlid;
  }

  private async request(method: 'GET' | 'POST', command: string, params: Record<string, string> = {}, body: Buffer = Buffer.alloc(0)): Promise<Buffer> {
    if (!this.credentials) throw new Error('DMAP client is not connected');
    const generation = this.generation;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.generation !== generation) throw new Error('DMAP connection changed');
      if (this.loginPending) await this.loginPending;
      if (this.generation !== generation || !this.session) throw new Error('DMAP client is not connected');
      const query = new URLSearchParams({ 'session-id': String(this.session), ...params });
      const response = await this.http.request(method, `/ctrl-int/1/${command}?${query}`, body);
      if (this.generation !== generation) throw new Error('DMAP connection changed');
      if (response.status >= 200 && response.status < 300) return response.body;
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        this.session = 0;
        try { await this.login(); } catch (error) { if (this.generation === generation) this.close(); throw error; }
        continue;
      }
      if (response.status === 401 || response.status === 403) this.close();
      throw new Error(`DMAP HTTP ${response.status}`);
    }
    throw new Error('DMAP authentication failed');
  }

  /** Release the HTTP pool and forget login/state. A later connect() can reopen it. */
  close(): void { this.generation++; this.loginPending = undefined; this.http.destroy(); this.session = 0; this.credentials = undefined; this.latest = undefined; }
  private async control(command: string): Promise<void> { await this.request('POST', command, { 'prompt-id': '0' }); }
  private async prompt(command: string): Promise<void> {
    await this.request('POST', 'controlpromptentry', { 'prompt-id': '0' }, Buffer.concat([encodeDmap('cmbe', command), encodeDmap('cmcc', Buffer.from([0]))]));
  }
  async play(): Promise<void> { await this.control('play'); }
  async pause(): Promise<void> { await this.control('pause'); }
  async stop(): Promise<void> { await this.control('stop'); }
  async playPause(): Promise<void> { await this.control('playpause'); }
  async next(): Promise<void> { await this.control('nextitem'); }
  async previous(): Promise<void> { await this.control('previtem'); }
  async select(): Promise<void> { await this.prompt('select'); }
  async menu(): Promise<void> { await this.prompt('menu'); }
  async topMenu(): Promise<void> { await this.prompt('topmenu'); }

  /** Seven pinned Remote touch events; always attempt release on the same session, preserving failures. */
  private async move(direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
    const vertical = direction === 'up' || direction === 'down';
    const decreasing = direction === 'up' || direction === 'left';
    const generation = this.generation;
    const sendTouch = async (i: number) => {
      const point = (decreasing ? 275 : 250) + (decreasing ? -5 : 5) * Math.min(i, 5);
      const horizontal = (decreasing ? 75 : 50) + (decreasing ? -5 : 5) * Math.min(i, 5);
      const text = `touch${i === 0 ? 'Down' : i === 6 ? 'Up' : 'Move'}&time=${vertical || i < 2 ? i : i + 1}&point=${vertical ? `20,${point}` : `${horizontal},100`}`;
      await this.request('POST', 'controlpromptentry', { 'prompt-id': '0' }, Buffer.concat([encodeDmap('cmcc', Buffer.from([0x30])), encodeDmap('cmbe', text)]));
    };
    let failed = false;
    try {
      for (let i = 0; i < 6; i++) await sendTouch(i);
    } catch (error) { failed = true; throw error; }
    finally {
      // Never release an old gesture on a replacement connection or obscure its failure.
      if (generation === this.generation) {
        try { await sendTouch(6); } catch (error) { if (!failed) throw error; }
      }
    }
  }

  async up(): Promise<void> { await this.move('up'); }
  async down(): Promise<void> { await this.move('down'); }
  async left(): Promise<void> { await this.move('left'); }
  async right(): Promise<void> { await this.move('right'); }

  /** Fetch a non-blocking snapshot; DMAP times are unsigned milliseconds, cant is remaining time. */
  async getState(): Promise<NowPlayingInfo> {
    const fields = decodeDmap(await this.request('GET', 'playstatusupdate', { 'revision-number': '0' })).cmst as DmapFields | undefined;
    if (!fields || fields.mstt !== 200) throw new Error('Invalid DMAP play status');
    this.latest = fields;
    const seconds = (value: unknown): number => typeof value === 'number' && value < 0xffffffff ? value / 1000 : 0;
    const duration = seconds(fields.cast);
    const elapsed = typeof fields.cant === 'number' && fields.cant < 0xffffffff && duration > 0 ? Math.max(0, duration - seconds(fields.cant)) : 0;
    const states: Record<number, PlaybackState> = { 0: PlaybackState.Stopped, 1: PlaybackState.Unknown, 2: PlaybackState.Stopped, 3: PlaybackState.Paused, 4: PlaybackState.Playing, 5: PlaybackState.Seeking, 6: PlaybackState.Seeking };
    const state = states[Number(fields.caps)] ?? PlaybackState.Unknown;
    return new NowPlayingInfo({ playbackState: state }, { title: fields.cann, artist: fields.cana, album: fields.canl, duration, elapsedTime: elapsed, playbackRate: state === PlaybackState.Playing ? 1 : 0, timestamp: Date.now() / 1000 });
  }

  /** Implemented media commands remain unknown until hardware/app execution; missing features are unsupported. */
  capabilities(): Record<string, DmapCapability> {
    const result: Record<string, DmapCapability> = {};
    for (const key of ['up', 'down', 'left', 'right', 'select', 'menu', 'topMenu']) result[key] = 'available';
    for (const key of ['play', 'pause', 'stop', 'playPause', 'next', 'previous']) result[key] = 'unknown';
    for (const [key, tag] of Object.entries({ title: 'cann', artist: 'cana', album: 'canl', duration: 'cast', elapsedTime: 'cant', playbackState: 'caps' })) result[key] = this.latest && Object.hasOwn(this.latest, tag) ? 'available' : 'unknown';
    for (const key of ['apps', 'accounts', 'power', 'keyboard', 'artwork', 'volume', 'seek', 'shuffle', 'repeat', 'pushUpdates']) result[key] = 'unsupported';
    return result;
  }
}
