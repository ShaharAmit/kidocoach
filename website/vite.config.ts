import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const SITE_URL = 'https://kidocoach.app';
const INDEXED_ROUTES = [
  '/',
  '/morning-routine-for-kids',
  '/bedtime-routine-for-kids',
  '/visual-routine-schedule-for-kids',
  '/terms',
  '/privacy',
];

type PrerenderedRoute = {
  path: string;
  fileName: string;
  title: string;
  description: string;
  bodyHtml: string;
};

const PRERENDERED_ROUTES: PrerenderedRoute[] = [
  {
    path: '/terms',
    fileName: 'terms/index.html',
    title: 'Terms and Conditions | Kidocoach',
    description:
      'Read the Terms and Conditions for Kidocoach, covering our daily routine app for kids, website, Early Access waitlist, and family subscriptions.',
    bodyHtml: `
      <main class="legal-shell" style="max-width: 920px; margin: 0 auto; padding: 44px 16px; color: #173d4b; font-family: Nunito, Avenir Next, sans-serif;">
        <article class="legal-card">
          <a href="/" class="back-link">Back to Home</a>
          <h1>Terms and Conditions</h1>
          <p class="meta">Kidocoach | Last updated: 25/10/2026</p>
          <p>Welcome to Kidocoach! These terms cover our website, Early Access waitlist, and web subscriptions.</p>
          <section>
            <h2>1. The Service</h2>
            <p>Kidocoach is currently in active development. By providing your email address, you are joining a waitlist to receive updates and early access opportunities. This waitlist does not guarantee immediate access to the final app, nor does it lock in specific features.</p>
          </section>
          <section>
            <h2>2. Communication</h2>
            <p>By submitting your email, you agree to receive promotional and informational emails from Kidocoach regarding our upcoming launch. You can withdraw this consent at any time by clicking "Unsubscribe" in our emails.</p>
          </section>
          <section>
            <h2>3. App Features and Pricing</h2>
            <p>Preview features and unreleased designs may change before release. For a paid subscription, the price and renewal terms disclosed at checkout apply.</p>
          </section>
          <section>
            <h2>Subscriptions and Promotions</h2>
            <p>Web subscriptions are purchased by a parent or guardian. Our order process is conducted by our online reseller Paddle.com, which is the merchant of record for web orders and handles customer service inquiries and returns for them. The checkout displays the price, billing interval, applicable taxes, trial or discount terms, and renewal terms before payment. Recurring subscriptions renew until cancelled. Manage or cancel web subscriptions through the Paddle customer portal linked from your profile page; Apple and Google purchases are managed through their stores. Refund requests are subject to the applicable provider rules and your statutory rights.</p>
            <p>Subscription access follows your parent account, not your device. Use the same sign-in method on web and mobile. Web coupon codes apply only to eligible web purchases. Discount eligibility and duration are shown at checkout; a discount may replace a trial or introductory offer. Affiliate links do not guarantee a discount.</p>
          </section>
          <section>
            <h2>4. Disclaimer of Warranties</h2>
            <p>Because the app is still in development, the Early Access waitlist is provided "as is." We are working hard to build a great experience, but we cannot guarantee specific launch dates.</p>
          </section>
        </article>
      </main>`,
  },
  {
    path: '/privacy',
    fileName: 'privacy/index.html',
    title: 'Privacy Policy | Kidocoach',
    description:
      'Read the Kidocoach Privacy Policy to learn how we protect parent and family data, handle subscriptions, and respect your privacy choices.',
    bodyHtml: `
      <main class="legal-shell" style="max-width: 920px; margin: 0 auto; padding: 44px 16px; color: #173d4b; font-family: Nunito, Avenir Next, sans-serif;">
        <article class="legal-card">
          <a href="/" class="back-link">Back to Home</a>
          <h1>Privacy Policy</h1>
          <p class="meta">Kidocoach | Last updated: 01/11/2026</p>
          <section>
            <h2>1. What Information We Collect</h2>
            <p>We collect your email when you join the Early Access list or create a parent account. Parent sign-in is handled by Firebase Authentication. For subscriptions, we also process account identifiers, subscription status, and transaction records. Payment details are handled by Paddle, our merchant of record, not stored by this website.</p>
          </section>
          <section>
            <h2>2. How We Use Your Information</h2>
            <p>We use account and subscription information to provide access across your devices and help manage purchases. If you join the Early Access list, we use your email for launch updates and the launch-rate offer, based on your consent, and keep a record of when you agreed. You can unsubscribe at any time with the link in every email; we then delete your address and keep only a one-way code of it so it isn't added again by mistake.</p>
          </section>
          <section>
            <h2>3. Data Sharing and Security</h2>
            <p>We do not sell, rent, or trade your email address to anyone. Period. Your data is stored securely using industry-standard infrastructure (Google Firebase). Paddle processes web payments as merchant of record, RevenueCat manages subscription access across web, Apple, and Android.</p>
          </section>
          <section id="analytics">
            <h2>4. Analytics and Cookies</h2>
            <p>Only if you click "Accept", we use Google Analytics for Firebase to understand how parents find and use this website. If you do nothing or click "Reject", no analytics script is loaded, nothing is sent, and no partner code is saved on your device. We also treat a Global Privacy Control signal from your browser as a rejection.</p>
          </section>
          <section>
            <h2>5. Your Rights</h2>
            <p>Depending on where you live (including the EU/EEA, UK, Canada, Australia and US states such as California), you can ask to access, correct, delete or receive a copy of your personal information, object to or restrict its use, and withdraw consent at any time. We do not sell your personal information.</p>
          </section>
          <section>
            <h2>6. Contact Us</h2>
            <p>If you have any questions about this policy, you can reach us at admin@kidocoach.app.</p>
          </section>
        </article>
      </main>`,
  },
  {
    path: '/morning-routine-for-kids',
    fileName: 'morning-routine-for-kids/index.html',
    title: 'Morning Routine App for Kids (Ages 2–12) | Kidocoach',
    description:
      'End morning battles before school with Kidocoach—a playful daily routine app for kids with an animated coach that calls your child by name.',
    bodyHtml: `
      <main style="max-width: 960px; margin: 0 auto; padding: 72px 24px 48px; color: #173d4b; font-family: Nunito, Avenir Next, sans-serif;">
        <p style="font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; color: #175b73;">Morning Routine App for Kids (Ages 2–12)</p>
        <h1>End Morning Battles Before School—Without Nagging</h1>
        <p>KidoCoach turns chaotic mornings into a playful step-by-step mission led by an animated routine coach that speaks your child's name.</p>
        <h2>How the Morning Routine Flow Works</h2>
        <ol>
          <li><strong>Wake Up &amp; Wash Face:</strong> The animated coach greets your child by name right at wake-up time so getting out of bed feels like starting a game.</li>
          <li><strong>Brush Teeth &amp; Get Dressed:</strong> Each hygiene and dressing step has its own focused visual loop and timer so kids finish one task before worrying about the next.</li>
          <li><strong>Eat Breakfast &amp; Pack Backpack:</strong> Kids tap the giant "Mission Complete" button after every step, earning stars and heading out the door calm and on time.</li>
        </ol>
        <p><a href="https://kidocoach.app/profile">Set up your child's morning routine</a> or <a href="https://kidocoach.app/">return to KidoCoach home</a>.</p>
      </main>`,
  },
  {
    path: '/bedtime-routine-for-kids',
    fileName: 'bedtime-routine-for-kids/index.html',
    title: 'Bedtime Routine App for Kids & Calm Evenings | Kidocoach',
    description:
      'Build smoother bedtime routines for kids ages 2–12 with calm voice prompts, step-by-step visual activities, and story-time wind-downs.',
    bodyHtml: `
      <main style="max-width: 960px; margin: 0 auto; padding: 72px 24px 48px; color: #173d4b; font-family: Nunito, Avenir Next, sans-serif;">
        <p style="font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; color: #175b73;">Bedtime Routine App for Kids (Ages 2–12)</p>
        <h1>Smoother Bedtime Routines &amp; Calm Evening Wind-Downs</h1>
        <p>Help tired kids transition from playtime to pajamas, brushing teeth, story time, and sleep with a calm, encouraging routine coach.</p>
        <h2>Replace Evening Stall Tactics With a Predictable Flow</h2>
        <ol>
          <li><strong>Tidy Toys &amp; Put On Pajamas:</strong> Warm, calm voice prompts call your child by name to wrap up playtime and transform into cozy pajamas.</li>
          <li><strong>Evening Brush Teeth:</strong> A dedicated 60-second visual brushing step keeps kids focused at the sink without parent reminders.</li>
          <li><strong>Bedtime Story &amp; Sweet Dreams:</strong> The routine finishes with cozy story time and a peaceful goodnight milestone at your target bedtime.</li>
        </ol>
        <p><a href="https://kidocoach.app/profile">Set up your child's bedtime routine</a> or <a href="https://kidocoach.app/">return to KidoCoach home</a>.</p>
      </main>`,
  },
  {
    path: '/visual-routine-schedule-for-kids',
    fileName: 'visual-routine-schedule-for-kids/index.html',
    title: 'Visual Routine Schedule & Step-by-Step Timer for Kids | Kidocoach',
    description:
      'Help easily distracted and visual-learning kids stay on track with one clear step at a time, personalized voice cues, and Mission Complete rewards.',
    bodyHtml: `
      <main style="max-width: 960px; margin: 0 auto; padding: 72px 24px 48px; color: #173d4b; font-family: Nunito, Avenir Next, sans-serif;">
        <p style="font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; color: #175b73;">Visual Routine Schedule &amp; Step-by-Step Timer for Kids</p>
        <h1>One Clear Step at a Time for Visual &amp; Easily Distracted Kids</h1>
        <p>Long chore lists overwhelm young brains. KidoCoach combines a single-task visual avatar, personalized voice cues, and gentle timers to make daily transitions easier.</p>
        <h2>Designed Around How Kids Actually Focus</h2>
        <ul>
          <li><strong>Single-Task Visual Focus:</strong> Full-screen animated avatar loops show one activity at a time so kids never feel overwhelmed by a long checklist.</li>
          <li><strong>Name-Personalized Audio Cues:</strong> Hearing their own name spoken by the routine coach gently brings wandering attention back to the current step.</li>
          <li><strong>Immediate Positive Feedback:</strong> Tapping the giant "Mission Complete" button gives instant visual celebration and star rewards.</li>
        </ul>
        <p><em>Note: KidoCoach is an educational family habit-building tool, not a medical or clinical device.</em></p>
        <p><a href="https://kidocoach.app/profile">Set up your child's visual routine</a> or <a href="https://kidocoach.app/">return to KidoCoach home</a>.</p>
      </main>`,
  },
];

const LLMS_TXT = `# KidoCoach (kidocoach.app)

> KidoCoach is a daily routine app for kids (ages 2–12) that helps families build calmer mornings, smoother bedtime routines, and independent daily habits using an animated routine coach and personalized voice prompts that speak the child's name.

## Product Overview
- **Product Name:** KidoCoach (Kidocoach)
- **Category:** Kids Daily Routine App / Parenting & Family Habit Tracker (LifestyleApplication)
- **Target Audience:** Parents and families with children ages 2 to 12 (including visual learners and kids who get easily distracted during daily transitions)
- **Platforms:** iOS (iPhone, iPad), Android, and Web account & routine setup at https://kidocoach.app/profile
- **Website:** https://kidocoach.app/
- **Support Contact:** admin@kidocoach.app
- **Disclaimer:** KidoCoach is a consumer family habit-building and educational routine app, not a medical or clinical device.

## How KidoCoach Works
1. **7-Step Parent Setup (2 Minutes):** Parents configure their child's name, age (2–12), wake-up and bedtime schedule, morning stuck points (getting out of bed, getting dressed, brushing teeth, putting screens away), motivation style, and independence level.
2. **Guided Animated Avatar Coach:** At routine time, a friendly animated avatar calls the child by their actual name using personalized voice audio and demonstrates the current activity step.
3. **One Task at a Time & Mission Complete:** Instead of overwhelming kids with a long checklist, KidoCoach shows one timed visual activity at a time. Children tap the giant "Mission Complete" button to advance and earn stars.
4. **Offline-First Playback:** The mobile app pre-downloads routine video loops and personalized voice tracks to the device so routines start reliably even without Wi-Fi.
5. **Cross-Platform Family Access:** One parent account and subscription unlocks KidoCoach across iOS, Android, and Web.

## Key Pages
- [Home — Daily Routine App for Kids](https://kidocoach.app/): Product overview, welcome coach video, interactive routine preview, features, and FAQ.
- [Morning Routine App for Kids](https://kidocoach.app/morning-routine-for-kids): Step-by-step morning routine guide (wake up, wash face, brush teeth, get dressed, eat breakfast, pack backpack).
- [Bedtime Routine App for Kids](https://kidocoach.app/bedtime-routine-for-kids): Calm evening routine flow (tidy toys, pajamas, brush teeth, bedtime story, sleep).
- [Visual Routine Schedule for Kids](https://kidocoach.app/visual-routine-schedule-for-kids): How single-task visual timers and personalized voice prompts help visual learners and easily distracted children.
- [Parent Profile & Routine Setup](https://kidocoach.app/profile): Create a parent account, run the 7-step child routine setup, and manage subscriptions.
- [Terms and Conditions](https://kidocoach.app/terms): Service terms, Early Access waitlist terms, and subscription policies.
- [Privacy Policy](https://kidocoach.app/privacy): Family data privacy, Firebase & Paddle security, and cookie/analytics consent details.
- [Full AI Context (llms-full.txt)](https://kidocoach.app/llms-full.txt): Extended product, FAQ, and policy documentation for AI agents.
`;

const LLMS_FULL_TXT = `${LLMS_TXT}
## Frequently Asked Questions (FAQ)

### What is KidoCoach and how does it help with kids' routines?
KidoCoach is a daily routine app for kids (ages 2–12) that replaces parent nagging with a playful animated routine coach. It guides children through sequential morning and bedtime habits—like getting out of bed, getting dressed, brushing teeth, eating breakfast, and putting toys away—using visual avatar loops, personalized voice audio that says your child's name, and a rewarding "Mission Complete" flow.

### What age group is KidoCoach designed for?
KidoCoach is tailored for children ages 2 to 12. During the 7-step setup, the routine adapts to your child's age, natural morning pace (fast and energetic, slow and dreamy, or easily distracted), and how much independence or step-by-step support they need.

### How does KidoCoach help kids who get easily distracted or overwhelmed?
Instead of overwhelming kids with a long checklist, KidoCoach presents one visual, timed activity at a time with encouraging voice cues and immediate positive feedback, making transitions easier for slow, dreamy, or easily distracted mornings. KidoCoach is an educational habit-building tool for families, not a medical or clinical device.

### Which platforms does KidoCoach support?
KidoCoach is available for iOS (iPhone and iPad) and Android, with full web account setup and subscription management at https://kidocoach.app/profile. One parent subscription unlocks the app across all of your family's devices.

### How is family privacy handled?
KidoCoach does not sell, rent, or trade parent email addresses or family data. Analytics are strictly opt-in (and respect Global Privacy Control signals), and analytics never record a child's name, birth date, or gender. Web payments are processed securely by Paddle as merchant of record.
`;

function buildRouteHtml(baseHtml: string, route: PrerenderedRoute): string {
  const canonicalUrl = `${SITE_URL}${route.path}`;
  return baseHtml
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${route.title}</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
      `<meta name="description" content="${route.description}" />`
    )
    .replace(
      /<link\s+rel="canonical"\s+href="[^"]*"\s*\/>/,
      `<link rel="canonical" href="${canonicalUrl}" />`
    )
    .replace(
      /<meta\s+property="og:title"\s+content="[^"]*"\s*\/>/,
      `<meta property="og:title" content="${route.title}" />`
    )
    .replace(
      /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>/,
      `<meta property="og:description" content="${route.description}" />`
    )
    .replace(
      /<meta\s+property="og:url"\s+content="[^"]*"\s*\/>/,
      `<meta property="og:url" content="${canonicalUrl}" />`
    )
    .replace(
      /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/>/,
      `<meta name="twitter:title" content="${route.title}" />`
    )
    .replace(
      /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/>/,
      `<meta name="twitter:description" content="${route.description}" />`
    )
    .replace(
      /<div id="root">[\s\S]*?<\/div>/,
      `<div id="root">${route.bodyHtml}\n    </div>`
    );
}

function createSeoFilesPlugin(): Plugin {
  return {
    name: 'create-seo-files',
    apply: 'build' as const,
    generateBundle() {
      const now = new Date().toISOString();
      const urls = INDEXED_ROUTES.map((route) => {
        const loc = route === '/' ? `${SITE_URL}/` : `${SITE_URL}${route}`;
        return [
          '  <url>',
          `    <loc>${loc}</loc>`,
          `    <lastmod>${now}</lastmod>`,
          '    <changefreq>weekly</changefreq>',
          route === '/' ? '    <priority>1.0</priority>' : '    <priority>0.7</priority>',
          '  </url>',
        ].join('\n');
      }).join('\n');

      const sitemap = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        urls,
        '</urlset>',
      ].join('\n');

      const robots = [
        'User-agent: *',
        'Allow: /',
        'Disallow: /email-preferences',
        '',
        'User-agent: OAI-SearchBot',
        'Allow: /',
        '',
        'User-agent: ChatGPT-User',
        'Allow: /',
        '',
        'User-agent: PerplexityBot',
        'Allow: /',
        '',
        'User-agent: ClaudeBot',
        'Allow: /',
        '',
        'User-agent: Google-Extended',
        'Allow: /',
        '',
        'User-agent: Applebot-Extended',
        'Allow: /',
        '',
        `Sitemap: ${SITE_URL}/sitemap.xml`,
      ].join('\n');

      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: sitemap,
      });

      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: robots,
      });

      this.emitFile({
        type: 'asset',
        fileName: 'llms.txt',
        source: LLMS_TXT,
      });

      this.emitFile({
        type: 'asset',
        fileName: 'llms-full.txt',
        source: LLMS_FULL_TXT,
      });
    },
    writeBundle(options) {
      const outDir = options.dir ?? path.resolve(process.cwd(), 'dist');
      const indexHtmlPath = path.join(outDir, 'index.html');
      if (!fs.existsSync(indexHtmlPath)) return;
      const baseHtml = fs.readFileSync(indexHtmlPath, 'utf8');
      for (const route of PRERENDERED_ROUTES) {
        const targetPath = path.join(outDir, route.fileName);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, buildRouteHtml(baseHtml, route), 'utf8');
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), createSeoFilesPlugin()],
});
