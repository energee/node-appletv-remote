/**
 * Companion pair-setup against a fake Apple TV on localhost: the TV answers M1 with M2, then ends the
 * session the way tvOS does when the PIN is not entered in time (~35 s on hardware).
 */
import { createServer, type Server } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { CompanionPairSetup } from '../companion/pair-setup.js';
import { FrameType, encodeFrame } from '../companion/framing.js';
import { opackEncode } from '../companion/opack.js';
import { TlvTag, tlvEncode } from '../util/tlv.js';

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

it('fails at once with a clear error when the TV ended the session before the PIN arrives', async () => {
  server = createServer(socket => socket.once('data', () => {
    const m2 = tlvEncode({ [TlvTag.SeqNo]: Buffer.from([2]), [TlvTag.Salt]: Buffer.alloc(16, 1), [TlvTag.PublicKey]: Buffer.alloc(384, 2) });
    socket.end(encodeFrame(FrameType.PS_Next, opackEncode(new Map([['_pd', m2]]))));
  }));
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const pairing = new CompanionPairSetup('127.0.0.1', (server.address() as { port: number }).port);
  await pairing.start();
  await new Promise(resolve => setTimeout(resolve, 50)); // let the TV's FIN arrive
  await expect(pairing.finish('1234')).rejects.toThrow(/PIN expired/);
}, 2000);
