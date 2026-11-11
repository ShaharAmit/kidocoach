import { Link } from 'react-router-dom';
import { openPrivacyChoices } from '../services/analytics';
import '../styles/legal.css';

export default function PrivacyPage() {
  return (
    <main className="legal-shell">
      <article className="legal-card">
        <Link to="/" className="back-link">
          Back to Home
        </Link>

        <h1>Privacy Policy</h1>
        <p className="meta">Kidocoach | Last updated: 11/11/2026</p>

        <p>
          This policy covers the Kidocoach app (iPhone, iPad and Android) and this website. Kidocoach,
          based in Israel, is responsible for your information (the &quot;controller&quot;). You can
          reach us at admin@kidocoach.app.
        </p>

        <section>
          <h2>1. What Information We Collect</h2>
          <p>
            We collect your email when you join the Early Access list or create a parent account.
            Parent sign-in is handled by Firebase Authentication. For subscriptions, we also process
            account identifiers, subscription status, and transaction records.
            Payment details are handled by Paddle, our merchant of record, not stored by this website.
          </p>
          <p>
            <strong>Your child&apos;s information.</strong> When you, the parent, set up Kidocoach in the app or
            on this website, you give us your child&apos;s first name, date of birth (or age), your
            questionnaire answers, wake-up and bedtime, and the activities in the routine. The app also
            records stars and completed routines. We keep this in your account and on your device only
            to build and personalize your child&apos;s routines; we never use it for advertising or
            share it with partners. To create the spoken greeting (for example &quot;Good morning,
            Liam&quot;), the first name is sent to Google&apos;s text-to-speech service. The resulting audio
            is stored and reused for any child with the same first name, and isn&apos;t linked to your
            account. Children don&apos;t create accounts or give us information themselves. Deleting your
            account (in the app&apos;s Profile screen, or by emailing us) permanently deletes this
            information.
          </p>
        </section>

        <section>
          <h2>2. How We Use Your Information</h2>
          <p>
            We use account and subscription information to provide access across your devices and
            help manage purchases. If you join the Early Access list, we use your email for launch updates
            and the launch-rate offer, based on your consent, and keep a record of when you agreed. You can
            unsubscribe at any time with the link in every email; we then delete your address and keep
            only a one-way code of it so it isn&apos;t added again by mistake.
            Coupon links save the promotion code you clicked in your browser for up to 30 days, so the
            discount can be applied at checkout. If you arrive through a partner (affiliate) link, we
            keep the partner code and link it to your account if you sign in during that visit, so the
            partner can be credited if you subscribe on the website. Only if you click &quot;Accept&quot;
            (see Analytics and Cookies) do we also save the partner code in your browser for up to
            60 days, so the partner is credited if you come back later; otherwise it is forgotten when you
            leave the page. Partners see only counts, sale amounts, dates and commission
            totals, never your name, email, or payment details. If you join the partner program, we keep
            your partner name, account email, payout method and email, daily link click counts, and commission and
            payout records to run the program and for accounting.
          </p>
        </section>

        <section>
          <h2>3. Data Sharing and Security</h2>
          <p>
            We do not sell, rent, or trade your email address to anyone. Period. Your data is stored
            securely using industry-standard infrastructure (Google Firebase and Google Cloud, which also
            generates the spoken greetings).
            Paddle processes web payments as merchant of record, RevenueCat manages subscription access
            across web, Apple, and Android.
          </p>
          <p>
            <strong>International transfers.</strong> Our servers and most of these providers are located in the
            United States (Paddle is in the United Kingdom), so your information is transferred to and stored there. For people in the
            EU/EEA, UK and Switzerland, these transfers rely on the EU-U.S. Data Privacy Framework (and its
            UK and Swiss extensions) where the provider is certified, and on the European Commission&apos;s
            Standard Contractual Clauses in our data processing terms with each provider. You can ask us
            for a copy of these safeguards at the address below.
          </p>
        </section>

        <section id="analytics">
          <h2>4. Analytics and Cookies</h2>
          <p>
            Only if you click &quot;Accept&quot;, we use Google Analytics for Firebase to understand how
            parents find and use this website: pages viewed, how you arrived (for example a partner,
            coupon or campaign link and the referring website&apos;s name), sign-up and sign-in method,
            progress through the setup questionnaire, and checkout steps. For the questionnaire we record
            only answer categories and an age range, never your child&apos;s name or birth date.
            When you are signed in, events are linked to your account&apos;s internal ID (never your
            email) so we can measure our sign-up and setup funnel. Google Analytics sets first-party
            cookies (names starting with _ga). Google processes this data for us as our service provider;
            we do not use it for advertising, we turn off Google signals and ad personalization, and we
            do not sell or share it for cross-context behavioral advertising. Analytics data is kept for
            up to 14 months in Google Analytics and up to 26 months in our analytics database.
          </p>
          <p>
            The same choice lets us remember a partner link in your browser for up to 60 days (see
            Information Usage). If you do nothing or click &quot;Reject&quot;, no analytics script is
            loaded, nothing is sent, and no partner code is saved on your device.
            We also treat a Global Privacy Control signal from your browser as a rejection. You can change
            your choice at any time:{' '}
            <button type="button" className="privacy-choices" onClick={openPrivacyChoices}>Privacy choices</button>.
          </p>
        </section>

        <section>
          <h2>5. Why We&apos;re Allowed to Use It (Legal Bases)</h2>
          <p>
            Your account, your child&apos;s profile and routines, the spoken greeting, subscriptions and the
            partner program are used to provide the service you asked for (performance of a contract).
            Analytics, saving a partner link on your device and Early Access emails rely on your consent,
            which you can withdraw at any time. We keep payment, commission and payout records because tax
            and accounting laws require it (legal obligation), and we use limited technical logs to keep the
            service secure and prevent abuse (legitimate interests). We don&apos;t make decisions about you
            based solely on automated processing that have legal or similarly significant effects. The
            routine suggestions built from your questionnaire answers are only a starting point you can change.
          </p>
        </section>

        <section>
          <h2>6. How Long We Keep It</h2>
          <p>
            Account, child profile, routine and parent lock information: until you delete your account.
            Spoken greetings: deleted after a year without use. Early Access email: until you unsubscribe
            (then only a one-way code of it). Analytics: up to 14 months in Google Analytics and up to 26
            months in our analytics database. Coupon codes saved in your browser: up to 30 days; partner
            codes saved in your browser: up to 60 days. Payment, commission and payout records: as long as
            tax and accounting laws require. Security logs and payment-notification records: up to 90 days.
          </p>
        </section>

        <section>
          <h2>7. For Kids</h2>
          <p>
            Hi! Kidocoach helps you with your morning and bedtime routines. Your grown-up told us your first
            name so the coach can say hello to you. We only use it for that. We don&apos;t show you ads, and
            we never sell your name. If you have a question, ask your
            grown-up to email us.
          </p>
        </section>

        <section>
          <h2>8. Your Rights</h2>
          <p>
            Depending on where you live (including the EU/EEA, UK, Canada, Australia and US states such as
            California), you can ask to access, correct, delete or receive a copy of your personal
            information, object to or restrict its use, and withdraw consent at any time. We will not
            treat you differently for using these rights. We do not sell your personal information. To use
            them, email us at the address below; you may also complain to your local data protection
            authority. You can opt-out of our communications at any time. Every email we send will
            include a clear &quot;Unsubscribe&quot; link at the bottom.
          </p>
        </section>

        <section>
          <h2>9. Contact Us</h2>
          <p>
            If you have any questions about this policy, you can reach us at admin@kidocoach.app.
          </p>
        </section>
      </article>
    </main>
  );
}
