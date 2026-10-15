/**
 * Bounded keep-alive HTTP client for DMAP and the HAP pairing endpoints
 * (`/pair-setup`, `/pair-verify`) on the AirPlay port.
 */

import http from 'node:http';

/** Headers an AirPlay sender sends on pairing requests; X-Apple-HKP: 3 selects HomeKit-style pairing. */
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

  /** @param timeoutMs Socket inactivity timeout per request; 0 disables it (DMAP long polls). */
  constructor(host: string, port: number, private headers: Record<string, string> = DEFAULT_HEADERS, private timeoutMs = 10_000) {
    this.host = host;
    this.port = port;
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  }

  /**
   * POST a raw body and resolve with the full response body.
   * @throws (rejects) on a socket error or any HTTP status >= 400.
   */
  async post(path: string, body: Buffer): Promise<Buffer> {
    const response = await this.request('POST', path, body);
    if (response.status >= 400) throw new Error(`HTTP ${response.status} from ${path}`);
    return response.body;
  }

  /** Raw GET/POST response for protocols that handle authentication statuses themselves.
   * Requests time out after `timeoutMs` (default 10 s) of socket inactivity and responses are capped at 8 MiB.
   */
  async request(method: 'GET' | 'POST', path: string, body: Buffer = Buffer.alloc(0)): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: this.host,
          port: this.port,
          path,
          method,
          agent: this.agent,
          headers: {
            ...this.headers,
            'Content-Length': String(body.length),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('error', reject);
          res.on('aborted', () => reject(new Error('HTTP response aborted')));
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > 8 * 1024 * 1024) res.destroy(new Error('HTTP response size limit exceeded'));
            else chunks.push(c);
          });
          res.on('end', () => {
            const responseBody = Buffer.concat(chunks);
            resolve({ status: res.statusCode ?? 0, body: responseBody });
          });
        },
      );
      if (this.timeoutMs > 0) req.setTimeout(this.timeoutMs, () => req.destroy(new Error('HTTP request timeout')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** Close the pooled socket. */
  destroy(): void {
    this.agent.destroy();
  }
}
