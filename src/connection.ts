import { Socket } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PairVerify } from './auth/pair-verify.js';
import { HAPSession } from './util/hap-session.js';
import type { HAPCredentials } from './auth/types.js';

export class AirPlayConnection extends EventEmitter {
  private socket?: Socket;
  private session?: HAPSession;
  private buffer = Buffer.alloc(0);
  private cseq = 0;

  constructor(
    private host: string,
    private port: number,
    private credentials: HAPCredentials,
  ) {
    super();
  }

  async connect(): Promise<void> {
    // Step 1: Pair-verify to get session keys
    const verifier = new PairVerify(this.host, this.port, this.credentials);
    const { outputKey, inputKey } = await verifier.verify();
    this.session = new HAPSession(outputKey, inputKey);

    // Step 2: Open persistent TCP connection for RTSP
    this.socket = new Socket();
    await new Promise<void>((resolve, reject) => {
      this.socket!.connect(this.port, this.host, resolve);
      this.socket!.once('error', reject);
    });

    this.socket.on('data', (data) => this.onData(Buffer.from(data)));
    this.socket.on('close', () => this.emit('close'));
    this.socket.on('error', (err) => this.emit('error', err));

    // Step 3: Set up event channel via RTSP SETUP
    await this.setupEventChannel();

    // Step 4: RECORD
    await this.sendRTSP('RECORD', '*');

    // Step 5: Set up data channel (MRP tunnel)
    await this.setupDataChannel();
  }

  private async sendRTSP(
    method: string,
    uri: string,
    headers: Record<string, string> = {},
    body?: Buffer,
  ): Promise<Buffer> {
    this.cseq++;
    const allHeaders: Record<string, string> = {
      CSeq: String(this.cseq),
      'User-Agent': 'AirPlay/320.20',
      'DACP-ID': randomBytes(8).toString('hex'),
      'Active-Remote': String(Math.floor(Math.random() * 0xffffffff)),
      ...headers,
    };

    let request = `${method} ${uri} RTSP/1.0\r\n`;
    for (const [key, value] of Object.entries(allHeaders)) {
      request += `${key}: ${value}\r\n`;
    }
    if (body) {
      request += `Content-Length: ${body.length}\r\n`;
    }
    request += '\r\n';

    let data = Buffer.from(request);
    if (body) data = Buffer.concat([data, body]);

    if (this.session) {
      data = Buffer.from(this.session.encrypt(data));
    }

    return new Promise((resolve, reject) => {
      this.socket!.write(data, (err) => {
        if (err) reject(err);
      });
      this.once('rtsp-response', resolve);
    });
  }

  private async setupEventChannel(): Promise<void> {
    // TODO: Binary plist encoding needed for real implementation
    // For now, this is a placeholder that will be completed during integration
    const sessionUUID = randomUUID();
    const body = Buffer.from(
      JSON.stringify({
        sessionUUID,
        deviceID: this.credentials.clientId,
        model: 'node-atv',
        name: 'Node ATV Remote',
        osName: 'Node.js',
      }),
    );
    await this.sendRTSP('SETUP', '*', {
      'Content-Type': 'application/x-apple-binary-plist',
    }, body);
  }

  private async setupDataChannel(): Promise<void> {
    // TODO: Binary plist encoding needed for real implementation
    const seed = randomBytes(8);
    const body = Buffer.from(
      JSON.stringify({
        streams: [{
          type: 130,
          controlType: 2,
          channelID: randomUUID(),
          seed: seed.readBigUInt64BE().toString(),
          clientUUID: this.credentials.clientId,
        }],
      }),
    );
    await this.sendRTSP('SETUP', '*', {
      'Content-Type': 'application/x-apple-binary-plist',
    }, body);
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    // TODO: Parse RTSP responses and MRP messages from encrypted stream
    this.emit('rtsp-response', data);
  }

  async sendMRPMessage(data: Buffer): Promise<void> {
    if (!this.socket) throw new Error('Not connected');
    // TODO: Wrap in data channel framing
    this.socket.write(data);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }
}
