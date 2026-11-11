import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { resolveStorageAssetUrl, type SampleClipConfig } from '../services/siteConfig';

/** Playable URL for a sample clip, or '' when the file doesn't exist (the SPA fallback serves HTML for missing /samples files). */
async function resolveSampleClipUrl(videoUrl: string): Promise<string> {
  try {
    const url = await resolveStorageAssetUrl(videoUrl);
    if (!url || !url.startsWith('/')) return url;
    const res = await fetch(url, { method: 'HEAD' });
    const contentType = res.headers.get('content-type') ?? '';
    return res.ok && contentType.startsWith('video/') ? url : '';
  } catch {
    return '';
  }
}

const PREVIEW_STEPS = [
  { emoji: '☀️', label: 'Wake Up', mins: 2, prompt: (n: string) => `Good morning, ${n}! Time to wake up and start a wonderful day.` },
  { emoji: '🚿', label: 'Wash Face', mins: 2, prompt: (n: string) => `Face washing time, ${n}! Let's feel fresh and clean.` },
  { emoji: '🦷', label: 'Brush Teeth', mins: 2, prompt: (n: string) => `Toothbrush time, ${n}! Let's make those teeth sparkle.` },
  { emoji: '👕', label: 'Get Dressed', mins: 4, prompt: (n: string) => `Let's get dressed, ${n}, and get ready for an amazing day.` },
  { emoji: '🎒', label: 'Pack Backpack', mins: 3, prompt: (n: string) => `You're doing great, ${n}! Let's pack your backpack.` },
  { emoji: '🥞', label: 'Eat Breakfast', mins: 10, prompt: (n: string) => `Breakfast time, ${n}! Let's fuel up with energy.` },
];

function addMinutesToTime(hhmm: string, addMins: number): string {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const total = (h * 60 + m + addMins) % (24 * 60);
  const nextH = String(Math.floor(total / 60)).padStart(2, '0');
  const nextM = String(total % 60).padStart(2, '0');
  return `${nextH}:${nextM}`;
}

export function SampleClipSwitcher({
  clips,
  activeClipId,
  onSelectClip,
}: {
  clips: SampleClipConfig[];
  activeClipId: string | null;
  onSelectClip: (clip: SampleClipConfig | null, resolvedVideoUrl: string) => void;
}) {
  // Clips whose file exists, with their playable URL. Missing clips are never shown.
  const [available, setAvailable] = useState<{ clip: SampleClipConfig; url: string }[]>([]);
  const clipsKey = clips.map((clip) => `${clip.id}|${clip.videoUrl}`).join(',');

  useEffect(() => {
    let cancelled = false;
    void Promise.all(clips.map(async (clip) => {
      const url = await resolveSampleClipUrl(clip.videoUrl);
      return url ? { clip, url } : null;
    })).then((results) => {
      if (!cancelled) setAvailable(results.filter((item): item is { clip: SampleClipConfig; url: string } => item !== null));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipsKey]);

  if (available.length === 0) return null;

  return (
    <div className="sample-clip-bar" aria-label="Sample personalized greeting videos">
      <p className="sample-clip-label">
        Hear KidoCoach say a child&apos;s name (lip-synced avatar samples):
      </p>
      <div className="sample-clip-pills">
        {activeClipId !== null && (
          <button
            type="button"
            className="sample-pill sample-pill--reset"
            onClick={() => onSelectClip(null, '')}
          >
            ↩ Welcome Video
          </button>
        )}
        {available.map(({ clip, url }) => {
          const isActive = activeClipId === clip.id;
          return (
            <button
              key={clip.id}
              type="button"
              className={`sample-pill ${isActive ? 'active' : ''}`}
              onClick={() => (isActive ? onSelectClip(null, '') : onSelectClip(clip, url))}
            >
              <span className="sample-pill-icon" aria-hidden="true">
                {isActive ? '🔊' : '▶'}
              </span>
              <span>{clip.name}</span>
              <span className="sample-pill-sub">({clip.activityLabel})</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function InteractiveRoutinePreview() {
  const [sampleName, setSampleName] = useState('Maya');
  const [wakeTime, setWakeTime] = useState('07:00');
  const [pace, setPace] = useState<'normal' | 'dreamy'>('normal');

  const cleanName = sampleName.trim().slice(0, 24) || 'Your Child';
  const multiplier = pace === 'dreamy' ? 1.5 : 1;

  const durations = PREVIEW_STEPS.map((step) => Math.max(1, Math.round(step.mins * multiplier)));
  const timeline = PREVIEW_STEPS.map((step, index) => ({
    ...step,
    startClock: addMinutesToTime(wakeTime, durations.slice(0, index).reduce((sum, mins) => sum + mins, 0)),
    duration: durations[index],
    coachLine: step.prompt(cleanName),
  }));

  return (
    <section id="routine-preview" className="info-block preview-block">
      <p className="eyebrow">Try It Right Now — No Sign-In Needed</p>
      <h2 className="section-title">Preview Your Child&apos;s Morning Routine</h2>
      <p className="section-lead">
        Type a first name and wake-up time below to see how KidoCoach paces the morning and speaks
        directly to your child at every step.
      </p>

      <div className="preview-controls">
        <label className="preview-field">
          <span>Child&apos;s first name</span>
          <input
            type="text"
            value={sampleName}
            maxLength={24}
            placeholder="e.g. Maya"
            onChange={(e) => setSampleName(e.target.value)}
          />
        </label>
        <label className="preview-field">
          <span>Wake-up time</span>
          <input
            type="time"
            value={wakeTime}
            onChange={(e) => setWakeTime(e.target.value || '07:00')}
          />
        </label>
        <label className="preview-field">
          <span>Morning pace</span>
          <select value={pace} onChange={(e) => setPace(e.target.value as 'normal' | 'dreamy')}>
            <option value="normal">Steady &amp; playful (~23 min)</option>
            <option value="dreamy">Slow &amp; dreamy (~34 min)</option>
          </select>
        </label>
      </div>

      <div className="preview-timeline" role="list" aria-label="Sample morning routine steps">
        {timeline.map((item) => (
          <div key={item.label} className="preview-step-card" role="listitem">
            <div className="preview-step-header">
              <span className="preview-step-time">{item.startClock}</span>
              <span className="preview-step-title">
                {item.emoji} {item.label}
              </span>
              <span className="preview-step-duration">{item.duration} min</span>
            </div>
            <p className="preview-step-quote">&ldquo;{item.coachLine}&rdquo;</p>
          </div>
        ))}
      </div>

      <div className="preview-cta-footer">
        <Link to="/profile" className="hero-cta-primary">
          Save {cleanName}&apos;s Routine in Your Profile →
        </Link>
      </div>
    </section>
  );
}
