import { createHash } from 'node:crypto';

export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
}

const SUPPORTED_PARAMETERS: Record<string, true> = { realm: true, nonce: true, opaque: true, algorithm: true, qop: true, charset: true, userhash: true, stale: true };

/** Parse the single legacy MD5 Digest challenge documented for password-protected RAOP. */
export function parseLegacyDigestChallenge(header: string): DigestChallenge {
  const scheme = /^Digest[ \t]+/i.exec(header);
  if (!scheme) throw new Error('Unsupported RAOP authentication challenge');
  const parameters = parseParameters(header.slice(scheme[0].length));
  for (const name of parameters.keys()) {
    if (!Object.hasOwn(SUPPORTED_PARAMETERS, name)) throw new Error('Unsupported RAOP Digest challenge parameter');
  }
  const realm = parameters.get('realm');
  const nonce = parameters.get('nonce');
  if (!realm || !nonce) throw new Error('Malformed RAOP Digest challenge');
  if (parameters.get('algorithm') !== undefined && parameters.get('algorithm') !== 'MD5') {
    throw new Error('Unsupported RAOP Digest algorithm');
  }
  if (parameters.has('qop')) throw new Error('Unsupported RAOP Digest qop');
  if (parameters.has('charset')) throw new Error('Unsupported RAOP Digest charset');
  if (parameters.has('userhash')) throw new Error('Unsupported RAOP Digest userhash');
  if (parameters.has('stale')) throw new Error('Unsupported RAOP Digest stale challenge');
  return { realm, nonce, opaque: parameters.get('opaque') };
}

/** Build an injection-safe legacy no-qop MD5 authorization value for one RTSP request. */
export function legacyDigestAuthorization(challenge: DigestChallenge, method: string, uri: string, password: string, username = 'iTunes'): string {
  const response = md5(`${md5(`${username}:${challenge.realm}:${password}`)}:${challenge.nonce}:${md5(`${method}:${uri}`)}`);
  const fields = [
    `username=${quote(username)}`,
    `realm=${quote(challenge.realm)}`,
    `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(uri)}`,
    `response=${quote(response)}`,
  ];
  if (challenge.opaque !== undefined) fields.push(`opaque=${quote(challenge.opaque)}`);
  return `Digest ${fields.join(', ')}`;
}

function parseParameters(input: string): Map<string, string> {
  const parameters = new Map<string, string>();
  let offset = 0;
  while (offset < input.length) {
    while (input[offset] === ' ' || input[offset] === '\t') offset++;
    const nameStart = offset;
    while (/[A-Za-z0-9_-]/.test(input[offset] ?? '')) offset++;
    const name = input.slice(nameStart, offset).toLowerCase();
    if (!name) throw new Error('Malformed RAOP Digest challenge');
    while (input[offset] === ' ' || input[offset] === '\t') offset++;
    if (input[offset++] !== '=') throw new Error('Malformed RAOP Digest challenge');
    while (input[offset] === ' ' || input[offset] === '\t') offset++;
    let value = '';
    if (input[offset] === '"') {
      offset++;
      let closed = false;
      while (offset < input.length) {
        const character = input[offset++]!;
        if (character === '"') { closed = true; break; }
        if (character === '\\') {
          if (offset === input.length) throw new Error('Malformed RAOP Digest challenge');
          value += input[offset++]!;
        } else value += character;
      }
      if (!closed) throw new Error('Malformed RAOP Digest challenge');
    } else {
      const valueStart = offset;
      while (/[!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(input[offset] ?? '')) offset++;
      value = input.slice(valueStart, offset);
    }
    if (!safe(value) || parameters.has(name)) throw new Error('Malformed RAOP Digest challenge');
    parameters.set(name, value);
    while (input[offset] === ' ' || input[offset] === '\t') offset++;
    if (offset === input.length) return parameters;
    if (input[offset++] !== ',' || offset === input.length) throw new Error('Malformed RAOP Digest challenge');
  }
  return parameters;
}

function quote(value: string): string {
  if (!safe(value)) throw new Error('Unsafe RAOP Digest challenge value');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function safe(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value) && !/[\r\n]/.test(value);
}

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}
