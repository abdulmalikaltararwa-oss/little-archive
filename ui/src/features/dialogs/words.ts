// Sentences that depend on what the server answered, kept apart from the dialogs so they can be tested.
import type { AccountDeletion } from '@/data/types';

/** What the server did, in the words for each outcome. The library is always gone; the sign-in may lag behind or stay. */
export function deletionWords(result: AccountDeletion): { title: string; body: string } {
  if (result.auth_user_deleted) return { title: 'Your account is deleted', body: 'Your library, your unlock and your sign-in are removed. The service keeps a short record with none of your content: when the deletion happened, for 30 days, and this month’s usage counts until the month ends. A purchase the store took back stays on record, and backups the service made earlier are not changed.' };
  if (result.auth_deletion === 'pending') {
    return { title: 'Your library is deleted', body: result.detail || 'Your sign-in could not be removed just yet. The service keeps trying until it is gone; there is nothing more you need to do.' };
  }
  return { title: 'Your library is deleted', body: 'This service is not set up to remove sign-ins, so your sign-in is still registered with its sign-in provider. Ask whoever runs the service to remove it.' };
}

/**
 * For people who signed in with Apple. The interface is not told how an account signed in, so this is said to
 * everyone, as something they can do themselves; it claims nothing about what the service removes at Apple.
 */
export const APPLE_SIGN_IN_NOTE = 'If you signed in with Apple, you can also remove this app’s access on your iPhone, under Settings > Apple Account > Sign in with Apple.';
