import { Link } from 'react-router-dom';
import '../styles/legal.css';

export default function TermsPage() {
  return (
    <main className="legal-shell">
      <article className="legal-card">
        <Link to="/" className="back-link">
          Back to Home
        </Link>

        <h1>Terms and Conditions</h1>
        <p className="meta">Kidocoach | Last updated: 25/10/2026</p>

        <p>
          Welcome to Kidocoach! These terms cover our website, Early Access waitlist, and web subscriptions.
        </p>

        <section>
          <h2>1. The Service</h2>
          <p>
            Kidocoach is currently in active development. By providing your email address, you are joining a
            waitlist to receive updates and early access opportunities. This waitlist does not guarantee
            immediate access to the final app, nor does it lock in specific features.
          </p>
        </section>

        <section>
          <h2>2. Communication</h2>
          <p>
            By submitting your email, you agree to receive promotional and informational emails from
            Kidocoach regarding our upcoming launch. You can withdraw this consent at any time by clicking
            &quot;Unsubscribe&quot; in our emails.
          </p>
        </section>

        <section>
          <h2>3. App Features and Pricing</h2>
          <p>
            Preview features and unreleased designs may change before release. For a paid subscription,
            the price and renewal terms disclosed at checkout apply.
          </p>
        </section>

        <section>
          <h2>Subscriptions and Promotions</h2>
          <p>
            Web subscriptions are purchased by a parent or guardian. Our order process is conducted by our
            online reseller Paddle.com, which is the merchant of record for web orders and handles customer
            service inquiries and returns for them. The checkout displays the price,
            billing interval, applicable taxes, trial or discount terms, and renewal terms before payment.
            Recurring subscriptions renew until cancelled. Manage or cancel web subscriptions through the Paddle
            customer portal linked from your profile page; Apple and Google purchases are managed through their stores.
            Refund requests are subject to the applicable provider rules and your statutory rights.
          </p>
          <p>
            Subscription access follows your parent account, not your device. Use the same sign-in
            method on web and mobile. Web coupon codes apply only to eligible web purchases.
            Discount eligibility and duration are shown at checkout; a discount may replace a trial
            or introductory offer. Affiliate links do not guarantee a discount.
          </p>
        </section>

        <section id="partners">
          <h2>Partner Program</h2>
          <p>
            Anyone 18 or older may join the partner program at kidocoach.app/partners with their own account.
            Partners earn the commission shown on their dashboard (currently 15% of the price paid before tax,
            after discounts) on web subscriptions bought on kidocoach.app by families who first arrived through
            their link, for up to 12 months after that family&apos;s first payment. A family is credited to the
            first partner link it used within 60 days. App Store and Google Play purchases are not eligible.
          </p>
          <p>
            Commissions are held for 30 days, and refunds or chargebacks reverse them (including after payout,
            deducted from the next payout). Approved commissions are paid monthly by the payout method (Wise or PayPal) and to the payout
            email chosen on the dashboard; the partner is responsible for claiming the payment, keeping these
            details current, and any fees or taxes on their side. Self-referrals, buying through your own link, spam, misleading claims, paid search ads on
            the Kidocoach name, and impersonating Kidocoach are not allowed. We may pause a partner account and
            withhold unpaid commissions for violations, and we may change these terms for future sales with notice.
          </p>
        </section>

        <section>
          <h2>4. Disclaimer of Warranties</h2>
          <p>
            Because the app is still in development, the Early Access waitlist is provided &quot;as is.&quot; We are
            working hard to build a great experience, but we cannot guarantee specific launch dates.
          </p>
        </section>
      </article>
    </main>
  );
}
