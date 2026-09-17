import { jwtVerify, SignJWT } from 'jose';

/**
 * Short-lived, single-purpose download tokens so an `<a download>` link can
 * fetch the MP4 without an Authorization header. Signed with the API secret
 * under its own audience: a session bearer never works as a download token
 * and a download token never works as a bearer.
 */
export class DownloadTokens {
  private readonly key: Uint8Array;
  constructor(
    secret: string,
    private readonly ttlSeconds = 15 * 60,
    private readonly issuer = 'pen-academy',
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  get ttlMs(): number {
    return this.ttlSeconds * 1000;
  }

  async issue(participantId: string, sessionId: string): Promise<string> {
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(participantId)
      .setIssuer(this.issuer)
      .setAudience('pen-export')
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
  }

  /** The participant the token was issued to, when it is valid for `sessionId`. */
  async verify(token: string, sessionId: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.issuer,
        audience: 'pen-export',
        algorithms: ['HS256'],
      });
      if (payload.sid !== sessionId || typeof payload.sub !== 'string') return null;
      return payload.sub;
    } catch {
      return null;
    }
  }
}
