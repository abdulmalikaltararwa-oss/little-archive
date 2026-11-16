import { describe, expect, it } from 'vitest';
import { PRIVACY_URL, PUBLIC_SITE, TERMS_URL } from '@/lib/site';
import { serverWords } from '@/lib/server-words';
import { PURCHASE_NAMES, VIA } from '../unlock/purchase';
import { APPLE_SIGN_IN_NOTE, deletionWords } from './words';

describe('the words around deleting an account', () => {
  it('tells people who signed in with Apple where to remove the app’s access themselves', () => {
    expect(APPLE_SIGN_IN_NOTE).toBe('If you signed in with Apple, you can also remove this app’s access on your iPhone, under Settings > Apple Account > Sign in with Apple.');
  });

  it('says the sign-in is gone only when the server says so', () => {
    const gone = deletionWords({ auth_user_deleted: true } as never);
    expect(gone.title).toBe('Your account is deleted');
    // A short record does stay, so it never says nothing is left.
    expect(gone.body).toBe('Your library, your unlock and your sign-in are removed. The service keeps a short record with none of your content: when the deletion happened, for 30 days, and this month’s usage counts until the month ends. A purchase the store took back stays on record, and backups the service made earlier are not changed.');
    expect(gone.body).not.toMatch(/nothing left/i);
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

describe('words that depend on whose server it is', () => {
  it('say "the service" on a hosted account and are left alone on a self-hosted one', () => {
    expect(serverWords('Your server is joining them. It goes to your server, your own server.', 'hosted')).toBe('The service is joining them. It goes to the service, the service.');
    expect(serverWords('It goes to your server.', 'self-hosted')).toBe('It goes to your server.');
    expect(serverWords('It goes to your server.', undefined)).toBe('It goes to your server.');
  });
});

describe('how an unlock was bought', () => {
  it('names a web payment without pointing anywhere', () => {
    expect(VIA.tap).toBe('a payment on the web');
    expect(PURCHASE_NAMES.tap).toBe('Bought on the web');
    expect(`${VIA.tap} ${PURCHASE_NAMES.tap}`).not.toMatch(/https?:|\.com|pay page|tap/i);
  });
});
