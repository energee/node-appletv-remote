/** Tests that the MRP schema is built into the code, so bundled builds need no .proto files on disk. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MRPMessage, MessageType } from '../messages.js';

describe('MRP schema bundling', () => {
  it('does not read .proto files at run time', () => {
    const source = readFileSync(new URL('../messages.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\.proto['"]/);
    expect(source).not.toMatch(/node:fs|import\.meta\.url/);
  });

  it('names the message types tvOS 26 sends', async () => {
    expect(MessageType.SetNowPlayingPlayer).toBe(47);
    expect(MessageType.VolumeDidChange).toBe(52);
    expect(MessageType.RemoveClient).toBe(53);
    expect(MessageType.RemovePlayer).toBe(54);
    expect(MessageType.SetDefaultSupportedCommands).toBe(72);
    for (const type of [47, 52, 53, 54, 72]) {
      const decoded = await MRPMessage.decode(Buffer.from([0x08, type]));
      expect(decoded.type).toBe(type);
    }
  });
});
