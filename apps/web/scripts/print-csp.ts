import { defaultPolicy } from '../csp.js';

/**
 * Print the Content-Security-Policy this repository ships, for pasting into a
 * host vhost or for checking what a deploy will serve:
 *   pnpm --filter @pen/web csp:print
 */
process.stdout.write(`${defaultPolicy()}\n`);
