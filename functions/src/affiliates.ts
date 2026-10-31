/**
 * In-house affiliate program on top of Paddle Billing (ADR-019). Partners share
 * `https://kidocoach.app/?ref={code}` (or their own Paddle coupon); the family's first-touch
 * attribution is stored server-side, checkout stamps the code into the Paddle transaction, and
 * the signed Paddle webhook turns paid transactions into held commissions that refunds and
 * chargebacks reverse. Every collection here is server-only (see firestore.rules).
 */
import {
  FieldValue, getFirestore, Timestamp, type DocumentData, type QueryDocumentSnapshot, type Transaction,
} from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall, onRequest, type CallableRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  applyAdjustment, claimRejection, clickDay, commissionIneligibility, DEFAULT_COMMISSION_RATE_BPS,
  DEFAULT_PAYOUT_METHOD, DEFAULT_RECURRING_MONTHS, isAttributionOpen, newCommission, normalizeAffiliateCode, normalizeCouponCode,
  normalizeEmail, normalizePartnerName, normalizePayoutMethod, parseAffiliate, parsePaddleAdjustment, parsePaddleTransaction,
  partnerConversions, selfServeCodeProblem, summarizeEarnings, verifyPaddleSignature,
  type Attribution, type AttributionSource, type ClaimRejection, type Commission, type PartnerLedgerEntry,
  type SelfServeCodeProblem,
} from './affiliateModel';

export const paddleWebhookSecret = defineSecret('PADDLE_WEBHOOK_SECRET');

const SITE_URL = 'https://kidocoach.app';
// `ntfsimevt_` = Paddle dashboard/API simulations, signed with the same destination secret.
const EVENT_ID = /^(evt|ntfsimevt)_[a-z0-9]{10,64}$/;
const EVENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const APPROVAL_BATCH = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ClaimStatus = 'claimed' | 'already_attributed' | ClaimRejection;
export type JoinStatus = 'created' | 'already_partner' | 'code_taken' | 'invalid_name' | 'invalid_payout_email' |
  'invalid_payout_method' | 'terms_required' | SelfServeCodeProblem;

const db = () => getFirestore();
const affiliateRef = (code: string) => db().collection('affiliates').doc(code);
const attributionRef = (uid: string) => db().collection('affiliate_attributions').doc(uid);
const commissionRef = (transactionId: string) => db().collection('affiliate_commissions').doc(transactionId);
// One partner account per sign-in, enforced inside the join transaction.
const ownerRef = (uid: string) => db().collection('affiliate_owners').doc(uid);

function millis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function parseAttribution(data: DocumentData | undefined): Attribution | null {
  const code = normalizeAffiliateCode(data?.code);
  const claimedAt = millis(data?.claimedAt);
  if (!code || claimedAt === null || (data?.source !== 'link' && data?.source !== 'coupon')) return null;
  return { code, source: data.source, claimedAt, firstPaidAt: millis(data.firstPaidAt) };
}

function commissionFromFirestore(transactionId: string, data: DocumentData | undefined): Commission | null {
  const billedAt = millis(data?.billedAt);
  const holdUntil = millis(data?.holdUntil);
  const code = normalizeAffiliateCode(data?.code);
  if (!data || !code || billedAt === null || holdUntil === null || typeof data.currency !== 'string') return null;
  const ints = ['netAmount', 'rateBps', 'amount', 'reversed', 'paidAmount'] as const;
  if (ints.some((key) => !Number.isInteger(data[key]))) return null;
  if (!['pending', 'approved', 'paid', 'void'].includes(data.status)) return null;
  return {
    code,
    uid: String(data.uid ?? ''),
    transactionId,
    subscriptionId: typeof data.subscriptionId === 'string' ? data.subscriptionId : null,
    currency: data.currency,
    netAmount: data.netAmount,
    rateBps: data.rateBps,
    amount: data.amount,
    reversed: data.reversed,
    paidAmount: data.paidAmount,
    adjustmentIds: Array.isArray(data.adjustmentIds) ? data.adjustmentIds.filter((id) => typeof id === 'string') : [],
    status: data.status,
    billedAt,
    holdUntil,
  };
}

function requireParent(request: CallableRequest): { uid: string; email: string | null } {
  if (!request.auth || request.auth.token.firebase?.sign_in_provider === 'anonymous') {
    throw new HttpsError('unauthenticated', 'Sign in to your parent account first.');
  }
  return { uid: request.auth.uid, email: normalizeEmail(request.auth.token.email) };
}

/**
 * First touch wins and is immutable: an existing attribution is never replaced. Families that
 * already bought on the web, partners' own accounts (UID or email) and inactive codes are refused.
 */
export async function claimAttribution(
  uid: string, email: string | null, code: string, source: AttributionSource,
): Promise<ClaimStatus> {
  return db().runTransaction(async (tx) => {
    const ref = attributionRef(uid);
    if ((await tx.get(ref)).exists) return 'already_attributed';
    const [affiliateSnap, customerSnap] = await Promise.all([
      tx.get(affiliateRef(code)),
      tx.get(db().collection('billing_customers').doc(uid)),
    ]);
    const affiliate = affiliateSnap.exists ? parseAffiliate(code, affiliateSnap.data()) : null;
    const rejection = claimRejection(affiliate, { uid, email, isExistingCustomer: customerSnap.exists });
    if (rejection) return rejection;
    tx.create(ref, { code, source, claimedAt: Timestamp.now(), firstPaidAt: null });
    return 'claimed';
  });
}

async function affiliateForCoupon(coupon: string): Promise<string | null> {
  const matches = await db().collection('affiliates').where('discountCode', '==', coupon).limit(2).get();
  // An ambiguous coupon attributes nobody rather than guessing.
  return matches.size === 1 ? matches.docs[0].id : null;
}

/**
 * The partner code to stamp into a new checkout's custom_data, from the server-side attribution
 * only. A referral link (or a partner coupon) seen at checkout is claimed first if the family has
 * none yet. Affiliate problems never block a purchase.
 */
export async function resolveCheckoutAffiliate(
  uid: string, email: string | null, referral: unknown, coupon: unknown,
): Promise<string | null> {
  try {
    let attribution = parseAttribution((await attributionRef(uid).get()).data());
    if (!attribution) {
      const linkCode = normalizeAffiliateCode(referral);
      let claimed = linkCode ? await claimAttribution(uid, email, linkCode, 'link') : null;
      const couponCode = normalizeCouponCode(coupon);
      if (claimed !== 'claimed' && claimed !== 'already_attributed' && couponCode) {
        const code = await affiliateForCoupon(couponCode);
        if (code) claimed = await claimAttribution(uid, email, code, 'coupon');
      }
      if (claimed !== 'claimed' && claimed !== 'already_attributed') return null;
      attribution = parseAttribution((await attributionRef(uid).get()).data());
    }
    if (!attribution || !isAttributionOpen(attribution, Date.now())) return null;
    const affiliate = parseAffiliate(attribution.code, (await affiliateRef(attribution.code).get()).data());
    return affiliate?.status === 'active' ? affiliate.code : null;
  } catch (error) {
    console.error('[Affiliates] Could not resolve checkout attribution:', error);
    return null;
  }
}

/** Called by the website after sign-in with the `?ref=` code it saved, so attribution follows the account. */
export const claimAffiliateReferral = onCall({ cors: true, timeoutSeconds: 15 }, async (request) => {
  const { uid, email } = requireParent(request);
  const code = normalizeAffiliateCode(request.data?.code);
  if (!code) return { status: 'invalid_code' satisfies ClaimStatus };
  try {
    return { status: await claimAttribution(uid, email, code, 'link') };
  } catch (error) {
    console.error('[Affiliates] Claim failed:', error);
    throw new HttpsError('unavailable', 'Could not save the referral. Please try again.');
  }
});

async function ownedAffiliate(uid: string): Promise<QueryDocumentSnapshot | null> {
  const owned = await db().collection('affiliates').where('ownerUid', '==', uid).limit(1).get();
  return owned.docs[0] ?? null;
}

/** Live availability check for the "choose your code" field (codes are public in links anyway). */
export const checkAffiliateCode = onCall({ cors: true, timeoutSeconds: 10 }, async (request) => {
  requireParent(request);
  const problem = selfServeCodeProblem(request.data?.code);
  if (problem) return { available: false, reason: problem };
  const code = normalizeAffiliateCode(request.data?.code) as string;
  const taken = (await affiliateRef(code).get()).exists;
  return taken ? { available: false, reason: 'code_taken' } : { available: true, code };
});

/**
 * Self-serve partner sign-up: the signed-in account picks its own link code and is approved
 * right away on the default terms. Payouts stay manual after the refund hold, and an admin can
 * pause any partner (`set-status disabled`).
 */
export const createAffiliateAccount = onCall({ cors: true, timeoutSeconds: 15 }, async (request) => {
  const { uid, email } = requireParent(request);
  if (!email) throw new HttpsError('failed-precondition', 'Your account needs an email address to join.');
  const problem = selfServeCodeProblem(request.data?.code);
  if (problem) return { status: problem satisfies JoinStatus };
  const code = normalizeAffiliateCode(request.data?.code) as string;
  const name = normalizePartnerName(request.data?.name);
  if (!name) return { status: 'invalid_name' satisfies JoinStatus };
  const rawPayout = request.data?.payoutEmail;
  const payoutEmail = rawPayout === undefined || rawPayout === '' ? email : normalizeEmail(rawPayout);
  if (!payoutEmail) return { status: 'invalid_payout_email' satisfies JoinStatus };
  const payoutMethod = request.data?.payoutMethod === undefined
    ? DEFAULT_PAYOUT_METHOD : normalizePayoutMethod(request.data.payoutMethod);
  if (!payoutMethod) return { status: 'invalid_payout_method' satisfies JoinStatus };
  if (request.data?.acceptTerms !== true) return { status: 'terms_required' satisfies JoinStatus };
  try {
    if (await ownedAffiliate(uid)) return { status: 'already_partner' satisfies JoinStatus };
    const status = await db().runTransaction(async (tx): Promise<JoinStatus> => {
      const [codeSnap, ownerSnap] = await Promise.all([tx.get(affiliateRef(code)), tx.get(ownerRef(uid))]);
      if (ownerSnap.exists) return 'already_partner';
      if (codeSnap.exists) return 'code_taken';
      const now = Timestamp.now();
      tx.create(affiliateRef(code), {
        name,
        email,
        status: 'active',
        commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
        recurringMonths: DEFAULT_RECURRING_MONTHS,
        ownerUid: uid,
        discountCode: null,
        payoutEmail,
        payoutMethod,
        source: 'self_serve',
        termsAcceptedAt: now,
        createdAt: now,
      });
      tx.create(ownerRef(uid), { code, createdAt: now });
      return 'created';
    });
    return status === 'created' ? { status, code } : { status };
  } catch (error) {
    console.error('[Affiliates] Join failed:', error);
    throw new HttpsError('unavailable', 'Could not create your partner account. Please try again.');
  }
});

/** The partner edits their own display name and payout details; rates and status stay admin-only. */
export const updateAffiliateSettings = onCall({ cors: true, timeoutSeconds: 15 }, async (request) => {
  const { uid } = requireParent(request);
  const changes: Record<string, unknown> = {};
  if (request.data?.name !== undefined) {
    changes.name = normalizePartnerName(request.data.name);
    if (!changes.name) throw new HttpsError('invalid-argument', 'Use 2-60 characters for your name.');
  }
  if (request.data?.payoutEmail !== undefined) {
    changes.payoutEmail = normalizeEmail(request.data.payoutEmail);
    if (!changes.payoutEmail) throw new HttpsError('invalid-argument', 'Enter a valid payout email.');
  }
  if (request.data?.payoutMethod !== undefined) {
    changes.payoutMethod = normalizePayoutMethod(request.data.payoutMethod);
    if (!changes.payoutMethod) throw new HttpsError('invalid-argument', 'Choose PayPal or Wise.');
  }
  if (!Object.keys(changes).length) throw new HttpsError('invalid-argument', 'Nothing to update.');
  const doc = await ownedAffiliate(uid);
  if (!doc) throw new HttpsError('permission-denied', 'This account is not a partner.');
  await doc.ref.update({ ...changes, updatedAt: Timestamp.now() });
  return { updated: Object.keys(changes) };
});

/**
 * Counts a partner link visit (the website sends one per browser, code and day). Visitors aren't
 * signed in, so this only ever increments a per-day counter of an active partner.
 */
export const trackAffiliateClick = onCall({ cors: true, timeoutSeconds: 10, maxInstances: 5 }, async (request) => {
  const code = normalizeAffiliateCode(request.data?.code);
  if (!code) return { counted: false };
  try {
    const affiliate = parseAffiliate(code, (await affiliateRef(code).get()).data());
    if (affiliate?.status !== 'active') return { counted: false };
    const day = clickDay(Date.now());
    await db().collection('affiliate_clicks').doc(`${code}_${day}`)
      .set({ code, day, clicks: FieldValue.increment(1), updatedAt: Timestamp.now() }, { merge: true });
    return { counted: true };
  } catch (error) {
    console.warn('[Affiliates] Click not counted:', error);
    return { counted: false };
  }
});

/** Partner dashboard data for the signed-in account that owns an affiliate code (no family PII). */
export const getAffiliateSummary = onCall({ cors: true, timeoutSeconds: 30 }, async (request) => {
  const { uid } = requireParent(request);
  try {
    const doc = await ownedAffiliate(uid);
    const affiliate = doc ? parseAffiliate(doc.id, doc.data()) : null;
    if (!doc || !affiliate) return { affiliate: null };
    const [signups, commissionDocs, clickDocs, payoutDocs] = await Promise.all([
      db().collection('affiliate_attributions').where('code', '==', affiliate.code).count().get(),
      db().collection('affiliate_commissions').where('code', '==', affiliate.code).get(),
      db().collection('affiliate_clicks').where('code', '==', affiliate.code).get(),
      db().collection('affiliate_payouts').where('code', '==', affiliate.code).get(),
    ]);
    const ledger = commissionDocs.docs
      .map((snap): PartnerLedgerEntry | null => {
        const commission = commissionFromFirestore(snap.id, snap.data());
        return commission && { ...commission, origin: snap.data().origin };
      })
      .filter((entry): entry is PartnerLedgerEntry => entry !== null);
    const recentFrom = clickDay(Date.now() - 29 * DAY_MS);
    let clicks = 0;
    let clicksLast30Days = 0;
    for (const snap of clickDocs.docs) {
      const count = Number.isInteger(snap.data().clicks) ? snap.data().clicks as number : 0;
      clicks += count;
      if (String(snap.data().day) >= recentFrom) clicksLast30Days += count;
    }
    const payouts = payoutDocs.docs
      .map((snap) => ({
        paidAt: millis(snap.data().paidAt),
        currency: String(snap.data().currency ?? ''),
        amount: Number(snap.data().amount ?? 0),
        commissions: Number(snap.data().commissions ?? 0),
      }))
      .filter((payout) => payout.paidAt !== null && Number.isInteger(payout.amount))
      .sort((a, b) => (b.paidAt as number) - (a.paidAt as number));
    return {
      affiliate: {
        code: affiliate.code,
        name: affiliate.name,
        status: affiliate.status,
        link: `${SITE_URL}/?ref=${affiliate.code}`,
        discountCode: affiliate.discountCode,
        payoutEmail: normalizeEmail(doc.data().payoutEmail) ?? affiliate.email,
        payoutMethod: normalizePayoutMethod(doc.data().payoutMethod) ?? DEFAULT_PAYOUT_METHOD,
        commissionRateBps: affiliate.commissionRateBps,
        recurringMonths: affiliate.recurringMonths,
        clicks,
        clicksLast30Days,
        signups: signups.data().count,
        payingFamilies: new Set(ledger.filter((c) => c.status !== 'void').map((c) => c.uid)).size,
        earnings: summarizeEarnings(ledger),
        conversions: partnerConversions(ledger),
        payouts,
      },
    };
  } catch (error) {
    console.error('[Affiliates] Summary failed:', error);
    throw new HttpsError('unavailable', 'Could not load your partner summary. Please try again.');
  }
});

async function recordCommission(tx: Transaction, data: unknown): Promise<string> {
  const txn = parsePaddleTransaction(data);
  if (!txn) return 'ignored:not_family';
  if (!txn.affiliateCode) return 'ignored:no_affiliate';
  const [attributionSnap, commissionSnap] = await Promise.all([
    tx.get(attributionRef(txn.uid)),
    tx.get(commissionRef(txn.id)),
  ]);
  if (commissionSnap.exists) return 'ignored:already_recorded';
  const attribution = parseAttribution(attributionSnap.data());
  const affiliate = attribution
    ? parseAffiliate(attribution.code, (await tx.get(affiliateRef(attribution.code))).data())
    : null;
  const reason = commissionIneligibility(attribution, affiliate, txn);
  if (reason || !affiliate || !attribution) return `ignored:${reason}`;
  const commission = newCommission(affiliate, txn);
  const now = Timestamp.now();
  tx.create(commissionRef(txn.id), {
    ...commission,
    billedAt: Timestamp.fromMillis(commission.billedAt),
    holdUntil: Timestamp.fromMillis(commission.holdUntil),
    origin: txn.origin,
    createdAt: now,
    updatedAt: now,
  });
  if (attribution.firstPaidAt === null) {
    tx.update(attributionRef(txn.uid), { firstPaidAt: Timestamp.fromMillis(txn.billedAt) });
  }
  return 'commission_created';
}

async function recordAdjustment(tx: Transaction, data: unknown): Promise<string> {
  const adjustment = parsePaddleAdjustment(data);
  if (!adjustment) return 'ignored:adjustment';
  const ref = commissionRef(adjustment.transactionId);
  const snap = await tx.get(ref);
  if (!snap.exists) return 'ignored:no_commission';
  const commission = commissionFromFirestore(snap.id, snap.data());
  if (!commission) return 'ignored:malformed_commission';
  const next = applyAdjustment(commission, adjustment, Date.now());
  if (!next) return 'ignored:no_change';
  tx.update(ref, {
    reversed: next.reversed,
    status: next.status,
    adjustmentIds: next.adjustmentIds,
    updatedAt: Timestamp.now(),
  });
  return `commission_${adjustment.action}`;
}

/** Idempotent per Paddle `event_id`: the dedupe marker commits atomically with its effects. */
export async function handlePaddleEvent(eventId: string, type: unknown, data: unknown): Promise<string> {
  return db().runTransaction(async (tx) => {
    const eventRef = db().collection('paddle_events').doc(eventId);
    if ((await tx.get(eventRef)).exists) return 'duplicate';
    let outcome = 'ignored:event_type';
    if (type === 'transaction.completed') outcome = await recordCommission(tx, data);
    else if (type === 'adjustment.created' || type === 'adjustment.updated') outcome = await recordAdjustment(tx, data);
    tx.create(eventRef, {
      type: typeof type === 'string' ? type : 'unknown',
      outcome,
      receivedAt: Timestamp.now(),
      expireAt: Timestamp.fromMillis(Date.now() + EVENT_TTL_MS),
    });
    return outcome;
  });
}

/**
 * Paddle notification destination (transaction.completed, adjustment.created, adjustment.updated).
 * Unsigned or stale requests get 401; processing errors return 500 so Paddle retries.
 */
export const paddleWebhook = onRequest(
  { secrets: [paddleWebhookSecret], memory: '256MiB', timeoutSeconds: 30, maxInstances: 5 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed');
      return;
    }
    if (!verifyPaddleSignature(req.get('paddle-signature'), req.rawBody, paddleWebhookSecret.value())) {
      res.status(401).send('Invalid signature');
      return;
    }
    let event: { event_id?: unknown; event_type?: unknown; data?: unknown };
    try {
      event = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      res.status(400).send('Invalid JSON');
      return;
    }
    if (typeof event.event_id !== 'string' || !EVENT_ID.test(event.event_id)) {
      res.status(400).send('Missing event_id');
      return;
    }
    try {
      const outcome = await handlePaddleEvent(event.event_id, event.event_type, event.data);
      console.info(`[Affiliates] ${event.event_type} ${event.event_id}: ${outcome}`);
      res.status(200).json({ received: true });
    } catch (error) {
      console.error(`[Affiliates] Failed to process ${event.event_id}:`, error);
      res.status(500).send('Processing failed');
    }
  },
);

/**
 * Daily: pending commissions past their refund hold become payable. Each update is conditional on
 * the document being unchanged since it was read, so a refund landing concurrently is never overwritten.
 */
export async function approveDueCommissions(now = Timestamp.now()): Promise<number> {
  const due = await db().collection('affiliate_commissions')
    .where('status', '==', 'pending').where('holdUntil', '<=', now).limit(APPROVAL_BATCH).get();
  const results = await Promise.allSettled(due.docs.map((doc) =>
    doc.ref.update({ status: 'approved', approvedAt: now, updatedAt: now }, { lastUpdateTime: doc.updateTime })));
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length) console.warn(`[Affiliates] ${failed.length} commission approvals deferred (changed concurrently).`);
  return results.length - failed.length;
}

export const approveAffiliateCommissions = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'UTC', memory: '256MiB', timeoutSeconds: 120 },
  async () => {
    const approved = await approveDueCommissions();
    console.info(`[Affiliates] Approved ${approved} commissions.`);
  },
);

/**
 * Account deletion: drop the family's attribution and pause any partner account it owns (the
 * code is never reused). Commission and payout records stay for partner accounting.
 */
export async function deleteAffiliateAttribution(uid: string): Promise<void> {
  await attributionRef(uid).delete();
  const owned = await ownedAffiliate(uid);
  if (owned) await owned.ref.update({ status: 'disabled', ownerUid: null, updatedAt: Timestamp.now() });
  await ownerRef(uid).delete();
}
