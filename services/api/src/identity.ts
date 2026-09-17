import { jwtVerify, SignJWT } from 'jose';
import { nanoid } from 'nanoid';
import { z } from 'zod';

/**
 * Participant identity. Today: anonymous participants (a stable id + display
 * name) signed into a JWT; accounts (Google/email) and paid plans land on the
 * same claims shape so nothing downstream changes.
 */
export const Claims = z.object({
  sub: z.string().min(8),
  name: z.string().min(1).max(60),
  plan: z.enum(['free', 'standard', 'professional']),
  anonymous: z.boolean(),
});
export type Claims = z.infer<typeof Claims>;

export class Identity {
  private readonly key: Uint8Array;
  constructor(
    secret: string,
    private readonly issuer = 'pen-academy',
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(
    claims: Omit<Claims, 'sub'> & { sub?: string },
    ttl = '30d',
  ): Promise<{ token: string; claims: Claims }> {
    const full: Claims = {
      sub: claims.sub ?? `p_${nanoid(16)}`,
      name: claims.name,
      plan: claims.plan,
      anonymous: claims.anonymous,
    };
    const token = await new SignJWT({ name: full.name, plan: full.plan, anonymous: full.anonymous })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(full.sub)
      .setIssuer(this.issuer)
      .setAudience('pen-web')
      .setIssuedAt()
      .setExpirationTime(ttl)
      .sign(this.key);
    return { token, claims: full };
  }

  async verify(token: string): Promise<Claims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.issuer,
        audience: 'pen-web',
        algorithms: ['HS256'],
      });
      return Claims.parse({
        sub: payload.sub,
        name: payload.name,
        plan: payload.plan,
        anonymous: payload.anonymous,
      });
    } catch {
      return null;
    }
  }
}

const CONTROL_OR_MARKUP = /[\p{Cc}<>]/gu;

export function safeName(input: unknown): string {
  const s = typeof input === 'string' ? input.replace(CONTROL_OR_MARKUP, '').trim() : '';
  return s.slice(0, 60) || 'Learner';
}
