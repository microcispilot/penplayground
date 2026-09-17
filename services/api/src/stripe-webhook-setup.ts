import { BILLING_WEBHOOK_EVENTS } from './billing.js';

/** The slice of a Stripe webhook endpoint the reconciliation looks at. */
export interface WebhookEndpointLike {
  id: string;
  url: string;
  status: string;
  enabled_events: string[];
}

export type WebhookDecision =
  | { action: 'create' }
  | { action: 'reuse'; id: string }
  | { action: 'update'; id: string; enabled_events: string[] };

/**
 * Decide what the registration script does with what Stripe already has for
 * `url`: nothing to do, extend the subscribed events, or create the endpoint.
 * Pure so the idempotency is testable without a Stripe account.
 */
export function decideWebhookEndpoint(
  existing: readonly WebhookEndpointLike[],
  url: string,
  events: readonly string[] = BILLING_WEBHOOK_EVENTS,
): WebhookDecision {
  const match = existing.find((e) => e.url === url && e.status !== 'disabled');
  if (!match) return { action: 'create' };
  const wanted = [...new Set(events)].sort();
  const have = new Set(match.enabled_events);
  if (have.has('*') || wanted.every((e) => have.has(e))) return { action: 'reuse', id: match.id };
  return {
    action: 'update',
    id: match.id,
    enabled_events: [...new Set([...match.enabled_events, ...wanted])].sort(),
  };
}

/**
 * Set `KEY=value` in the text of a dotenv file: replace the existing line
 * (first occurrence, comments and other keys untouched) or append one.
 */
export function upsertEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}=.*$`, 'm');
  if (pattern.test(text)) return text.replace(pattern, line);
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}${line}\n`;
}
