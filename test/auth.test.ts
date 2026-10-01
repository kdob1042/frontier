import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { authorize, validOrigin } from '../src/worker/auth';

test('local bypass is limited to loopback and disabled for deployed environments', async () => {
  const env = { ENVIRONMENT: 'local', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', OWNER_EMAIL: '' };
  assert.equal(await authorize(new Request('http://localhost:8792'), env), true);
  assert.equal(await authorize(new Request('https://frontier.example.com'), env), false);
  assert.equal(
    await authorize(new Request('http://localhost:8792'), { ...env, ENVIRONMENT: 'production' }),
    false,
  );
  assert.equal(
    await authorize(new Request('http://localhost:8792'), { ...env, ENVIRONMENT: 'preview' }),
    false,
  );
});
test('signed owner JWT requires the correct issuer, audience, lifetime and owner email', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key: JWTVerifyGetKey = async () => publicKey;
  const env = {
    ENVIRONMENT: 'production',
    ACCESS_TEAM_DOMAIN: 'frontier.cloudflareaccess.com',
    ACCESS_AUD: 'frontier-audience',
    OWNER_EMAIL: 'owner@example.com',
  };
  const token = async (email: string, aud = 'frontier-audience', exp = '1 hour') =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://frontier.cloudflareaccess.com')
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(privateKey);
  const req = (jwt: string) =>
    new Request('https://private.example.com', { headers: { 'cf-access-jwt-assertion': jwt } });
  assert.equal(await authorize(req(await token(env.OWNER_EMAIL)), env, key), true);
  assert.equal(await authorize(req(await token('another@example.com')), env, key), false);
  assert.equal(
    await authorize(req(await token(env.OWNER_EMAIL, 'another-audience')), env, key),
    false,
  );
  assert.equal(
    await authorize(req(await token(env.OWNER_EMAIL, 'frontier-audience', '-1 second')), env, key),
    false,
  );
  const forged = (await token(env.OWNER_EMAIL)).split('.');
  forged[1] = Buffer.from(JSON.stringify({ email: env.OWNER_EMAIL })).toString('base64url');
  assert.equal(await authorize(req(forged.join('.')), env, key), false);
});
test('state changes require same-origin JSON, independent of Access cookies', () => {
  const request = (origin: string, type = 'application/json') =>
    new Request('https://private.example.com/api/views/adopt', {
      method: 'POST',
      headers: { origin, 'content-type': type },
    });
  assert.equal(validOrigin(request('https://private.example.com')), true);
  assert.equal(validOrigin(request('https://evil.example.com')), false);
  assert.equal(validOrigin(request('https://private.example.com', 'text/plain')), false);
  assert.equal(
    validOrigin(new Request('https://private.example.com/api/views/adopt', { method: 'POST' })),
    false,
  );
});
