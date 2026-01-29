import http from 'node:http';

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'AirPlay/320.20',
  Connection: 'keep-alive',
  'X-Apple-HKP': '3',
  'Content-Type': 'application/octet-stream',
};

/**
 * Persistent HTTP client that reuses a single TCP connection.
 * Apple TV requires all pairing requests on the same connection.
 */
export class PersistentHttp {
  private agent: http.Agent;
  private host: string;
  private port: number;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  }

  async post(path: string, body: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: this.host,
          port: this.port,
          path,
          method: 'POST',
          agent: this.agent,
          headers: {
            ...DEFAULT_HEADERS,
            'Content-Length': String(body.length),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const responseBody = Buffer.concat(chunks);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode} from ${path}`));
            } else {
              resolve(responseBody);
            }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  destroy(): void {
    this.agent.destroy();
  }
}
