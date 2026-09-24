import type { ListRepository, ParticipantRepository, schema } from '@pen/db';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { safeName } from './identity.js';

type ParticipantRow = typeof schema.participants.$inferSelect;

/** What we keep from a verified Google ID token: the stable id and the public profile. */
export const GoogleProfile = z.object({
  sub: z.string().min(1),
  email: z.string().email().nullable(),
  emailVerified: z.boolean(),
  name: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
});
export type GoogleProfile = z.infer<typeof GoogleProfile>;

/** Why a token was refused; the route maps every one of these to 401. */
export type GoogleTokenFailure = 'expired' | 'wrong_audience' | 'invalid';

export class GoogleTokenError extends Error {
  constructor(
    readonly reason: GoogleTokenFailure,
    detail: string,
  ) {
    super(detail);
  }
}

/** The verification seam: Google's library in production, a fake in tests. */
export interface GoogleTokenVerifier {
  verify(idToken: string): Promise<GoogleProfile>;
}

/**
 * `OAuth2Client.verifyIdToken` checks the signature against Google's rotating
 * certificates, the issuer, the expiry and — through `audience` — that the token
 * was minted for *our* client id, so a token for some other app is worthless here.
 */
export class GoogleLibraryVerifier implements GoogleTokenVerifier {
  private readonly client: OAuth2Client;
  constructor(private readonly clientId: string) {
    this.client = new OAuth2Client(clientId);
  }

  async verify(idToken: string): Promise<GoogleProfile> {
    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience: this.clientId });
      payload = ticket.getPayload();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The library's messages are stable (`Token used too late`, `Wrong recipient, payload audience != requiredAudience`).
      const reason: GoogleTokenFailure = /too late|expired/i.test(message)
        ? 'expired'
        : /audience|recipient/i.test(message)
          ? 'wrong_audience'
          : 'invalid';
      throw new GoogleTokenError(reason, message);
    }
    if (!payload?.sub) throw new GoogleTokenError('invalid', 'token has no subject');
    return GoogleProfile.parse({
      sub: payload.sub,
      email: payload.email ?? null,
      emailVerified: payload.email_verified === true,
      name: payload.name ?? null,
      avatarUrl: payload.picture ?? null,
    });
  }
}

/**
 * The exchange seam: the authorization code Google's popup hands the app's
 * own button, for the ID token behind it. Google's library in production, a
 * fake in tests.
 */
export interface GoogleCodeExchanger {
  exchange(code: string): Promise<string>;
}

/**
 * The popup code flow (`google.accounts.oauth2.initCodeClient`, `ux_mode:
 * 'popup'`) returns a one-time code whose redirect URI is the literal
 * `postmessage`; exchanging it needs the client secret, which is why the
 * secret lives here and never in the browser. The ID token that comes back
 * is verified exactly as one from Google's own button would be.
 */
export class GoogleLibraryExchanger implements GoogleCodeExchanger {
  private readonly client: OAuth2Client;
  constructor(clientId: string, clientSecret: string) {
    this.client = new OAuth2Client({ clientId, clientSecret, redirectUri: 'postmessage' });
  }

  async exchange(code: string): Promise<string> {
    let idToken: string | null | undefined;
    try {
      const { tokens } = await this.client.getToken(code);
      idToken = tokens.id_token;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A used, expired or forged code is `invalid_grant` from Google: the
      // route says "try again", which is the right answer to all three.
      throw new GoogleTokenError('invalid', message);
    }
    if (!idToken) throw new GoogleTokenError('invalid', 'the exchange returned no ID token');
    return idToken;
  }
}

export type GoogleSignInOutcome = 'linked' | 'existing' | 'created';

export interface GoogleSignInResult {
  participant: ParticipantRow;
  outcome: GoogleSignInOutcome;
  /** Sessions moved from the anonymous caller onto an account that already existed. */
  adoptedSessions: number;
  /** Saves, likes and history rows moved the same way (ADR-0015). */
  adoptedLists: { saved: number; liked: number; history: number };
}

const NOTHING_ADOPTED = { saved: 0, liked: 0, history: 0 };

/** The display name the row ends up with once Google is attached. */
const DEFAULT_ANONYMOUS_NAME = 'Learner';

/**
 * Google sign-in on the participant row. Three cases, in order:
 *
 * 1. this Google account already has a row → that account, profile refreshed;
 *    an anonymous caller's sessions and lists are moved onto it so nothing is lost;
 * 2. the caller is anonymous → the same row is upgraded in place (same id, so
 *    its sessions and its bearer stay valid);
 * 3. otherwise → a new account row.
 *
 * The verifier decides whether a token is trusted; this class only decides
 * which row the trusted identity lands on.
 */
export class GoogleSignIn {
  constructor(
    private readonly verifier: GoogleTokenVerifier,
    private readonly participants: ParticipantRepository,
    private readonly lists: ListRepository,
    private readonly defaultPlan: ParticipantRow['plan'] = 'free',
    private readonly exchanger: GoogleCodeExchanger | null = null,
  ) {}

  /** Whether the app's own button (the code flow) can be honoured here: the secret is configured. */
  get exchangesCodes(): boolean {
    return this.exchanger !== null;
  }

  /** The app's own button: a popup code, exchanged, then the same three cases as an ID token. */
  async signInWithCode(code: string, caller: ParticipantRow | null): Promise<GoogleSignInResult> {
    if (!this.exchanger)
      throw new Error('GOOGLE_CLIENT_SECRET is not set: codes cannot be exchanged');
    return this.signIn(await this.exchanger.exchange(code), caller);
  }

  async signIn(idToken: string, caller: ParticipantRow | null): Promise<GoogleSignInResult> {
    const profile = await this.verifier.verify(idToken);
    // An unverified address is still Google's word for who this is, but it must not
    // become the address Stripe receipts or account mail go to.
    const email = profile.emailVerified ? profile.email : null;
    const existing = await this.participants.findByGoogleSub(profile.sub);
    if (existing) {
      const link = {
        googleSub: profile.sub,
        email,
        // A name the person chose here wins over Google's.
        name: existing.name || safeName(profile.name),
        avatarUrl: profile.avatarUrl,
      };
      const refreshed = (await this.participants.linkGoogle(existing.id, link)) ?? existing;
      const adopting = caller?.anonymous === true && caller.id !== existing.id;
      const adoptedSessions = adopting
        ? await this.participants.adoptSessions(caller.id, existing.id, refreshed.name)
        : 0;
      const adoptedLists = adopting
        ? await this.lists.adopt(caller.id, existing.id)
        : NOTHING_ADOPTED;
      return { participant: refreshed, outcome: 'existing', adoptedSessions, adoptedLists };
    }
    if (caller?.anonymous) {
      const link = {
        googleSub: profile.sub,
        email,
        name:
          caller.name && caller.name !== DEFAULT_ANONYMOUS_NAME
            ? caller.name
            : safeName(profile.name),
        avatarUrl: profile.avatarUrl,
      };
      const upgraded = await this.participants.linkGoogle(caller.id, link);
      if (upgraded)
        return {
          participant: upgraded,
          outcome: 'linked',
          adoptedSessions: 0,
          adoptedLists: NOTHING_ADOPTED,
        };
    }
    const created = await this.participants.createGoogle(`p_${nanoid(16)}`, this.defaultPlan, {
      googleSub: profile.sub,
      email,
      name: safeName(profile.name),
      avatarUrl: profile.avatarUrl,
    });
    return {
      participant: created,
      outcome: 'created',
      adoptedSessions: 0,
      adoptedLists: NOTHING_ADOPTED,
    };
  }
}
