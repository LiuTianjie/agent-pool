import { describe, expect, it } from 'vitest';
import { isKnownSpaPath, isMissingStaticAsset, requestPath } from './spa-routes.js';

describe('SPA route classification', () => {
  it('keeps known app shells as HTML routes', () => {
    expect(isKnownSpaPath('/')).toBe(true);
    expect(isKnownSpaPath('/login')).toBe(true);
    expect(isKnownSpaPath('/app/pools/new')).toBe(true);
    expect(isKnownSpaPath('/connect')).toBe(true);
  });

  it('treats unknown paths as not-found HTML and hashed files as missing assets', () => {
    expect(isKnownSpaPath('/nope')).toBe(false);
    expect(isMissingStaticAsset('/favicon.ico')).toBe(true);
    expect(isMissingStaticAsset('/assets/index-abc.js')).toBe(true);
    expect(isMissingStaticAsset('/app/run')).toBe(false);
    expect(requestPath('/nope?x=1')).toBe('/nope');
  });
});
