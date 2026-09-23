import { logger } from '../logger.js';

/**
 * The one place that sends mail.
 *
 * Simurgh uses raw `smtplib` over STARTTLS with no provider SDK, and the owner
 * asked to use the same path — they add a domain there and Pen sends through
 * the same relay. `nodemailer` is the same protocol from Node.
 *
 * ── why there is a second transport ────────────────────────────────────────
 *
 * Without credentials there is nothing to send with, and a sign-up flow that
 * cannot be exercised until a secret arrives is a flow nobody reviews. So when
 * no host is configured the code goes to the log instead, clearly marked, and
 * the whole journey — challenge, code, account, sign-in — can be walked today.
 *
 * That is a development affordance, and production never gets it: with no SMTP
 * there, `send` refuses and logs an error *without the body*. A code in a
 * production log is a code somebody can read.
 */
export interface Mailer {
  /** Resolves when the message is handed off. Throws if it cannot be. */
  send(message: { to: string; subject: string; text: string }): Promise<void>;
  /** What this mailer is, for the boot line. */
  readonly kind: 'smtp' | 'log' | 'refusing';
}

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
}

/**
 * The settings as they arrive from the environment, where every one of them
 * may be absent. `createMailer` is what turns "some of these are missing" into
 * a decision, so the shape it accepts has to admit the missing ones.
 */
export interface SmtpEnv {
  host?: string | undefined;
  port?: number | undefined;
  username?: string | undefined;
  password?: string | undefined;
  from?: string | undefined;
}

/**
 * Writes the message to the log instead of sending it. Development only.
 *
 * It logs the body, which contains the code, on purpose — that is the entire
 * point of it. `createMailer` is what makes sure this never runs where a log
 * is a shared, retained thing.
 */
export function logMailer(): Mailer {
  return {
    kind: 'log',
    async send({ to, subject, text }) {
      logger.warn(
        { evt: 'mail.not_sent', to, subject, body: text },
        'no SMTP configured — the message was logged instead of sent (development only)',
      );
    },
  };
}

export function smtpMailer(cfg: SmtpConfig): Mailer {
  // Imported lazily so a deployment with no SMTP never pays for the dependency.
  const transport = import('nodemailer').then((nodemailer) =>
    nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      // 587 is STARTTLS (upgrade an unencrypted connection), 465 is implicit
      // TLS. Getting this backwards fails to connect rather than sending in
      // the clear, but it fails confusingly, so it is derived rather than set.
      secure: cfg.port === 465,
      auth: { user: cfg.username, pass: cfg.password },
      requireTLS: cfg.port !== 465,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    }),
  );
  return {
    kind: 'smtp',
    async send({ to, subject, text }) {
      const t = await transport;
      await t.sendMail({ from: cfg.from, to, subject, text });
    },
  };
}

/**
 * A mailer that cannot send, and says so at the point of use.
 *
 * Production with no SMTP configured. It must not log the body — a
 * verification code in a production log is a code somebody can read — and it
 * must not pretend to have sent anything, so it throws and the route turns
 * that into a 503 the caller can act on.
 */
function refusingMailer(): Mailer {
  return {
    kind: 'refusing',
    async send({ to, subject }) {
      logger.error(
        { evt: 'mail.unconfigured', to, subject },
        'no SMTP is configured: set PEN_SMTP_HOST, PEN_SMTP_USERNAME, PEN_SMTP_PASSWORD and PEN_SMTP_FROM',
      );
      throw new Error('SMTP is not configured');
    },
  };
}

/**
 * Pick a mailer for the environment.
 *
 * Three outcomes, and the middle one is a correction. This used to *throw* when
 * production had no SMTP, on the reasoning that a deployment which silently
 * logged codes would look healthy and deliver nothing. The reasoning was right
 * and the remedy was far too broad: it ran inside `buildServices`, so the API
 * refused to boot at all, and a missing mail credential took down lessons,
 * rooms, replays and every other thing this product does. It did exactly that
 * on the first deploy after it was written.
 *
 * So the refusal moved to where the damage is. The process boots, everything
 * unrelated to email works, and the one thing that genuinely cannot happen —
 * signing up — fails honestly with a 503 and an error in the log. Nothing is
 * ever written to a production log that a code could be read out of.
 */
export function createMailer(opts: { production: boolean; smtp: SmtpEnv | null }): Mailer {
  const { host, port, username, password, from } = opts.smtp ?? {};
  const configured = Boolean(host && username && password && from);
  if (!configured) return opts.production ? refusingMailer() : logMailer();
  return smtpMailer({
    host: host as string,
    port: port ?? 587,
    username: username as string,
    password: password as string,
    from: from as string,
  });
}

// ── the messages ────────────────────────────────────────────────────────────
//
// Plain text, like Simurgh's, and for the same reason: a verification mail
// that renders as a wall of HTML in one client and a blank in another is a
// support ticket. These are short enough to read in a notification.

export function verificationEmail(code: string, minutes: number) {
  return {
    subject: `${code} is your Pen Playground code`,
    text:
      `Use this code to finish creating your Pen Playground account:\n\n` +
      `    ${code}\n\n` +
      `It expires in ${minutes} minutes. If you did not ask for it, you can ignore this message ` +
      `— nothing was created.\n`,
  };
}

export function resetEmail(code: string, minutes: number) {
  return {
    subject: `${code} is your Pen Playground reset code`,
    text:
      `Use this code to set a new password for your Pen Playground account:\n\n` +
      `    ${code}\n\n` +
      `It expires in ${minutes} minutes. If you did not ask for it, you can ignore this message ` +
      `— your password has not changed.\n`,
  };
}

/**
 * Sent instead of a code when the address already has an account.
 *
 * This is what makes the endpoint enumeration-proof without lying to the
 * person: the HTTP response is identical either way, and the difference goes
 * to the mailbox, where only its owner can read it. Somebody probing for
 * registered addresses learns nothing; somebody who genuinely forgot they had
 * an account gets told exactly that.
 */
export function existingAccountEmail(signInUrl: string) {
  return {
    subject: 'You already have a Pen Playground account',
    text:
      `Somebody asked to create a Pen Playground account with this address, but it already has one.\n\n` +
      `If that was you, sign in instead: ${signInUrl}\n` +
      `If you have forgotten your password, use "Forgot password" on that page.\n\n` +
      `If it was not you, you can ignore this message — nothing was created or changed.\n`,
  };
}
