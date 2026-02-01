import { describe, it, expect } from 'vitest';
import { Message, MessageType } from '../message.js';

describe('Message', () => {
  it('wraps a decoded protobuf object', () => {
    const decoded = {
      type: MessageType.SetState,
      identifier: 'ABC-123',
      '.setStateMessage': { playbackState: 1 },
    };

    const msg = new Message(decoded);

    expect(msg.type).toBe(MessageType.SetState);
    expect(msg.identifier).toBe('ABC-123');
    expect(msg.payload).toBe(decoded);
  });

  it('handles missing fields', () => {
    const msg = new Message({});

    expect(msg.type).toBe(0);
    expect(msg.identifier).toBe('');
  });

  it('produces a readable toString()', () => {
    const msg = new Message({
      type: MessageType.DeviceInfo,
      identifier: 'DEF-456',
    });

    const str = msg.toString();
    expect(str).toContain('DeviceInfo');
    expect(str).toContain('DEF-456');
  });

  it('handles unknown message types in toString()', () => {
    const msg = new Message({ type: 9999, identifier: 'X' });
    const str = msg.toString();
    expect(str).toContain('Unknown(9999)');
  });
});
