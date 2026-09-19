import { isIP } from 'node:net';
import { clientAddress } from '../rate-limit.js';

/**
 * The address a visit is recorded against (ADR-0028).
 *
 * There is deliberately no second opinion here about *which header* names a
 * client: `clientAddress` is the same resolution the per-IP session cap and
 * the beacon limiter use, and this adds only the two things a stored value
 * needs that an in-memory bucket key does not.
 *
 * 1. **It must actually be an address.** A rate-limit bucket is happy with
 *    any string; a column called `ip_address` is not. `node:net`'s `isIP` is
 *    the same parser the runtime uses for sockets, so what is stored is what
 *    the operating system would call an address and nothing else. Anything
 *    that fails is null — a header nobody set, a hostname, a proxy's
 *    `unknown`, a forged value that is not an address.
 * 2. **One spelling per machine.** A port is stripped, brackets are stripped,
 *    an IPv6 address is lowercased, and an IPv4-mapped IPv6 address
 *    (`::ffff:203.0.113.7`) is written as the IPv4 it is. Without that the
 *    same laptop is two addresses depending on which socket family the edge
 *    accepted it on.
 *
 * Both families are stored in full. Truncating an IPv4 address to its /24 is
 * the usual half-measure and it was declined: it does not make the row
 * anonymous, and it does make the address useless for the one question it is
 * kept for. Retention is what bounds this, not precision.
 */
export function visitAddress(headers: { header(name: string): string | undefined }): string | null {
  return normaliseAddress(clientAddress(headers));
}

/** The address, normalised — or null if the string is not one. Exported for the tests. */
export function normaliseAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  let v = value.trim();
  if (v.length === 0) return null;

  // `[2001:db8::1]:443` — the bracketed form, with or without a port.
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(v);
  if (bracketed?.[1]) v = bracketed[1];
  // `203.0.113.7:443` — an IPv4 with a port. An unbracketed IPv6 has many
  // colons, so "exactly one colon" is what separates the two cases safely.
  else if (v.indexOf(':') === v.lastIndexOf(':') && /:\d{1,5}$/.test(v))
    v = v.slice(0, v.indexOf(':'));

  // A zone index (`fe80::1%eth0`) names an interface on the machine that read
  // the packet, not the visitor; it is never part of the address we keep.
  const zone = v.indexOf('%');
  if (zone > 0) v = v.slice(0, zone);

  const family = isIP(v);
  if (family === 4) return v;
  if (family !== 6) return null;

  const lower = v.toLowerCase();
  // `::ffff:203.0.113.7` is an IPv4 address wearing an IPv6 socket.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped?.[1] && isIP(mapped[1]) === 4) return mapped[1];
  return lower;
}
