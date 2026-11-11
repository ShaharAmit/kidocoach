import { Link } from 'react-router-dom';
import { openPrivacyChoices } from '../services/analytics';
import InteractiveRoutinePreview from '../components/InteractiveRoutinePreview';
import '../styles/home.css';

export type GuideVariant = 'morning' | 'bedtime' | 'visual';

type GuideContent = {
  eyebrow: string;
  title: string;
  subtitle: string;
  problemTitle: string;
  problemLead: string;
  steps: { title: string; copy: string }[];
  faqs: { q: string; a: string }[];
};

const GUIDE_CONTENT: Record<GuideVariant, GuideContent> = {
  morning: {
    eyebrow: 'Morning Routine App for Kids (Ages 2–12)',
    title: 'End Morning Battles Before School—Without Nagging',
    subtitle:
      'KidoCoach turns chaotic mornings into a playful step-by-step mission led by an animated routine coach that speaks your child’s name.',
    problemTitle: 'Why Traditional Morning Checklists Stop Working',
    problemLead:
      'Paper charts fade into the background after a week. KidoCoach keeps kids engaged with live voice prompts, visual avatar demonstrations, and gentle activity timers.',
    steps: [
      {
        title: '1. Wake Up & Wash Face',
        copy: 'The animated coach greets your child by name right at wake-up time so getting out of bed feels like starting a game.',
      },
      {
        title: '2. Brush Teeth & Get Dressed',
        copy: 'Each hygiene and dressing step has its own focused visual loop and timer so kids finish one task before worrying about the next.',
      },
      {
        title: '3. Eat Breakfast & Pack Backpack',
        copy: 'Kids tap the giant "Mission Complete" button after every step, earning stars and heading out the door calm and on time.',
      },
    ],
    faqs: [
      {
        q: 'How long does a typical KidoCoach morning routine take?',
        a: 'Parents set their child’s wake-up time and natural morning pace during the 2-minute setup. Most morning routines run between 20 and 35 minutes across 4 to 6 bite-sized activities.',
      },
      {
        q: 'Does KidoCoach work if our Wi-Fi is spotty in the morning?',
        a: 'Yes. The KidoCoach mobile app pre-downloads your child’s avatar videos and personalized name audio tracks in advance so routines start reliably offline.',
      },
    ],
  },
  bedtime: {
    eyebrow: 'Bedtime Routine App for Kids (Ages 2–12)',
    title: 'Smoother Bedtime Routines & Calm Evening Wind-Downs',
    subtitle:
      'Help tired kids transition from playtime to pajamas, brushing teeth, story time, and sleep with a calm, encouraging routine coach.',
    problemTitle: 'Replace Evening Stall Tactics With a Predictable Flow',
    problemLead:
      'At the end of the day, kids are tired and transitions feel hard. KidoCoach uses a soothing evening voice tone and clear visual steps so kids know what comes next.',
    steps: [
      {
        title: '1. Tidy Toys & Put On Pajamas',
        copy: 'Warm, calm voice prompts call your child by name to wrap up playtime and transform into cozy pajamas.',
      },
      {
        title: '2. Evening Brush Teeth',
        copy: 'A dedicated 60-second visual brushing step keeps kids focused at the sink without parent reminders.',
      },
      {
        title: '3. Bedtime Story & Sweet Dreams',
        copy: 'The routine finishes with cozy story time and a peaceful goodnight milestone at your target bedtime.',
      },
    ],
    faqs: [
      {
        q: 'Is the evening voice coach calmer than the morning coach?',
        a: 'Yes. Evening routines automatically use a warm, calm voice delivery designed to help children wind down rather than rev up before bed.',
      },
      {
        q: 'Can we use KidoCoach for both morning and bedtime routines?',
        a: 'Yes! One parent account configures both your morning wake-up schedule and your evening bedtime schedule across iOS, Android, and Web.',
      },
    ],
  },
  visual: {
    eyebrow: 'Visual Routine Schedule & Step-by-Step Timer for Kids',
    title: 'One Clear Step at a Time for Visual & Easily Distracted Kids',
    subtitle:
      'Long chore lists overwhelm young brains. KidoCoach combines a single-task visual avatar, personalized voice cues, and gentle timers to make daily transitions easier.',
    problemTitle: 'Designed Around How Kids Actually Focus',
    problemLead:
      'When children see 8 tasks on a wall chart, they freeze or get distracted. KidoCoach shows only the current step on screen—with an animated buddy doing it alongside them.',
    steps: [
      {
        title: 'Single-Task Visual Focus',
        copy: 'Full-screen animated avatar loops show one activity at a time so kids never feel overwhelmed by a long checklist.',
      },
      {
        title: 'Name-Personalized Audio Cues',
        copy: 'Hearing their own name spoken by the routine coach gently brings wandering attention back to the current step.',
      },
      {
        title: 'Immediate Positive Feedback',
        copy: 'Tapping the giant "Mission Complete" button gives instant visual celebration and star rewards that build lasting habit momentum.',
      },
    ],
    faqs: [
      {
        q: 'How does KidoCoach support kids who get easily distracted?',
        a: 'During setup, you can choose your child’s natural pace (such as "slow and dreamy" or "easily distracted") and support level. KidoCoach adjusts routine composition and voice tone to match. (Note: KidoCoach is an educational family habit tool, not a medical or clinical device.)',
      },
      {
        q: 'Can my child try a routine preview right now?',
        a: 'Yes—use the interactive routine preview below to test your child’s name and wake-up schedule, then save it in your parent profile.',
      },
    ],
  },
};

export default function RoutineGuidePage({ variant }: { variant: GuideVariant }) {
  const content = GUIDE_CONTENT[variant];

  return (
    <main className="home-shell">
      <header className="top-bar">
        <Link to="/" className="brand-lockup" style={{ textDecoration: 'none' }} aria-label="KidoCoach home">
          <img className="brand-mark" src="/logo.png?v=9e729603" alt="" aria-hidden="true" />
          <span className="brand-name">KidoCoach</span>
        </Link>
        <Link to="/profile" className="hero-cta-primary">
          Get Started / Profile
        </Link>
      </header>

      <section className="hero-layout">
        <div className="hero-copy">
          <p className="eyebrow">{content.eyebrow}</p>
          <h1 className="hero-title">{content.title}</h1>
          <p className="hero-subtitle">{content.subtitle}</p>
          <div className="hero-cta-row">
            <Link to="/profile" className="hero-cta-primary">
              Set Up Your Child&apos;s Routine
            </Link>
            <Link to="/" className="hero-cta-secondary">
              Watch Welcome Video
            </Link>
          </div>
        </div>
      </section>

      <section className="info-sections" aria-label={content.title}>
        <section className="info-block">
          <p className="eyebrow">Step-by-Step Flow</p>
          <h2 className="section-title">{content.problemTitle}</h2>
          <p className="section-lead">{content.problemLead}</p>
          <div className="feature-grid">
            {content.steps.map((step, idx) => (
              <article key={step.title} className="feature-card">
                <span className="feature-step">{idx + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </article>
            ))}
          </div>
        </section>

        <InteractiveRoutinePreview />

        <section className="info-block faq-block">
          <p className="eyebrow">Common Questions</p>
          <h2 className="section-title">Parents Also Ask</h2>
          <div className="faq-list">
            {content.faqs.map((item, idx) => (
              <details key={item.q} className="faq-item" open={idx === 0}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <footer className="home-footer">
          <div className="home-footer-brand">
            <img className="brand-mark" src="/logo.png?v=9e729603" alt="" aria-hidden="true" />
            <span>KidoCoach — Daily Routine App for Kids</span>
          </div>
          <nav className="home-footer-links" aria-label="Footer navigation">
            <Link to="/">Home</Link>
            <Link to="/morning-routine-for-kids">Morning Routines</Link>
            <Link to="/bedtime-routine-for-kids">Bedtime Routines</Link>
            <Link to="/visual-routine-schedule-for-kids">Visual Schedules</Link>
            <Link to="/profile">Profile</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
            <button type="button" className="footer-link-btn" onClick={openPrivacyChoices}>
              Privacy Choices
            </button>
          </nav>
        </footer>
      </section>
    </main>
  );
}
