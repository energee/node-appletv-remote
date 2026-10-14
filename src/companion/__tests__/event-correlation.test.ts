/** Tests how Companion request IDs are assigned and how replies and events are matched to requests. */
import { describe, expect, it, vi } from 'vitest';
import { CompanionConnection } from '../connection.js';
import { CompanionSession } from '../companion-session.js';
import { FrameType } from '../framing.js';
import { opackDecode, opackEncode, type OpackDict, type OpackValue } from '../opack.js';

function fixture() {
  const key = Buffer.alloc(32, 7);
  const connection = new CompanionConnection('unused.invalid', 1, {
    clientId: 'synthetic', serverId: 'synthetic', clientLTSK: key, clientLTPK: key, serverLTPK: key,
  });
  const parser = connection as unknown as {
    session: CompanionSession;
    socket: { write(data: Buffer): void; destroy(): void };
    onData(data: Buffer): void;
  };
  parser.session = new CompanionSession(key, key);
  const peer = new CompanionSession(key, key);
  const requests: OpackDict[] = [];
  parser.socket = {
    write(data): void { requests.push(opackDecode(peer.decrypt(data.subarray(0, 4), data.subarray(4))) as OpackDict); },
    destroy(): void {},
  };
  const receive = (body: OpackDict): void => parser.onData(peer.encrypt(FrameType.E_OPACK, opackEncode(body)));
  return { connection, requests, receive, parser };
}

describe('Companion request and event correlation', () => {
  it('keeps request IDs in 1..127 so a signed one-byte echo still matches', async () => {
    const { connection, requests, receive } = fixture();
    try {
      for (let n = 0; n < 300; n++) {
        const pending = connection.sendRequest('_ping', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]]));
        const id = requests.at(-1)!.get('_x') as number;
        expect(id).toBeGreaterThanOrEqual(1);
        expect(id).toBeLessThanOrEqual(127);
        receive(new Map<OpackValue, OpackValue>([['_x', id], ['_t', 3], ['_c', new Map()]]));
        await pending;
      }
      expect(requests.map((r) => r.get('_x')).slice(125, 129)).toEqual([126, 127, 1, 2]);
    } finally {
      connection.close();
    }
  });

  it('skips a request ID that is still awaiting its reply', async () => {
    const { connection, requests, receive } = fixture();
    try {
      const held = connection.sendRequest('_held', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]]));
      held.catch(() => {});
      expect(requests[0].get('_x')).toBe(1);
      for (let n = 0; n < 127; n++) {
        const pending = connection.sendRequest('_ping', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]]));
        receive(new Map<OpackValue, OpackValue>([['_x', requests.at(-1)!.get('_x')!], ['_t', 3], ['_c', new Map()]]));
        await pending;
      }
      expect(requests.at(-1)!.get('_x')).toBe(2);
    } finally {
      connection.close();
    }
  });

  it('delivers an event with a colliding ID without resolving the pending request', async () => {
    const { connection, requests, receive } = fixture();
    const events: unknown[] = [];
    connection.on('event', (event) => events.push(event));
    try {
      const pending = connection.sendRequest('_mcc', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]]));
      const id = requests[0].get('_x');
      receive(new Map<OpackValue, OpackValue>([['_x', id!], ['_t', 1], ['_i', '_iMC'], ['_c', new Map([['_mcF', 256]])]]));
      receive(new Map<OpackValue, OpackValue>([['_x', id!], ['_t', 3], ['_c', new Map([['_vol', 0.25]])]]));
      const reply = await pending;
      expect(reply.get('_t')).toBe(3);
      expect((reply.get('_c') as OpackDict).get('_vol')).toBe(0.25);
      expect(events).toHaveLength(1);
    } finally { connection.close(); }
  });

  it('does not reuse a timed-out request ID, so a late reply cannot resolve a newer request', async () => {
    vi.useFakeTimers();
    const { connection, requests, receive } = fixture();
    try {
      const late = connection.sendRequest('_late', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]]), 10);
      const lateId = requests[0].get('_x');
      const timedOut = expect(late).rejects.toThrow(/timeout/);
      await vi.advanceTimersByTimeAsync(10);
      await timedOut;
      // Wrap the counter all the way round; the timed-out ID must be skipped.
      for (let n = 0; n < 130; n++) {
        const pending = connection.sendRequest('_ping', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]]));
        const id = requests.at(-1)!.get('_x');
        expect(id).not.toBe(lateId);
        receive(new Map<OpackValue, OpackValue>([['_x', id!], ['_t', 3], ['_c', new Map()]]));
        await pending;
      }
      // Once the late reply arrives, the ID is free again.
      receive(new Map<OpackValue, OpackValue>([['_x', lateId!], ['_t', 3], ['_c', new Map()]]));
      for (let n = 0; n < 127; n++) {
        const pending = connection.sendRequest('_ping', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]]));
        receive(new Map<OpackValue, OpackValue>([['_x', requests.at(-1)!.get('_x')!], ['_t', 3], ['_c', new Map()]]));
        await pending;
      }
      expect(requests.map((r) => r.get('_x'))).toContain(lateId);
    } finally {
      connection.close();
      vi.useRealTimers();
    }
  });

  it('wraps bare request content in the {_i, _t: 2, _c, _x} envelope', () => {
    const { connection, requests } = fixture();
    try {
      connection.sendRequest('_systemInfo', new Map<OpackValue, OpackValue>([['_bf', 0]])).catch(() => {});
      const sent = requests[0];
      expect(sent.get('_i')).toBe('_systemInfo');
      expect(sent.get('_t')).toBe(2);
      expect(sent.get('_x')).toBe(1);
      expect((sent.get('_c') as OpackDict).get('_bf')).toBe(0);
      expect(sent.has('_bf')).toBe(false);
    } finally { connection.close(); }
  });

  it('wraps bare message content as an event with _t: 1', () => {
    const { connection, requests } = fixture();
    try {
      connection.sendMessage('_hidC', new Map<OpackValue, OpackValue>([['_hBtS', 1]]));
      expect(requests[0].get('_t')).toBe(1);
      expect((requests[0].get('_c') as OpackDict).get('_hBtS')).toBe(1);
    } finally { connection.close(); }
  });

  it('sends a caller-built envelope unchanged apart from _i and _x', () => {
    const { connection, requests } = fixture();
    try {
      connection.sendRequest('_ping', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map([['k', 1]])]])).catch(() => {});
      expect(requests[0].get('_t')).toBe(2);
      expect((requests[0].get('_c') as OpackDict).get('k')).toBe(1);
      expect((requests[0].get('_c') as OpackDict).has('_c')).toBe(false);
    } finally { connection.close(); }
  });

  it('sends fire-and-forget messages even when every request ID is in use', () => {
    const { connection, requests } = fixture();
    try {
      for (let n = 0; n < 127; n++) {
        connection.sendRequest('_held', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]])).catch(() => {});
      }
      expect(() => connection.sendMessage('_touch', new Map<OpackValue, OpackValue>([['_t', 1], ['_c', new Map()]])))
        .not.toThrow();
      expect(requests).toHaveLength(128);
    } finally { connection.close(); }
  });

  it('rejects a caller-supplied _x that collides with a pending request', () => {
    const { connection, requests } = fixture();
    try {
      connection.sendRequest('_held', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]])).catch(() => {});
      const held = requests[0].get('_x')!;
      expect(() => connection.sendMessage('_touch', new Map<OpackValue, OpackValue>([['_t', 1], ['_x', held]])))
        .toThrow(/in use/);
    } finally { connection.close(); }
  });

  it('passes an empty frame through without consuming a receive nonce', async () => {
    const { connection, requests, receive, parser } = fixture();
    const errors: Error[] = [];
    connection.on('error', (error) => errors.push(error));
    try {
      const pending = connection.sendRequest('_ping', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]]));
      parser.onData(Buffer.from([FrameType.E_OPACK, 0, 0, 0]));
      receive(new Map<OpackValue, OpackValue>([['_x', requests[0].get('_x')!], ['_t', 3], ['_c', new Map()]]));
      expect((await pending).get('_t')).toBe(3);
      expect(errors).toEqual([]);
    } finally { connection.close(); }
  });

  it('numbers public event messages and subsequent requests independently', async () => {
    const { connection, requests, receive } = fixture();
    try {
      connection.sendMessage('_interest', new Map<OpackValue, OpackValue>([['_t', 1], ['_c', new Map()]]));
      const first = requests[0].get('_x');
      expect(first).toBeGreaterThan(0);
      const pending = connection.sendRequest('_systemInfo', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]]));
      const second = requests[1].get('_x');
      expect(second).not.toBe(first);
      receive(new Map<OpackValue, OpackValue>([['_x', second!], ['_t', 3], ['_c', new Map()]]));
      await pending;
    } finally { connection.close(); }
  });
});
