/** Loopback tests for RaopStream's AirPlay 2 realtime profile: sealed audio, resends, feedback, Session and teardown. */
import { Readable } from 'node:stream';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { airplay2Receiver, openSealed, until } from './airplay2-receiver.js';

const observed = vi.hoisted(() => ({ sockets: [] as import('node:dgram').Socket[] }));
const controlledClock = vi.hoisted(() => ({ now: undefined as number | undefined }));
// Virtualize only paced sender delays; loopback sockets and request timeouts stay real.
vi.mock('node:timers/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: async <T>(milliseconds?: number, value?: T, options?: { signal?: AbortSignal }) => {
    if (controlledClock.now === undefined || !options?.signal) return actual.setTimeout(milliseconds, value, options);
    options.signal.throwIfAborted();
    controlledClock.now += milliseconds ?? 1;
    await actual.setImmediate();
    options.signal.throwIfAborted();
    return value;
  } };
});
// Observe the sender's UDP sockets without replacing their behavior.
vi.mock('node:dgram', async importOriginal => {
  const actual = await importOriginal<typeof import('node:dgram')>();
  return { ...actual, createSocket: (...args: Parameters<typeof actual.createSocket>) => {
    const socket = actual.createSocket(...args); observed.sockets.push(socket); return socket;
  } };
});

// Capture the sender's shk Buffer (by reference) to check it is zeroed on teardown.
const sealed = vi.hoisted(() => ({ key: undefined as Buffer | undefined, calls: 0 }));
vi.mock('../packets.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../packets.js')>();
  return { ...actual, sealAudioPacket: (packet: Buffer, key: Buffer, counter: bigint) => { sealed.key = key; sealed.calls++; return actual.sealAudioPacket(packet, key, counter); } };
});

const { RaopStream } = await import('../stream.js');
const txt = { features: '0x4A7FDFD5,0x3C155FDE', flags: '0x244', md: '0,1,2' };
const receivers: { close(): Promise<void> }[] = [];
afterEach(async () => { controlledClock.now = undefined; sealed.key = undefined; sealed.calls = 0; vi.useRealTimers(); vi.restoreAllMocks(); for (const receiver of receivers.splice(0)) await receiver.close(); });

async function start(options: Parameters<typeof airplay2Receiver>[0] = {}) {
  const receiver = await airplay2Receiver(options); receivers.push(receiver);
  return { receiver, firstSocket: observed.sockets.length, stream: new RaopStream('127.0.0.1', receiver.port, txt) };
}
const closed = (socket: import('node:dgram').Socket) => { try { socket.address(); return false; } catch { return true; } };

/** A source that yields one packet of silence, then never ends. */
const endless = () => ({ async *[Symbol.asyncIterator]() { yield Buffer.alloc(1408); await new Promise(() => {}); } });

describe('RaopStream AirPlay 2 realtime profile', () => {
  it('seals every packet with shk, reassembles the source plus silence tail, and resends sealed bytes', async () => {
    const { receiver, stream } = await start();
    const pcm = Buffer.alloc(1000 * 4); for (let i = 0; i < pcm.length; i++) pcm[i] = (i * 7 + 3) & 0xff;
    controlledClock.now = 0; vi.spyOn(performance, 'now').mockImplementation(() => controlledClock.now!);
    // The receiver asks for a resend of the first packet as soon as it arrives.
    await stream.stream(pcm, { credentials: receiver.credentials, volume: 50, metadata: { title: 'Tone' } });
    const first = receiver.audioPackets[0];

    const key = (receiver.setups()[1].streams as Record<string, Buffer>[])[0].shk;
    const packets = receiver.audioPackets;
    expect(packets).toHaveLength(3 + Math.ceil(66150 / 352));
    const opened = packets.map(packet => openSealed(packet, key));
    opened.forEach(({ counter }, index) => expect(counter).toBe(BigInt(index)));
    const payload = Buffer.concat(opened.map(item => item.payload));
    expect(payload.subarray(0, pcm.length)).toEqual(Buffer.from(pcm).swap16());
    expect(payload.subarray(pcm.length).every(byte => byte === 0)).toBe(true);
    expect(payload).toHaveLength(packets.length * 1408);
    // Headers stay cleartext RTP with consecutive sequence numbers.
    expect(packets[1].readUInt16BE(2)).toBe((packets[0].readUInt16BE(2) + 1) & 0xffff);

    await until(() => receiver.controlPackets.some(packet => packet[1] === 0xd6));
    const resend = receiver.controlPackets.find(packet => packet[1] === 0xd6)!;
    expect(resend.subarray(4)).toEqual(first);

    expect(receiver.requests.map(request => request.uri === '/feedback' ? 'feedback' : request.method).filter(name => name !== 'feedback')).toEqual(
      ['POST', 'POST', 'SETUP', 'SETUP', 'RECORD', 'FLUSH', 'SET_PARAMETER', 'SET_PARAMETER', 'TEARDOWN']);
    expect(receiver.requests.some(request => request.method === 'ANNOUNCE')).toBe(false);
    const flush = receiver.requests.find(request => request.method === 'FLUSH')!;
    expect(flush.headers['rtp-info']).toBe(`seq=${first.readUInt16BE(2)};rtptime=${first.readUInt32BE(4)}`);
    expect(receiver.requests.filter(request => request.method !== 'POST' || request.uri === '/feedback').every(request => request.encrypted)).toBe(true);
    // streamConnectionID is the session id in the request URI (bplist-parser reads integers >= 2^31 as signed).
    const uriSession = Number(receiver.requests.find(request => request.method === 'SETUP')!.uri.split('/').at(-1));
    expect(((receiver.setups()[1].streams as Record<string, number>[])[0].streamConnectionID) >>> 0).toBe(uriSession);
    // Teardown zeroed the sender's copy of shk: the receiver's copy no longer opens a fresh packet.
    expect(sealed.calls).toBeGreaterThan(0);
    expect(sealed.key!.every(byte => byte === 0)).toBe(true);
  }, 10000);

  it('accepts a receiver-chosen Audio-Latency on RECORD', async () => {
    const { receiver, stream } = await start({ recordLatency: '11025' });
    controlledClock.now = 0; vi.spyOn(performance, 'now').mockImplementation(() => controlledClock.now!);
    await stream.stream(Buffer.alloc(4), { credentials: receiver.credentials });
    expect(receiver.requests.map(request => request.method)).toContain('FLUSH');
    expect(receiver.audioPackets.length).toBeGreaterThan(0);
  });

  it.each([
    ['no Session header', undefined, '0'],
    ['a Session header', 'ABC123', 'ABC123'],
  ])('uses the stream SETUP session with %s on every later request', async (_name, session, expected) => {
    const { receiver, stream } = await start({ session });
    controlledClock.now = 0; vi.spyOn(performance, 'now').mockImplementation(() => controlledClock.now!);
    await stream.stream(Buffer.alloc(4), { credentials: receiver.credentials, volume: 10, metadata: { artist: 'A' } });
    const later = receiver.requests.filter(request => ['RECORD', 'FLUSH', 'SET_PARAMETER', 'TEARDOWN'].includes(request.method));
    expect(later.map(request => request.method)).toEqual(['RECORD', 'FLUSH', 'SET_PARAMETER', 'SET_PARAMETER', 'TEARDOWN']);
    for (const request of later) expect(request.headers.session).toBe(expected);
  });

  it('rejects an invalid stream SETUP Session header', async () => {
    const { receiver, stream } = await start({ session: 'bad/session' });
    await expect(stream.stream(Buffer.alloc(4), { credentials: receiver.credentials })).rejects.toThrow(/session/i);
    expect(receiver.requests.some(request => request.method === 'RECORD')).toBe(false);
  });

  it('sends feedback at once and then every 2 seconds', async () => {
    const { receiver, stream } = await start();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const cancellation = new AbortController();
    const settled = stream.stream(endless(), { credentials: receiver.credentials, signal: cancellation.signal }).catch(error => error);
    const feedback = () => receiver.requests.filter(request => request.uri === '/feedback').length;
    try {
      await until(() => receiver.audioPackets.length > 0);
      await until(() => feedback() === 1);
      for (const expected of [2, 3]) {
        await vi.advanceTimersByTimeAsync(1999); await delay(20);
        expect(feedback()).toBe(expected - 1);
        await vi.advanceTimersByTimeAsync(1);
        await until(() => feedback() === expected);
      }
    } finally { cancellation.abort(); }
    expect(await settled).toBeInstanceOf(Error);
  });

  it('keeps streaming when feedback goes unanswered', async () => {
    const { receiver, stream } = await start({ holdFeedback: true });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const cancellation = new AbortController();
    const settled = stream.stream(endless(), { credentials: receiver.credentials, signal: cancellation.signal }).catch(error => error);
    const feedback = () => receiver.requests.filter(request => request.uri === '/feedback').length;
    try {
      await until(() => receiver.audioPackets.length > 0);
      await until(() => feedback() === 1);
      await vi.advanceTimersByTimeAsync(1999); await turn();
      expect(feedback()).toBe(1);
      // An unanswered feedback request neither fails the stream nor blocks the next tick for long.
      await vi.advanceTimersByTimeAsync(1); await turn();
      expect(feedback()).toBe(1);
      await delay(5100);
      await vi.advanceTimersByTimeAsync(2000);
      await until(() => feedback() === 2);
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/\[RAOP\].*feedback.*timeout/i));
    } finally { cancellation.abort(); }
    expect(await settled).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  }, 15000);

  it.each(['cancellation', 'source error'])('closes RTSP, event and UDP sockets after %s', async mode => {
    const { receiver, stream, firstSocket } = await start();
    const cancellation = new AbortController();
    const source = new Readable({ read() {} }); source.push(Buffer.alloc(1408));
    const playing = stream.stream(source, { credentials: receiver.credentials, signal: cancellation.signal });
    await until(() => receiver.audioPackets.length > 0);
    if (mode === 'cancellation') cancellation.abort(); else source.destroy(new Error('producer failed'));
    await expect(playing).rejects.toThrow(mode === 'cancellation' ? /abort/i : /producer failed/);
    await until(() => receiver.state.controlClosed && receiver.state.eventClosed);
    const senderSockets = observed.sockets.slice(firstSocket);
    expect(senderSockets).toHaveLength(3);
    expect(senderSockets.every(closed)).toBe(true);
    expect(receiver.requests.at(-1)!.method).toBe('TEARDOWN');
  });

  it('fails the stream when the receiver closes the event channel', async () => {
    const { receiver, stream } = await start();
    const playing = stream.stream(endless(), { credentials: receiver.credentials });
    await until(() => receiver.audioPackets.length > 0 && receiver.state.eventConnected);
    receiver.closeEvents();
    await expect(playing).rejects.toThrow(/event connection closed/);
  });

  it('fails the stream with the event socket error when the event channel is reset', async () => {
    const { receiver, stream } = await start();
    const playing = stream.stream(endless(), { credentials: receiver.credentials });
    await until(() => receiver.audioPackets.length > 0 && receiver.state.eventConnected);
    receiver.resetEvents();
    await expect(playing).rejects.toThrow(/ECONNRESET/);
  });
});
