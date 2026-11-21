import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import {
  LEAD_PURPOSE, isValidLeadEmail, leadId, newUnsubscribeToken, normalizeLeadEmail, tokensMatch,
  validConsentVersion, validPreferenceRequest, type PreferenceStatus,
} from './earlyAccessModel';

interface SubmitEarlyAccessLeadRequest {
  email: string;
  /** Version of the consent wording shown next to the form (proof of consent for CASL/GDPR). */
  consentVersion?: string;
}

interface SubmitEarlyAccessLeadResponse {
  status: 'created' | 'exists';
}

interface EarlyAccessPreferenceRequest {
  id: string;
  token: string;
  action: 'confirm' | 'unsubscribe';
  /** Wording version of the confirm page; stored as consent for re-confirmed leads. */
  consentVersion?: string;
}

const SOURCE = 'website_welcome_video';

function leads() {
  return getFirestore().collection('early_access');
}

function formConsent(version: string) {
  return { version, purpose: LEAD_PURPOSE, method: 'signup_form', grantedAt: FieldValue.serverTimestamp() };
}

/**
 * Adds an email to the early-access list with proof of consent. Signing up again records fresh consent,
 * which also re-subscribes an address that unsubscribed or was collected before the consent notice.
 */
export const submitEarlyAccessLead = onCall(
  { cors: true },
  async (request: CallableRequest<SubmitEarlyAccessLeadRequest>): Promise<SubmitEarlyAccessLeadResponse> => {
    const email = normalizeLeadEmail(request.data?.email);
    if (!email || !isValidLeadEmail(email)) {
      throw new HttpsError('invalid-argument', 'A valid email is required.');
    }
    const consentVersion = request.data?.consentVersion;
    const consent = validConsentVersion(consentVersion) ? formConsent(consentVersion) : null;
    const leadRef = leads().doc(leadId(email));
    const legacyLeadRef = leads().doc(email);

    const status = await getFirestore().runTransaction(async (transaction) => {
      const [leadDoc, legacyLeadDoc] = await Promise.all([transaction.get(leadRef), transaction.get(legacyLeadRef)]);
      const fields = { email, emailLower: email, emailHash: leadRef.id };

      if (leadDoc.exists) {
        const data = leadDoc.data() ?? {};
        if (consent && (!data.consent || data.unsubscribedAt || !data.email)) {
          transaction.update(leadRef, {
            ...fields,
            consent,
            unsubscribedAt: FieldValue.delete(),
            unsubscribeToken: typeof data.unsubscribeToken === 'string' ? data.unsubscribeToken : newUnsubscribeToken(),
            resubscribedAt: FieldValue.serverTimestamp(),
          });
        }
        return 'exists' as const;
      }

      if (legacyLeadDoc.exists) {
        transaction.create(leadRef, {
          ...(legacyLeadDoc.data() ?? {}),
          ...fields,
          source: SOURCE,
          unsubscribeToken: newUnsubscribeToken(),
          migratedAt: FieldValue.serverTimestamp(),
          ...(consent ? { consent } : {}),
        });
        transaction.delete(legacyLeadRef);
        return 'exists' as const;
      }

      transaction.create(leadRef, {
        ...fields,
        source: SOURCE,
        createdAt: FieldValue.serverTimestamp(),
        unsubscribeToken: newUnsubscribeToken(),
        ...(consent ? { consent } : {}),
      });
      return 'created' as const;
    });

    return { status };
  },
);

/**
 * Links in every launch email (`/email-preferences`): "confirm" records consent from the email
 * (double opt-in / re-confirming leads collected before the notice); "unsubscribe" deletes the address
 * and keeps only the hash as a suppression record. Unknown ids and wrong tokens get the same answer.
 */
export const updateEarlyAccessPreference = onCall(
  { cors: true },
  async (request: CallableRequest<EarlyAccessPreferenceRequest>): Promise<{ status: PreferenceStatus }> => {
    const { id, token, action, consentVersion } = request.data ?? {};
    if (!validPreferenceRequest(id, token, action)) return { status: 'invalid' };
    const leadRef = leads().doc(id);

    const status = await getFirestore().runTransaction(async (transaction): Promise<PreferenceStatus> => {
      const doc = await transaction.get(leadRef);
      const data = doc.data();
      if (!data || !tokensMatch(data.unsubscribeToken, token)) return 'invalid';
      if (action === 'unsubscribe') {
        if (!data.unsubscribedAt) {
          transaction.set(leadRef, {
            emailHash: id,
            unsubscribeToken: token,
            unsubscribedAt: FieldValue.serverTimestamp(),
          });
        }
        return 'unsubscribed';
      }
      if (data.unsubscribedAt || typeof data.email !== 'string') return 'unsubscribed';
      transaction.update(leadRef, {
        confirmedAt: FieldValue.serverTimestamp(),
        ...(data.consent ? {} : {
          consent: {
            version: validConsentVersion(consentVersion) ? consentVersion : 'email_confirm',
            purpose: LEAD_PURPOSE,
            method: 'email_link',
            grantedAt: FieldValue.serverTimestamp(),
          },
        }),
      });
      return 'confirmed';
    });

    return { status };
  },
);
