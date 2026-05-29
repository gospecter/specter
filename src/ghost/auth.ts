/**
 * Ghost Admin API JWT authentication.
 * HS256 HMAC with hex-encoded secret. Token expires in 5 minutes.
 * Uses the Web Crypto API, which Node 20+ exposes globally.
 */

export function parseApiKey(apiKey: string): { keyId: string; keySecret: string } {
  const [keyId, keySecret] = apiKey.split(':');
  if (!keyId || !keySecret) {
    throw new Error('Invalid API key format. Expected "id:secret".');
  }
  return { keyId, keySecret };
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(hex.length / 2);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function base64UrlEncode(data: Uint8Array | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function generateJWT(keyId: string, keySecret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT', kid: keyId };
  const payload = { iat: now, exp: now + 300, aud: '/admin/' };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const message = `${encodedHeader}.${encodedPayload}`;

  const secretBytes = hexToBytes(keySecret);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return `${message}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export async function getAuthHeaders(apiKey: string): Promise<Record<string, string>> {
  const { keyId, keySecret } = parseApiKey(apiKey);
  const token = await generateJWT(keyId, keySecret);
  return {
    Authorization: `Ghost ${token}`,
    'Accept-Version': 'v5.0',
    'Content-Type': 'application/json',
  };
}
