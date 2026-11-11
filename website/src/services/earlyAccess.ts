import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

type SubmitEarlyAccessLeadResponse = {
  status: 'created' | 'exists';
};

/**
 * Bump when the consent text under the early-access form changes; the server stores it with each
 * email as proof of what the person agreed to (docs/WEB_ANALYTICS.md, "Email collection").
 */
export const EARLY_ACCESS_CONSENT_VERSION = 'early_access_v1';

const submitEarlyAccessLeadCallable = httpsCallable<
  { email: string; consentVersion: string },
  SubmitEarlyAccessLeadResponse
>(functions, 'submitEarlyAccessLead', { timeout: 10_000 });

export async function submitEarlyAccessLead(email: string): Promise<SubmitEarlyAccessLeadResponse> {
  const normalizedEmail = email.trim().toLowerCase();

  const result = await submitEarlyAccessLeadCallable({
    email: normalizedEmail, consentVersion: EARLY_ACCESS_CONSENT_VERSION,
  });
  return result.data;
}
export type EmailPreferenceAction = 'confirm' | 'unsubscribe';
export type EmailPreferenceStatus = 'confirmed' | 'unsubscribed' | 'invalid';

/** Wording on /email-preferences when a lead confirms from an email (double opt-in / re-confirmation). */
export const EARLY_ACCESS_CONFIRM_VERSION = 'early_access_confirm_v1';

export async function updateEmailPreference(
  id: string, token: string, action: EmailPreferenceAction,
): Promise<EmailPreferenceStatus> {
  const result = await httpsCallable<
    { id: string; token: string; action: EmailPreferenceAction; consentVersion: string },
    { status: EmailPreferenceStatus }
  >(functions, 'updateEarlyAccessPreference', { timeout: 10_000 })({
    id, token, action, consentVersion: EARLY_ACCESS_CONFIRM_VERSION,
  });
  return result.data.status;
}
