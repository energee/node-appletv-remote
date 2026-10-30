/**
 * Keyboard text-focus state from Companion RTI: the `_tiStart` reply carries `_tiD` only when a
 * text field is focused, and a started session then receives `_tiStarted`/`_tiStopped` events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppleTV, KeyboardFocusState } from '../appletv.js';
import type { CompanionEvent } from '../appletv.js';
import { CompanionConnection } from '../companion/connection.js';
import { Credentials } from '../credentials.js';
import type { OpackDict, OpackValue } from '../companion/opack.js';

const credentials = new Credentials({ clientId: 'test', serverId: 'server', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32), serverLTPK: Buffer.alloc(32) });
const liveDevice = () => new AppleTV({ name: 'TV', address: '127.0.0.1', port: 7000, deviceId: 'test', model: 'test', companionPort: 1234 });
const device = () => new AppleTV({ name: 'TV', address: '127.0.0.1', port: 7000, deviceId: 'test', model: 'test' });
function connectionReply(id: string): OpackDict {
  const content: OpackDict = new Map();
  if (id === '_sessionStart') content.set('_sid', 42);
  return new Map([['_c', content]]);
}
beforeEach(() => { vi.spyOn(CompanionConnection.prototype, 'sendMessage').mockImplementation(() => {}); });

/** Companion fake whose `_tiStart` reply is focused (`_tiD` present) or unfocused (empty `_c`). */
function companion(focused: boolean) {
  const atv = device();
  const sent: string[] = [];
  (atv as any).companionConnection = {
    close: vi.fn(),
    sendRequest: vi.fn(async (id: string) => {
      sent.push(id);
      const c = id === '_tiStart' && focused ? new Map<OpackValue, OpackValue>([['_tiD', Buffer.alloc(0)]]) : new Map();
      return new Map<OpackValue, OpackValue>([['_c', c]]);
    }),
    sendMessage: vi.fn(),
  };
  return { atv, sent };
}

const event = (identifier: string, content: OpackDict): CompanionEvent =>
  ({ identifier, data: new Map<OpackValue, OpackValue>([['_i', identifier], ['_t', 1], ['_c', content]]) });

describe('text focus state', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts unknown', () => {
    expect(device().textFocusState).toBe(KeyboardFocusState.Unknown);
  });

  it.each([[true, KeyboardFocusState.Focused], [false, KeyboardFocusState.Unfocused]])(
    'fetchTextFocusState restarts the RTI session and reads focus=%s from the _tiStart reply', async (focused, state) => {
      const { atv, sent } = companion(focused);
      const seen: KeyboardFocusState[] = [];
      atv.on('textFocusState', (s: KeyboardFocusState) => seen.push(s));
      await expect(atv.fetchTextFocusState()).resolves.toBe(state);
      expect(sent).toEqual(['_tiStop', '_tiStart']);
      expect(atv.textFocusState).toBe(state);
      expect(seen).toEqual([state]);
    });

  it('_tiStarted/_tiStopped events update the state and emit only on change', () => {
    const atv = device();
    const seen: KeyboardFocusState[] = [];
    atv.on('textFocusState', (s: KeyboardFocusState) => seen.push(s));
    const handle = (e: CompanionEvent) => (atv as any).handleCompanionEvent(e);
    handle(event('_tiStarted', new Map([['_tiD', Buffer.alloc(0)]])));
    handle(event('_tiStarted', new Map([['_tiD', Buffer.alloc(0)]])));
    handle(event('_tiStopped', new Map()));
    expect(seen).toEqual([KeyboardFocusState.Focused, KeyboardFocusState.Unfocused]);
    expect(atv.textFocusState).toBe(KeyboardFocusState.Unfocused);
  });

  it('text edits also record focus from their _tiStart reply', async () => {
    const { atv } = companion(false);
    await expect(atv.getText()).rejects.toThrow('No text field is focused');
    expect(atv.textFocusState).toBe(KeyboardFocusState.Unfocused);
  });

  it('close() resets the state to unknown and emits the change', async () => {
    const { atv } = companion(true);
    await atv.fetchTextFocusState();
    const seen: KeyboardFocusState[] = [];
    atv.on('textFocusState', (s: KeyboardFocusState) => seen.push(s));
    await atv.close();
    expect(atv.textFocusState).toBe(KeyboardFocusState.Unknown);
    expect(seen).toEqual([KeyboardFocusState.Unknown]);
  });

  it('reads events from the live Companion connection and resets when it closes', async () => {
    vi.spyOn(CompanionConnection.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CompanionConnection.prototype, 'sendRequest').mockImplementation(async id => connectionReply(id));
    const atv = liveDevice();
    await atv.connectCompanion(credentials);
    const conn = (atv as any).companionConnection as CompanionConnection;
    conn.emit('event', event('_tiStarted', new Map([['_tiD', Buffer.alloc(0)]])));
    expect(atv.textFocusState).toBe(KeyboardFocusState.Focused);
    conn.emit('close');
    expect(atv.textFocusState).toBe(KeyboardFocusState.Unknown);
  });

  // The TV pushes _tiStarted/_tiStopped only to clients with an open RTI session, so connect opens one.
  it('connectCompanion opens an RTI session and records focus from its _tiStart reply', async () => {
    vi.spyOn(CompanionConnection.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CompanionConnection.prototype, 'sendRequest').mockImplementation(async (id: string) => {
      if (id === '_tiStart') return new Map([['_c', new Map([['_tiD', Buffer.alloc(0)]])]]);
      return connectionReply(id);
    });
    const atv = liveDevice();
    const seenAtConnect: KeyboardFocusState[] = [];
    atv.on('companionConnect', () => seenAtConnect.push(atv.textFocusState));
    await atv.connectCompanion(credentials);
    expect(seenAtConnect).toEqual([KeyboardFocusState.Focused]);
  });

  it('a rejected _tiStart at connect leaves focus unknown but keeps Companion connected', async () => {
    vi.spyOn(CompanionConnection.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CompanionConnection.prototype, 'sendRequest').mockImplementation(async (id: string) => {
      if (id === '_tiStart') throw new Error('Companion _tiStart failed: No request handler');
      return connectionReply(id);
    });
    const atv = liveDevice();
    await atv.connectCompanion(credentials);
    expect(atv.textFocusState).toBe(KeyboardFocusState.Unknown);
    expect((atv as any).companionConnection).toBeDefined();
  });

  // Every path agrees: only a Buffer `_tiD` (the archive editText needs) means focused.
  it('a non-Buffer _tiD counts as unfocused in replies and events', async () => {
    const atv = device();
    (atv as any).companionConnection = {
      sendRequest: vi.fn(async (id: string) => new Map<OpackValue, OpackValue>([['_c', id === '_tiStart' ? new Map([['_tiD', null]]) : new Map()]])),
      sendMessage: vi.fn(),
    };
    await expect(atv.getText()).rejects.toThrow('No text field is focused');
    expect(atv.textFocusState).toBe(KeyboardFocusState.Unfocused);
    (atv as any).handleCompanionEvent(event('_tiStarted', new Map([['_tiD', null]])));
    expect(atv.textFocusState).toBe(KeyboardFocusState.Unfocused);
  });

  it('fetchTextFocusState requires Companion', async () => {
    await expect(device().fetchTextFocusState()).rejects.toThrow('Companion not connected');
  });
});
