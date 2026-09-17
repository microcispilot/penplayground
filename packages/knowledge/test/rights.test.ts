import { describe, expect, it } from 'vitest';
import { RIGHTS_POLICY_REVISION, rightsFor, UNKNOWN_LICENSE_TEXT } from '../src/rights.js';

describe('rightsFor', () => {
  it('maps known repositories to their licences', () => {
    const swift = rightsFor(
      'https://raw.githubusercontent.com/swiftlang/swift-book/main/TSPL.docc/LanguageGuide/TheBasics.md',
    );
    expect(swift).toMatchObject({
      redistribution: 'allowed',
      ingestionAllowed: true,
      license: 'Apache-2.0',
      attribution: 'The Swift Programming Language, Apple Inc., Apache-2.0',
      policyRevision: RIGHTS_POLICY_REVISION,
      authorizedAudiences: ['*'],
    });
    expect(
      rightsFor(
        'https://raw.githubusercontent.com/rust-lang/book/main/src/ch04-01-what-is-ownership.md',
      ),
    ).toMatchObject({ redistribution: 'allowed', license: 'MIT OR Apache-2.0' });
    expect(
      rightsFor(
        'https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/javascript/guide/closures/index.md',
      ),
    ).toMatchObject({ redistribution: 'derived_only', license: 'CC-BY-SA-2.5' });
  });

  it('marks Wikipedia and Python docs as derived_only', () => {
    expect(rightsFor('https://en.wikipedia.org/w/api.php?action=query')).toMatchObject({
      redistribution: 'derived_only',
      ingestionAllowed: true,
      license: 'CC-BY-SA-4.0',
    });
    expect(rightsFor('https://docs.python.org/3/tutorial/introduction.html')).toMatchObject({
      redistribution: 'derived_only',
      ingestionAllowed: true,
      license: 'PSF-2.0',
    });
  });

  it('blocks Apple developer content and paywalled sites', () => {
    const apple = rightsFor('https://developer.apple.com/documentation/swift/optional');
    expect(apple).toMatchObject({
      redistribution: 'blocked',
      ingestionAllowed: false,
      authorizedAudiences: [],
    });
    expect(rightsFor('https://www.oreilly.com/library/view/x').ingestionAllowed).toBe(false);
    expect(rightsFor('https://medium.com/@someone/post').ingestionAllowed).toBe(false);
  });

  it('lets unknown domains in as derived_only with an explicit review note and the host as attribution', () => {
    const r = rightsFor('https://blog.example.net/post');
    expect(r).toMatchObject({
      redistribution: 'derived_only',
      ingestionAllowed: true,
      license: 'unknown',
      attribution: 'blog.example.net',
      licenseText: UNKNOWN_LICENSE_TEXT,
    });
    expect(
      rightsFor('https://raw.githubusercontent.com/someone/repo/main/README.md'),
    ).toMatchObject({ redistribution: 'derived_only', license: 'unknown' });
  });

  it('survives unparsable URLs', () => {
    expect(rightsFor('not a url')).toMatchObject({
      redistribution: 'derived_only',
      ingestionAllowed: true,
    });
  });
});
