/** Legacy unencrypted RAOP RTP, synchronization, timing, and resend packets. */
export const FRAMES_PER_PACKET = 352;
export const SAMPLE_RATE = 44100;
export const PACKET_BYTES = FRAMES_PER_PACKET * 4;

/** Pad one PCM16LE stereo packet and convert samples to network-order L16. */
export function audioPacket(pcm: Buffer, sequence: number, timestamp: number, ssrc: number, first: boolean): Buffer {
  if (pcm.length % 4 || pcm.length > PACKET_BYTES) throw new Error('Expected at most 352 complete PCM16 stereo frames');
  const packet = Buffer.alloc(12 + PACKET_BYTES);
  packet[0] = 0x80;
  packet[1] = first ? 0xe0 : 0x60;
  packet.writeUInt16BE(sequence & 0xffff, 2);
  packet.writeUInt32BE(timestamp >>> 0, 4);
  packet.writeUInt32BE(ssrc >>> 0, 8);
  pcm.copy(packet, 12);
  packet.subarray(12, 12 + pcm.length).swap16();
  return packet;
}

/** Encode Unix milliseconds as an NTP timestamp (including era rollover). */
function writeNtp(packet: Buffer, offset: number, milliseconds: number): void {
  const seconds = Math.floor(milliseconds / 1000);
  packet.writeUInt32BE((seconds + 0x83aa7e80) >>> 0, offset);
  packet.writeUInt32BE(Math.floor((milliseconds - seconds * 1000) / 1000 * 2 ** 32) >>> 0, offset + 4);
}

/** Reply only to 32-byte RTP timing requests (any version byte, which is echoed); echo the sender's transmit time. */
export function timingReply(request: Buffer, receivedMs: number, sentMs: number): Buffer | undefined {
  if (request.length !== 32 || (request[1] & 0x7f) !== 0x52) return;
  const reply = Buffer.alloc(32);
  reply[0] = request[0]; reply[1] = 0xd3; reply.writeUInt16BE(7, 2);
  request.copy(reply, 8, 24, 32);
  writeNtp(reply, 16, receivedMs);
  writeNtp(reply, 24, sentMs);
  return reply;
}

/** Relate the next RTP timestamp to its source time and receiver latency. */
export function syncPacket(timestamp: number, latency: number, sourceMs: number, first: boolean): Buffer {
  const packet = Buffer.alloc(20);
  packet[0] = first ? 0x90 : 0x80; packet[1] = 0xd4; packet.writeUInt16BE(7, 2);
  packet.writeUInt32BE((timestamp - latency) >>> 0, 4);
  writeNtp(packet, 8, sourceMs);
  packet.writeUInt32BE(timestamp >>> 0, 16);
  return packet;
}

/** Bounded history of immutable wire packets indexed by their wrapping sequence. */
export class PacketHistory {
  private packets = new Map<number, Buffer>();
  constructor(private capacity = 1000) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) throw new Error('Invalid packet history capacity');
  }
  /** Stores `packet` by reference (no copy); the caller must not mutate it afterwards. */
  add(packet: Buffer): void {
    const sequence = packet.readUInt16BE(2);
    this.packets.delete(sequence);
    this.packets.set(sequence, packet);
    if (this.packets.size > this.capacity) this.packets.delete(this.packets.keys().next().value!);
  }
  /** Check the caller's remaining packet budget before copying any retransmissions. */
  resend(request: Buffer, budget = 100): Buffer[] {
    if (request.length !== 8 || request[0] !== 0x80 || (request[1] & 0x7f) !== 0x55) return [];
    const count = request.readUInt16BE(6);
    if (count > Math.min(this.capacity, 100, budget)) return [];
    const packets: Buffer[] = [];
    for (let index = 0; index < count; index++) {
      const original = this.packets.get((request.readUInt16BE(4) + index) & 0xffff);
      if (original) packets.push(Buffer.concat([Buffer.from([0x80, 0xd6]), original.subarray(2, 4), original]));
    }
    return packets;
  }
  clear(): void { this.packets.clear(); }
}
