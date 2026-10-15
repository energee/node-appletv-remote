/** Failed high-level connection setup must not leave command-capable clients. */
import { afterEach, expect, it, vi } from 'vitest';
import { AppleTV } from '../appletv.js';
import { AirPlayConnection } from '../connection.js';
import { CompanionConnection } from '../companion/connection.js';
import { Credentials } from '../credentials.js';
const credentials = new Credentials({ clientId: 'test', serverId: 'server', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32), serverLTPK: Buffer.alloc(32) });
afterEach(() => vi.restoreAllMocks());
it('failed AirPlay setup invalidates the high-level connection', async () => {
  const tv = new AppleTV({ name: 'offline', address: 'offline', port: 7000, deviceId: 'test', model: 'test' });
  vi.spyOn(AirPlayConnection.prototype, 'connect').mockRejectedValue(new Error('setup failed'));
  await expect(tv.connect(credentials)).rejects.toThrow('setup failed');
  await expect(tv.getState()).rejects.toThrow('Not connected');
});
it('failed Companion setup invalidates the high-level connection', async () => {
  const tv = new AppleTV({ name: 'offline', address: 'offline', port: 7000, deviceId: 'test', model: 'test' });
  vi.spyOn(CompanionConnection.prototype, 'connect').mockRejectedValue(new Error('setup failed'));
  await expect(tv.connectCompanion(credentials, 1234)).rejects.toThrow('setup failed');
  await expect(tv.sendCompanionRequest('test', new Map())).rejects.toThrow('Companion not connected');
});
it('rejects a second AirPlay connect instead of orphaning the first transport', async () => {
  const tv = new AppleTV({ name: 'offline', address: 'offline', port: 7000, deviceId: 'test', model: 'test' });
  vi.spyOn(AirPlayConnection.prototype, 'connect').mockResolvedValue();
  await tv.connect(credentials);
  await expect(tv.connect(credentials)).rejects.toThrow(/already connected/i);
  await tv.close();
});
it.each(['AirPlay', 'Companion'])('stale %s failure and close cannot invalidate a replacement', async (transport) => {
  const tv = new AppleTV({ name: 'offline', address: 'offline', port: 7000, deviceId: 'test', model: 'test', companionPort: 1234 });
  const instances: Array<AirPlayConnection | CompanionConnection> = [];
  let rejectFirst!: (error: Error) => void;
  const prototype = transport === 'AirPlay' ? AirPlayConnection.prototype : CompanionConnection.prototype;
  vi.spyOn(prototype, 'connect').mockImplementation(function (this: AirPlayConnection | CompanionConnection) {
    instances.push(this);
    return instances.length === 1 ? new Promise<void>((_resolve, reject) => { rejectFirst = reject; }) : Promise.resolve();
  });
  const connect = () => transport === 'AirPlay' ? tv.connect(credentials) : tv.connectCompanion(credentials);
  const first = connect().catch(e => e.message);
  await tv.close();
  await connect();
  rejectFirst(new Error('old setup failed'));
  expect(await first).toBe('old setup failed');
  instances[0].emit('close');
  await expect(connect()).rejects.toThrow(/already connected/i);
  await tv.close();
});

it.each(['AirPlay', 'Companion'])('ignores stale %s events after replacement', async transport => {
  const tv = new AppleTV({ name: 'offline', address: 'offline', port: 7000, deviceId: 'test', model: 'test', companionPort: 1234 });
  const prototype = transport === 'AirPlay' ? AirPlayConnection.prototype : CompanionConnection.prototype;
  vi.spyOn(prototype, 'connect').mockResolvedValue();
  const connect = () => transport === 'AirPlay' ? tv.connect(credentials) : tv.connectCompanion(credentials);
  await connect();
  const old = (tv as any)[transport === 'AirPlay' ? 'connection' : 'companionConnection'];
  await tv.close();
  await connect();
  const observed = vi.fn();
  tv.on(transport === 'AirPlay' ? 'nowPlaying' : 'companionEvent', observed);
  old.emit(transport === 'AirPlay' ? 'mrp-message' : 'event', transport === 'AirPlay' ? { type: 4, '.setStateMessage': { nowPlayingInfo: { title: 'stale' } } } : { identifier: 'stale', content: new Map(), data: new Map() });
  expect(observed).not.toHaveBeenCalled();
  await tv.close();
});

it('forwards sanitized diagnostics from setup and rejects stale session diagnostics', async () => {
  const tv = new AppleTV({ name: 'offline', address: 'offline', port: 7000, deviceId: 'test', model: 'test' });
  const instances: AirPlayConnection[] = [];
  vi.spyOn(AirPlayConnection.prototype, 'connect').mockImplementation(async function (this: AirPlayConnection) {
    instances.push(this);
    this.emit('mrp-diagnostic', { direction: 'send', type: 15, identifier: 'request-1' });
  });
  const observed: unknown[] = [];
  tv.on('mrpDiagnostic', value => observed.push(value));
  await tv.connect(credentials);
  expect(observed).toEqual([{ direction: 'send', type: 15, identifier: 'request-1' }]);
  await tv.close();
  await tv.connect(credentials);
  instances[0].emit('mrp-diagnostic', { direction: 'receive', type: 4 });
  expect(observed).toHaveLength(2);
  await tv.close();
});

it('does not enable diagnostic collection without an opt-in observer before connect', async () => {
  const tv = new AppleTV({ name: 'offline', address: 'offline', port: 7000, deviceId: 'test', model: 'test' });
  let count = -1;
  vi.spyOn(AirPlayConnection.prototype, 'connect').mockImplementation(async function (this: AirPlayConnection) {
    count = this.listenerCount('mrp-diagnostic');
  });
  await tv.connect(credentials);
  expect(count).toBe(0);
  await tv.close();
});

it('explicit close resets availability once and notifies after both transports are cleared', async () => {
  const tv = new AppleTV({ name: 'offline', address: 'offline', port: 7000, deviceId: 'test', model: 'test', companionPort: 1234 });
  vi.spyOn(AirPlayConnection.prototype, 'connect').mockResolvedValue();
  vi.spyOn(CompanionConnection.prototype, 'connect').mockResolvedValue();
  await tv.connect(credentials);
  await tv.connectCompanion(credentials);
  const availability = vi.fn();
  const close = vi.fn(() => {
    expect((tv as any).connection).toBeUndefined();
    expect((tv as any).companionConnection).toBeUndefined();
  });
  tv.on('featureAvailability', availability);
  tv.on('close', close);
  await tv.close();
  expect(availability).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
it.each(['AirPlay', 'Companion'])('does not forward stale %s errors after explicit close', async transport => {
  const tv = new AppleTV({ name: 'offline', address: 'offline', port: 7000, deviceId: 'test', model: 'test', companionPort: 1234 });
  vi.spyOn(transport === 'AirPlay' ? AirPlayConnection.prototype : CompanionConnection.prototype, 'connect').mockResolvedValue();
  await (transport === 'AirPlay' ? tv.connect(credentials) : tv.connectCompanion(credentials));
  const old = (tv as any)[transport === 'AirPlay' ? 'connection' : 'companionConnection'];
  const observed = vi.fn();
  tv.on(transport === 'AirPlay' ? 'error' : 'companionError', observed);
  await tv.close();
  old.emit('error', new Error('stale'));
  expect(observed).not.toHaveBeenCalled();
});
it.each(['AirPlay', 'Companion'])('forwards current %s failures even when transport close comes first', async transport => {
  const tv = new AppleTV({ name: 'offline', address: 'offline', port: 7000, deviceId: 'test', model: 'test', companionPort: 1234 });
  vi.spyOn(transport === 'AirPlay' ? AirPlayConnection.prototype : CompanionConnection.prototype, 'connect').mockResolvedValue();
  await (transport === 'AirPlay' ? tv.connect(credentials) : tv.connectCompanion(credentials));
  const conn = (tv as any)[transport === 'AirPlay' ? 'connection' : 'companionConnection'];
  const observed = vi.fn();
  tv.on(transport === 'AirPlay' ? 'error' : 'companionError', observed);
  conn.close();
  const error = new Error('current');
  conn.emit('error', error);
  expect(observed).toHaveBeenCalledWith(error);
});

it.each(['AirPlay', 'Companion'])('a failed %s setup that closes its transport emits no close event', async transport => {
  const tv = new AppleTV({ name: 'offline', address: 'offline', port: 7000, deviceId: 'test', model: 'test', companionPort: 1234 });
  const prototype = transport === 'AirPlay' ? AirPlayConnection.prototype : CompanionConnection.prototype;
  vi.spyOn(prototype, 'connect').mockImplementation(async function (this: AirPlayConnection | CompanionConnection) {
    this.emit('close');
    throw new Error('setup failed');
  });
  const closed = vi.fn();
  tv.on(transport === 'AirPlay' ? 'close' : 'companionClose', closed);
  await expect(transport === 'AirPlay' ? tv.connect(credentials) : tv.connectCompanion(credentials)).rejects.toThrow('setup failed');
  expect(closed).not.toHaveBeenCalled();
});

it('does not throw a facade error when a current transport fails without an error observer', async () => {
  const tv = new AppleTV({ name: 'offline', address: 'offline', port: 7000, deviceId: 'test', model: 'test' });
  vi.spyOn(AirPlayConnection.prototype, 'connect').mockResolvedValue();
  await tv.connect(credentials);
  const connection = (tv as any).connection;
  connection.close();
  expect(() => connection.emit('error', new Error('peer failed'))).not.toThrow();
});
