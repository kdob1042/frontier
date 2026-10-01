import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

type AuthEnv = Pick<Env, 'ENVIRONMENT' | 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD' | 'OWNER_EMAIL'>;
export function isLocal(request: Request, env: AuthEnv) {
  const u = new URL(request.url);
  return env.ENVIRONMENT === 'local' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}
export async function authorize(
  request: Request,
  env: AuthEnv,
  testKey?: JWTVerifyGetKey,
): Promise<boolean> {
  if (isLocal(request, env)) return true;
  if (
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN) ||
    !env.ACCESS_AUD ||
    !env.OWNER_EMAIL
  )
    return false;
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return false;
  try {
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    const key =
      testKey ||
      createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
    const { payload } = await jwtVerify(token, key, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'email'],
    });
    return (
      typeof payload.email === 'string' &&
      payload.email.toLowerCase() === env.OWNER_EMAIL.toLowerCase()
    );
  } catch {
    return false;
  }
}
export function validOrigin(request: Request): boolean {
  return (
    request.headers.get('origin') === new URL(request.url).origin &&
    request.headers.get('content-type')?.split(';')[0] === 'application/json'
  );
}
