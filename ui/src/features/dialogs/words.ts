// Sentences that depend on what the server answered, kept apart from the dialogs so they can be tested.
import type { AccountDeletion } from '@/data/types';

/** What the server did, in the words for each outcome. The library is always gone; the sign-in may lag behind or stay. */
export function deletionWords(result: AccountDeletion): { title: string; body: string } {
  if (result.auth_user_deleted) return { title: 'Your account is deleted', body: 'Your library and your sign-in are both gone. There is nothing left on the service.' };
  if (result.auth_deletion === 'pending') {
    return { title: 'Your library is deleted', body: result.detail || 'Your sign-in could not be removed just yet. The service keeps trying until it is gone; there is nothing more you need to do.' };
  }
  return { title: 'Your library is deleted', body: 'This service is not set up to remove sign-ins, so your email is still registered with its sign-in provider. Ask whoever runs the service to remove it.' };
}
