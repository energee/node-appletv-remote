import { describe, it, expect } from 'vitest';
import { MRPMessage, MessageType } from '../messages.js';

describe('MRP Messages', () => {
  it('creates a DeviceInfoMessage', async () => {
    const msg = await MRPMessage.deviceInfo({
      uniqueIdentifier: 'test-device',
      name: 'Node ATV',
    });
    expect(msg).toBeInstanceOf(Buffer);
    expect(msg.length).toBeGreaterThan(0);
  });

  it('creates a SendCommandMessage', async () => {
    const msg = await MRPMessage.sendCommand(MessageType.SendCommand);
    expect(msg).toBeInstanceOf(Buffer);
  });

  it('decodes a ProtocolMessage', async () => {
    const msg = await MRPMessage.deviceInfo({
      uniqueIdentifier: 'test',
      name: 'test',
    });
    const decoded = await MRPMessage.decode(msg);
    expect(decoded).toBeDefined();
  });
});
