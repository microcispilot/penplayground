import type { SourceRights } from '@pen/contracts';

/** Bump when a row changes so packs compiled under older rules can be re-audited. */
export const RIGHTS_POLICY_REVISION = '2026-09-16';

export const UNKNOWN_LICENSE_TEXT =
  'unknown; excerpted for teaching under fair use, review before publication';

type RightsRow = Pick<SourceRights, 'redistribution' | 'ingestionAllowed' | 'license' | 'attribution' | 'licenseText'>;

interface RightsRule {
  id: string;
  /** Hostname match (exact or suffix, case-insensitive). */
  host: string | RegExp;
  /** Optional pathname prefix. */
  path?: string;
  row: RightsRow;
}

const allowed = (license: string, attribution: string, licenseText: string): RightsRow => ({
  redistribution: 'allowed',
  ingestionAllowed: true,
  license,
  attribution,
  licenseText,
});
const derived = (license: string, attribution: string, licenseText: string): RightsRow => ({
  redistribution: 'derived_only',
  ingestionAllowed: true,
  license,
  attribution,
  licenseText,
});
const blocked = (attribution: string, licenseText: string): RightsRow => ({
  redistribution: 'blocked',
  ingestionAllowed: false,
  license: 'proprietary',
  attribution,
  licenseText,
});

/**
 * Licence hints per source. Order matters: the first matching rule wins, so
 * specific repositories come before host-wide rows and the unknown fallback.
 * Verified 2026-09-16 against each project's LICENSE file / licence page.
 */
export const RIGHTS_RULES: RightsRule[] = [
  {
    id: 'swift-book',
    host: 'raw.githubusercontent.com',
    path: '/swiftlang/swift-book/',
    row: allowed('Apache-2.0', 'The Swift Programming Language, Apple Inc., Apache-2.0', 'Apache License 2.0 (swiftlang/swift-book LICENSE.txt); attribution required, changes must be marked.'),
  },
  {
    id: 'swift-book-site',
    host: 'docs.swift.org',
    path: '/swift-book/',
    row: allowed('Apache-2.0', 'The Swift Programming Language, Apple Inc., Apache-2.0', 'Rendered swiftlang/swift-book; Apache License 2.0.'),
  },
  {
    id: 'rust-book',
    host: 'raw.githubusercontent.com',
    path: '/rust-lang/book/',
    row: allowed('MIT OR Apache-2.0', 'The Rust Programming Language, The Rust Project Developers, MIT/Apache-2.0', 'Dual MIT / Apache-2.0 (rust-lang/book LICENSE-MIT, LICENSE-APACHE); attribution required.'),
  },
  {
    id: 'rust-book-site',
    host: 'doc.rust-lang.org',
    path: '/book/',
    row: allowed('MIT OR Apache-2.0', 'The Rust Programming Language, The Rust Project Developers, MIT/Apache-2.0', 'Rendered rust-lang/book; dual MIT / Apache-2.0.'),
  },
  {
    id: 'mdn-content',
    host: 'raw.githubusercontent.com',
    path: '/mdn/content/',
    row: derived('CC-BY-SA-2.5', 'MDN Web Docs contributors, CC-BY-SA-2.5 (code samples CC0-1.0)', 'Prose CC-BY-SA-2.5, code samples CC0 (mdn/content LICENSE.md); share-alike applies to redistributed prose.'),
  },
  {
    id: 'mdn-site',
    host: 'developer.mozilla.org',
    row: derived('CC-BY-SA-2.5', 'MDN Web Docs contributors, CC-BY-SA-2.5 (code samples CC0-1.0)', 'Prose CC-BY-SA-2.5, code samples CC0; share-alike applies to redistributed prose.'),
  },
  {
    id: 'wikipedia',
    host: /(^|\.)wikipedia\.org$/,
    row: derived('CC-BY-SA-4.0', 'Wikipedia contributors, CC-BY-SA-4.0', 'Wikipedia text is CC-BY-SA-4.0 (some earlier text GFDL); attribution and share-alike required.'),
  },
  {
    id: 'python-docs',
    host: 'docs.python.org',
    row: derived('PSF-2.0', 'Python documentation, Python Software Foundation, PSF License 2.0', 'Python Software Foundation License Version 2 (docs.python.org/3/license.html); notice of copyright required in derived works.'),
  },
  {
    id: 'apple-developer',
    host: 'developer.apple.com',
    row: blocked('Apple Developer Documentation, Apple Inc.', 'Apple developer content forbids redistribution; cite by URL with a short excerpt only.'),
  },
  {
    id: 'oreilly',
    host: /(^|\.)oreilly\.com$/,
    row: blocked("O'Reilly Media", 'Paywalled, all rights reserved; cite by URL only.'),
  },
  {
    id: 'udemy',
    host: /(^|\.)udemy\.com$/,
    row: blocked('Udemy', 'Paywalled course content; cite by URL only.'),
  },
  {
    id: 'coursera',
    host: /(^|\.)coursera\.org$/,
    row: blocked('Coursera', 'Paywalled course content; cite by URL only.'),
  },
  {
    id: 'medium',
    host: /(^|\.)medium\.com$/,
    row: blocked('Medium authors', 'Author-owned articles under Medium terms; cite by URL only.'),
  },
  {
    id: 'microsoft-learn',
    host: 'learn.microsoft.com',
    row: derived('CC-BY-4.0', 'Microsoft Learn, Microsoft Corporation, CC-BY-4.0', 'Microsoft Docs are CC-BY-4.0 (docs repo LICENSE); attribution required.'),
  },
  {
    id: 'react-dev',
    host: 'react.dev',
    row: derived('CC-BY-4.0', 'React documentation, Meta Platforms, CC-BY-4.0', 'react.dev content is CC-BY-4.0 (reactjs/react.dev LICENSE-DOCS.md); attribution required.'),
  },
  {
    id: 'go-dev',
    host: 'go.dev',
    row: derived('CC-BY-4.0', 'The Go Programming Language documentation, Google, CC-BY-4.0', 'Go documentation is CC-BY-4.0 (go.dev/copyright); attribution required.'),
  },
  {
    id: 'kotlinlang',
    host: 'kotlinlang.org',
    row: derived('Apache-2.0', 'Kotlin documentation, JetBrains, Apache-2.0', 'Kotlin docs are Apache-2.0 (JetBrains/kotlin-web-site); attribution required.'),
  },
  {
    id: 'android-developers',
    host: 'developer.android.com',
    row: derived('CC-BY-2.5', 'Android Developers, Google, CC-BY-2.5', 'Android developer content is CC-BY-2.5 (developers.google.com/terms/site-policies); code samples Apache-2.0.'),
  },
  {
    id: 'stackoverflow',
    host: /(^|\.)stackoverflow\.com$|(^|\.)stackexchange\.com$/,
    row: derived('CC-BY-SA-4.0', 'Stack Overflow contributors, CC-BY-SA-4.0', 'User contributions licensed CC-BY-SA-4.0; attribution and share-alike required.'),
  },
  {
    id: 'github-raw-unknown',
    host: 'raw.githubusercontent.com',
    row: derived('unknown', 'GitHub repository content (licence not on file)', UNKNOWN_LICENSE_TEXT),
  },
];

const UNKNOWN_ROW: RightsRow = {
  redistribution: 'derived_only',
  ingestionAllowed: true,
  license: 'unknown',
  attribution: '',
  licenseText: UNKNOWN_LICENSE_TEXT,
};

function hostMatches(host: string, rule: RightsRule['host']): boolean {
  if (rule instanceof RegExp) return rule.test(host);
  return host === rule || host.endsWith(`.${rule}`);
}

/** Rights for a URL. Unknown domains are ingestible as `derived_only` with an explicit review note. */
export function rightsFor(url: string): SourceRights {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  let row = UNKNOWN_ROW;
  if (parsed) {
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const rule = RIGHTS_RULES.find((r) => hostMatches(host, r.host) && (!r.path || parsed.pathname.startsWith(r.path)));
    if (rule) row = rule.row;
    else row = { ...UNKNOWN_ROW, attribution: host };
  }
  return {
    ...row,
    authorizedAudiences: row.ingestionAllowed ? ['*'] : [],
    policyRevision: RIGHTS_POLICY_REVISION,
  };
}
