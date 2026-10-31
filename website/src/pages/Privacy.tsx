import { Link } from 'react-router-dom';
import '../styles/legal.css';

export default function PrivacyPage() {
  return (
    <main className="legal-shell">
      <article className="legal-card">
        <Link to="/" className="back-link">
          Back to Home
        </Link>

        <h1>Privacy Policy</h1>
        <p className="meta">Kidocoach | Last updated: 25/10/2026</p>

        <section>
          <h2>1. What Information We Collect</h2>
          <p>
            We collect your email when you join the Early Access list or create a parent account.
            Parent sign-in is handled by Firebase Authentication. For subscriptions, we also process
            account identifiers, subscription status, and transaction records.
            Payment details are handled by Paddle, our merchant of record, not stored by this website.
          </p>
        </section>

        <section>
          <h2>2. How We Use Your Information</h2>
          <p>
            We use account and subscription information to provide access across your devices and
            help manage purchases. If you join the Early Access list, we use your email for launch updates.
            Coupon links may save a promotion code in your browser for up to 30 days. If you arrive
            through a partner (affiliate) link, we save the partner code in your browser for up to
            60 days and link it to your account when you sign in, so the partner can be credited if
            you subscribe on the website. Partners see only counts, sale amounts, dates and commission
            totals, never your name, email, or payment details. If you join the partner program, we keep
            your partner name, account email, payout method and email, daily link click counts, and commission and
            payout records to run the program and for accounting.
          </p>
        </section>

        <section>
          <h2>3. Data Sharing and Security</h2>
          <p>
            We do not sell, rent, or trade your email address to anyone. Period. Your data is stored
            securely using industry-standard infrastructure (Google Firebase).
            Paddle processes web payments as merchant of record, RevenueCat manages subscription access
            across web, Apple, and Android.
          </p>
        </section>

        <section>
          <h2>4. Your Rights</h2>
          <p>
            You can opt-out of our communications at any time. Every email we send will include a clear
            &quot;Unsubscribe&quot; link at the bottom. If you want us to completely delete your email from our
            database before launch, simply reply to any of our emails and ask, and we will remove it
            immediately.
          </p>
        </section>

        <section>
          <h2>5. Contact Us</h2>
          <p>
            If you have any questions about this policy, you can reach us at tipyourtone@gmail.com.
          </p>
        </section>
      </article>
    </main>
  );
}
