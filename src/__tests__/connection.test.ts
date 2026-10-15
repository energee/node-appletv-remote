import { describe, it, expect } from 'vitest';
import { AirPlayConnection, parseHTTPMessage } from '../connection.js';
import { randomBytes } from 'node:crypto';

describe('AirPlayConnection', () => {
  it('constructs with host, port, and credentials', () => {
    const conn = new AirPlayConnection('192.168.1.100', 7000, {
      clientId: 'test',
      clientLTSK: randomBytes(32),
      clientLTPK: randomBytes(32),
      serverLTPK: randomBytes(32),
      serverId: 'server',
    });
    expect(conn).toBeDefined();
  });

  it('is an EventEmitter', () => {
    const conn = new AirPlayConnection('192.168.1.100', 7000, {
      clientId: 'test',
      clientLTSK: randomBytes(32),
      clientLTPK: randomBytes(32),
      serverLTPK: randomBytes(32),
      serverId: 'server',
    });
    expect(typeof conn.on).toBe('function');
    expect(typeof conn.emit).toBe('function');
  });
});

describe('parseHTTPMessage', () => {
  it('tolerates a duplicate CSeq and keeps the last value', () => {
    expect(parseHTTPMessage(Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 1\r\ncseq: 2\r\n\r\n'))?.headers.cseq).toBe('2');
  });
});
