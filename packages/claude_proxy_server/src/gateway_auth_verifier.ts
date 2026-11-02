import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export interface GatewayAuthVerifierOptions {
  /** How long the verifier keeps a pass from Gateway Auth. It never keeps a refusal. */
  cacheMilliseconds: number;
  /** How long the verifier waits for Gateway Auth. No answer in this time is a refusal. */
  timeoutMilliseconds: number;
}

/**
 * Asks Gateway Auth's `/verify` URL whether a request has a valid `X-Gateway-Auth-Token` or `gate_session` cookie.
 * Gateway Auth alone checks the token and the login. The verifier sends it only those two headers, and passes only on a 200.
 * It never logs a token or a cookie.
 */
export class GatewayAuthVerifier {
  private readonly gatewayAuthVerifyUrl: URL;
  private readonly options: GatewayAuthVerifierOptions;
  /** The time until which each pass is kept, keyed by the kind of credential and the SHA-256 of its value. */
  private readonly passExpiresAtByCredentialKey = new Map<string, number>();

  constructor(gatewayAuthVerifyUrl: URL, options: GatewayAuthVerifierOptions) {
    this.gatewayAuthVerifyUrl = gatewayAuthVerifyUrl;
    this.options = options;
  }

  async isVerified(requestHeaders: IncomingHttpHeaders): Promise<boolean> {
    const gatewayAuthToken = readSingleHeaderValue(requestHeaders['x-gateway-auth-token']);
    const cookieHeader = readSingleHeaderValue(requestHeaders.cookie);
    const gateSession = cookieHeader === null ? null : readGateSessionCookie(cookieHeader);
    // Gateway Auth checks the token when the header is present, and the cookie only without it. The cache key follows that order.
    let credentialKey: string;
    if (gatewayAuthToken !== null && gatewayAuthToken !== '') credentialKey = `x-gateway-auth-token:${sha256Hex(gatewayAuthToken)}`;
    else if (gateSession !== null && gateSession !== '') credentialKey = `gate_session:${sha256Hex(gateSession)}`;
    else return false;

    const passExpiresAt = this.passExpiresAtByCredentialKey.get(credentialKey);
    if (passExpiresAt !== undefined && Date.now() < passExpiresAt) return true;
    this.passExpiresAtByCredentialKey.delete(credentialKey);

    const verifyRequestHeaders: Record<string, string> = {};
    if (gatewayAuthToken !== null) verifyRequestHeaders['x-gateway-auth-token'] = gatewayAuthToken;
    if (cookieHeader !== null) verifyRequestHeaders.cookie = cookieHeader;
    let verifyResponseStatus: number;
    try {
      const verifyResponse = await fetch(this.gatewayAuthVerifyUrl, {
        method: 'GET',
        headers: verifyRequestHeaders,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMilliseconds),
      });
      verifyResponseStatus = verifyResponse.status;
      await verifyResponse.body?.cancel();
    } catch (error) {
      console.error(`claude-proxy could not ask Gateway Auth at ${this.gatewayAuthVerifyUrl.origin}${this.gatewayAuthVerifyUrl.pathname}: ${(error as Error).message}`);
      return false;
    }
    if (verifyResponseStatus !== 200) return false;

    this.deleteExpiredPasses();
    this.passExpiresAtByCredentialKey.set(credentialKey, Date.now() + this.options.cacheMilliseconds);
    return true;
  }

  private deleteExpiredPasses(): void {
    const now = Date.now();
    for (const [credentialKey, passExpiresAt] of this.passExpiresAtByCredentialKey) {
      if (passExpiresAt <= now) this.passExpiresAtByCredentialKey.delete(credentialKey);
    }
  }
}

/** Node joins repeated custom headers and `Cookie` into one string, so only `set-cookie` is an array, which a request does not send. */
function readSingleHeaderValue(headerValue: string | string[] | undefined): string | null {
  if (headerValue === undefined) return null;
  return Array.isArray(headerValue) ? headerValue.join(', ') : headerValue;
}

/** Reads the `gate_session` cookie as Gateway Auth's `parseCookies` does: the pairs split at `;`, and the last pair wins. */
function readGateSessionCookie(cookieHeader: string): string | null {
  let gateSession: string | null = null;
  for (const cookiePair of cookieHeader.split(';')) {
    const equalsSignIndex = cookiePair.indexOf('=');
    if (equalsSignIndex === -1) continue;
    if (cookiePair.substring(0, equalsSignIndex).trim() === 'gate_session') gateSession = cookiePair.substring(equalsSignIndex + 1).trim();
  }
  return gateSession;
}

function sha256Hex(credentialValue: string): string {
  return createHash('sha256').update(credentialValue).digest('hex');
}
