import { describe, expect, it } from 'vitest';
import { PRIVACY_URL, PUBLIC_SITE, TERMS_URL } from '@/lib/site';
import { APPLE_SIGN_IN_NOTE, deletionWords } from './words';

describe('the words around deleting an account', () => {
  it('tells people who signed in with Apple where to remove the app’s access themselves', () => {
    expect(APPLE_SIGN_IN_NOTE).toBe('If you signed in with Apple, you can also remove this app’s access on your iPhone, under Settings > Apple Account > Sign in with Apple.');
  });

  it('says the sign-in is gone only when the server says so', () => {
    expect(deletionWords({ auth_user_deleted: true } as never).title).toBe('Your account is deleted');
    expect(deletionWords({ auth_user_deleted: false, auth_deletion: 'pending' } as never).title).toBe('Your library is deleted');
  });
});

describe('the public pages the app links to', () => {
  it('are built from the one site address', () => {
    expect(PRIVACY_URL).toBe(`${PUBLIC_SITE}/privacy.html`);
    expect(TERMS_URL).toBe(`${PUBLIC_SITE}/terms.html`);
    expect(PUBLIC_SITE).toMatch(/^https:\/\/[^/]+(\/[^/]+)*$/);
  });
});
