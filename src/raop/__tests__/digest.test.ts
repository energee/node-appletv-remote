import { describe, expect, it } from 'vitest';
import { legacyDigestAuthorization, parseLegacyDigestChallenge } from '../digest.js';

describe('legacy RAOP Digest', () => {
  it('calculates the RFC 2069 section 2.4 no-qop MD5 response', () => {
    // RFC 2069 §2.4: https://www.rfc-editor.org/rfc/rfc2069#section-2.4
    const challenge = parseLegacyDigestChallenge('Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", algorithm=MD5');
    expect(legacyDigestAuthorization(challenge, 'GET', '/dir/index.html', 'Circle Of Life', 'Mufasa')).toContain('response="670fd8c2df070c60b045671b8b24ff02"');
  });

  it('accepts RFC optional whitespace and re-escapes opaque values safely', () => {
    const challenge = parseLegacyDigestChallenge('Digest realm = "raop", nonce = "nonce", opaque = "a\\\"b\\\\c"');
    expect(legacyDigestAuthorization(challenge, 'ANNOUNCE', 'rtsp://127.0.0.1/1', 'not-in-output')).toContain('opaque="a\\\"b\\\\c"');
    expect(parseLegacyDigestChallenge('Digest realm="raop", nonce="nonce", opaque=""').opaque).toBe('');
  });

  it.each([
    'Basic realm="raop"',
    'Digest realm="raop"',
    'Digest nonce="nonce"',
    'Digest realm="raop", nonce="nonce", algorithm=SHA-256',
    'Digest realm="raop", nonce="nonce", qop="auth"',
    'Digest realm="raop", nonce="nonce", charset=UTF-8',
    'Digest realm="raop", nonce="nonce", userhash=true',
    'Digest realm="raop", nonce="nonce", stale=true',
    'Digest realm="raop", nonce="nonce", __proto__="unsupported"',
    'Digest realm="raop", nonce="nonce", realm="again"',
    'Digest realm="raop", nonce="nonce",',
  ])('rejects unsupported or malformed challenges', header => {
    expect(() => parseLegacyDigestChallenge(header)).toThrow();
  });
});
