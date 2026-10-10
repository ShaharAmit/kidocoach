import * as admin from 'firebase-admin';
import { FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { GoogleGenAI } from '@google/genai';

admin.initializeApp();

// Hard ceiling on parallel instances so a flood of calls cannot scale Gemini spend unbounded.
setGlobalOptions({ maxInstances: 10 });

const db = admin.firestore();
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const geminiModel = 'gemini-3.8-flash-tts';

if (!projectId) {
  throw new Error('Missing GCP project id (GCLOUD_PROJECT / GCP_PROJECT).');
}

// gemini-3.8-flash-tts is only served from the global Vertex AI endpoint (404 in us-central1).
const geminiClient = new GoogleGenAI({
  vertexai: true,
  project: projectId,
  location: 'global',
});

type Tone = 'cheerful' | 'encouraging' | 'calm';
type Voice = 'woman' | 'man';
type AudioStatus = 'ready' | 'generating';

const DAY_MS = 24 * 60 * 60 * 1000;
/** audio_cache docs expire after a year without any device requesting them (Firestore TTL on `expireAt`). */
const AUDIO_CACHE_TTL_MS = 365 * DAY_MS;
/** Only rewrite `expireAt` on cache hits when it is this stale, to avoid a write per request. */
const AUDIO_CACHE_TTL_REFRESH_MS = 30 * DAY_MS;
/** A `generating` claim older than this is assumed to belong to a crashed invocation. */
const STALE_GENERATION_CLAIM_MS = 3 * 60 * 1000;
/** New (non-cached) clips a single Firebase user may synthesize per UTC day. */
const DAILY_GENERATION_LIMIT_PER_USER = 60;
const MAX_ACTIVITY_KEYS_PER_BATCH = 20;
const MAX_CHILD_NAME_LENGTH = 30;
const CHILD_NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;

interface GeneratePart1AudioRequest {
  childName: string;
  activityKey: string;
  tone?: Tone;
  voice?: Voice;
}

interface GeneratePart1AudioResponse {
  storagePath: string | null;
  cacheKey: string;
  status: AudioStatus;
}

interface GenerateRoutinePart1AudioRequest {
  childName: string;
  activityKeys: string[];
  tone?: Tone;
  voice?: Voice;
}

interface GenerateRoutinePart1AudioResponse {
  results: Array<{
    activityKey: string;
    storagePath: string | null;
    cacheKey: string;
    status: AudioStatus;
  }>;
}

interface SubmitEarlyAccessLeadRequest {
  email: string;
}

interface SubmitEarlyAccessLeadResponse {
  status: 'created' | 'exists';
}

interface AwardRoutineStepStarRequest {
  userId: string;
  routineId: string;
  date: string;
  segment: 'morning' | 'evening';
  stepIndex: number;
  stepId: string;
  stars?: number;
}

interface AwardRoutineStepStarResponse {
  totalStars: number;
  awarded: boolean;
}

function pcm16ToWav(pcmData: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const wavHeader = Buffer.alloc(44);

  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + pcmData.length, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16); // PCM fmt chunk size
  wavHeader.writeUInt16LE(1, 20); // Audio format: PCM
  wavHeader.writeUInt16LE(channels, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(byteRate, 28);
  wavHeader.writeUInt16LE(blockAlign, 32);
  wavHeader.writeUInt16LE(bitsPerSample, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([wavHeader, pcmData]);
}

/**
 * Normalizes TTS output to a canonical 44-byte-header PCM WAV (the layout the client's
 * `getWavAudioDuration` parses). Gemini 3.8 TTS returns a full WAV whose `data` chunk is followed
 * by trailing bytes; wrapping that whole buffer as PCM would bake its header and trailer into the
 * clip as audible noise. Older models returned raw PCM16, which is wrapped as before.
 */
function ttsAudioToWav(audio: Buffer): Buffer {
  if (audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    return pcm16ToWav(audio);
  }

  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let offset = 12;
  while (offset + 8 <= audio.length) {
    const chunkId = audio.toString('ascii', offset, offset + 4);
    const chunkSize = audio.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ' && body + 16 <= audio.length) {
      format = {
        audioFormat: audio.readUInt16LE(body),
        channels: audio.readUInt16LE(body + 2),
        sampleRate: audio.readUInt32LE(body + 4),
        bitsPerSample: audio.readUInt16LE(body + 14),
      };
    } else if (chunkId === 'data') {
      if (!format || format.audioFormat !== 1) {
        throw new Error('TTS returned a non-PCM WAV.');
      }
      const pcm = audio.subarray(body, Math.min(audio.length, body + chunkSize));
      return pcm16ToWav(pcm, format.sampleRate, format.channels, format.bitsPerSample);
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  throw new Error('TTS returned a WAV without a data chunk.');
}

function extractAudioBuffer(response: unknown): Buffer {
  const candidates = (response as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string | Uint8Array | Buffer } }> } }> }).candidates;
  if (!candidates?.length) {
    throw new Error('Gemini returned no candidates.');
  }

  const parts = candidates[0].content?.parts;
  if (!parts?.length) {
    throw new Error('Gemini returned no audio parts.');
  }

  const audioPart = parts.find((part) => part.inlineData?.data);
  const data = audioPart?.inlineData?.data;
  if (!data) {
    throw new Error('Gemini returned no inline audio data.');
  }

  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (typeof data === 'string') {
    return Buffer.from(data, 'base64');
  }

  return Buffer.from(data);
}

/**
 * Delivery direction for `speechMetadata.style`. Gemini 3.8 TTS speaks the text part verbatim,
 * so direction must never be concatenated into the transcript or it gets read aloud.
 */
function buildToneStyle(tone: Tone | undefined): string {
  if (tone === 'encouraging') return 'encouraging and supportive, speaking warmly to a young child';
  if (tone === 'calm') return 'calm and gentle, speaking softly to a young child';
  return 'cheerful and enthusiastic, speaking warmly to a young child';
}

function mapVoiceToGemini(voice: Voice | undefined): string {
  return voice === 'man' ? 'Kore' : 'Aoede';
}

/**
 * Cache-key-safe, collision-free name token. MUST stay identical to `utils/nameToken.ts` in the
 * app. ASCII letters/digits pass through and separators become `_` (unchanged for Latin names);
 * every other character becomes `0` + 6 hex digits, so distinct non-Latin names (e.g. Hebrew)
 * never share one audio clip. Validated names contain no digits, so the encoding is unambiguous.
 */
function normalizeNameToken(childName: string): string {
  return Array.from(childName.normalize('NFC').trim().toLowerCase())
    .map((char) => {
      if (/[a-z0-9]/.test(char)) return char;
      if (/[\s'.\-_]/.test(char)) return '_';
      return `0${(char.codePointAt(0) ?? 0).toString(16).padStart(6, '0')}`;
    })
    .join('');
}

function requireUid(request: CallableRequest<unknown>): string {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication is required.');
  }
  return uid;
}

function validateChildName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
  if (!name) {
    throw new HttpsError('invalid-argument', 'Missing required field: childName');
  }
  if (name.length > MAX_CHILD_NAME_LENGTH || !CHILD_NAME_PATTERN.test(name)) {
    throw new HttpsError(
      'invalid-argument',
      `childName must be 1-${MAX_CHILD_NAME_LENGTH} letters (spaces, apostrophes, dots and hyphens allowed).`
    );
  }
  return name;
}

function parseTone(raw: unknown): Tone | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'cheerful' || raw === 'encouraging' || raw === 'calm') return raw;
  throw new HttpsError('invalid-argument', 'tone must be cheerful, encouraging or calm.');
}

function parseVoice(raw: unknown): Voice | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'woman' || raw === 'man') return raw;
  throw new HttpsError('invalid-argument', 'voice must be woman or man.');
}

function audioStoragePath(cacheKey: string): string {
  return `audio/${cacheKey}.wav`;
}

function expireAtFromNow(): Timestamp {
  return Timestamp.fromMillis(Date.now() + AUDIO_CACHE_TTL_MS);
}

type GenerationClaim =
  | { action: 'ready' }
  | { action: 'in-progress' }
  | { action: 'generate' };

/**
 * Bumped when the synthesis request changes in a way that invalidates clips already cached. v2
 * moved tone into `speechMetadata.style`: before that, gemini-3.8-flash-tts spoke the
 * "Say in a … way:" direction aloud, so only those clips are regenerated (once). Clips from older
 * models never carried that bug and stay cached.
 */
const TTS_PROMPT_VERSION = 2;

function isReusableReadyClip(data: Record<string, unknown>): boolean {
  return data.ttsModel !== 'gemini-3.8-flash-tts' || data.ttsPromptVersion === TTS_PROMPT_VERSION;
}

/**
 * Atomically resolves a cache entry: returns `ready` (refreshing its TTL), `in-progress` when a
 * live invocation already owns it, or claims it with `status: 'generating'` after charging the
 * caller's daily generation quota. Cache hits never consume quota.
 */
async function claimAudioGeneration(
  uid: string,
  cacheRef: DocumentReference,
  claimFields: Record<string, unknown>
): Promise<GenerationClaim> {
  const today = new Date().toISOString().slice(0, 10);
  const quotaRef = db.collection('rate_limits').doc(`tts_${uid}_${today}`);

  return db.runTransaction(async (tx) => {
    const [snap, quotaSnap] = await Promise.all([tx.get(cacheRef), tx.get(quotaRef)]);
    const data = snap.data();

    if (snap.exists && data?.status === 'ready' && isReusableReadyClip(data)) {
      const expireAtMs = (data.expireAt as Timestamp | undefined)?.toMillis() ?? 0;
      if (expireAtMs - Date.now() < AUDIO_CACHE_TTL_MS - AUDIO_CACHE_TTL_REFRESH_MS) {
        tx.update(cacheRef, { expireAt: expireAtFromNow() });
      }
      return { action: 'ready' };
    }

    const claimedAtMs =
      (data?.claimedAt as Timestamp | undefined)?.toMillis() ??
      (data?.createdAt as Timestamp | undefined)?.toMillis() ??
      0;
    if (snap.exists && data?.status === 'generating' && Date.now() - claimedAtMs < STALE_GENERATION_CLAIM_MS) {
      return { action: 'in-progress' };
    }

    const used = Number(quotaSnap.data()?.count ?? 0);
    if (used >= DAILY_GENERATION_LIMIT_PER_USER) {
      throw new HttpsError('resource-exhausted', 'Daily voice generation limit reached. Try again tomorrow.');
    }

    tx.set(
      quotaRef,
      {
        uid,
        count: FieldValue.increment(1),
        expireAt: Timestamp.fromMillis(Date.now() + 2 * DAY_MS),
      },
      { merge: true }
    );
    tx.set(
      cacheRef,
      {
        ...claimFields,
        status: 'generating',
        claimedAt: FieldValue.serverTimestamp(),
        createdAt: data?.createdAt ?? FieldValue.serverTimestamp(),
        expireAt: expireAtFromNow(),
      },
      { merge: true }
    );
    return { action: 'generate' };
  });
}

const PART1_TEMPLATES: Record<string, { prompt: Tone; textTemplate: string }> = {
  wake_up: { prompt: 'encouraging', textTemplate: 'Good morning, {name}!' },
  make_bed: { prompt: 'encouraging', textTemplate: 'Good morning, {name}!' },
  brush_teeth: { prompt: 'encouraging', textTemplate: 'Toothbrush time, {name}!' },
  eat_breakfast: { prompt: 'encouraging', textTemplate: 'Breakfast time, {name}!' },
  get_dressed: { prompt: 'encouraging', textTemplate: "Let's get dressed, {name}!" },
  put_shoes_on: { prompt: 'encouraging', textTemplate: 'All right, {name}!' },
  comb_hair: { prompt: 'encouraging', textTemplate: "Let's take care of your hair, {name}!" },
  drink_water: { prompt: 'encouraging', textTemplate: 'Water time, {name}!' },
  homework: { prompt: 'encouraging', textTemplate: 'All right, {name}!' },
  eat_dinner: { prompt: 'calm', textTemplate: 'Dinner time, {name}!' },
  tidy_room: { prompt: 'encouraging', textTemplate: 'What a busy day of playing, {name}!' },
  put_on_pajamas: { prompt: 'calm', textTemplate: 'Time to transform for the night, {name}!' },
  bedtime_story: { prompt: 'calm', textTemplate: 'Story time, {name}.' },
  go_to_sleep: { prompt: 'calm', textTemplate: 'You did it, {name}.' },
};

function buildPart1AudioKey(
  activityKey: string,
  childName: string,
  tone?: Tone,
  voice?: Voice
): string {
  const normalizedName = normalizeNameToken(childName);
  const normalizedActivity = activityKey.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  const template = PART1_TEMPLATES[activityKey];
  const selectedTone = tone ?? template?.prompt ?? 'encouraging';
  const selectedVoice = voice ?? 'woman';
  // MUST stay identical to `buildPart1AudioKey` in services/part1Audio.ts.
  return `p1_${normalizedActivity}_${normalizedName}_${selectedTone}_${selectedVoice}`;
}

/**
 * Validate a generated WAV buffer server-side: a minimal RIFF/WAVE header plus enough
 * audio payload to be a real clip (guards against empty / malformed synthesis output).
 */
function isValidWavBuffer(buffer: Buffer): boolean {
  const MIN_WAV_BYTES = 1024; // header (44B) + a small amount of PCM
  if (buffer.length < MIN_WAV_BYTES) return false;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return false;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return false;
  return true;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function hashEmail(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function synthesizeWithGeminiTts(
  text: string,
  tone: Tone | undefined,
  voice: Voice | undefined
): Promise<Buffer> {
  let lastError: Error | null = null;
  const selectedVoice = mapVoiceToGemini(voice);
  const style = buildToneStyle(tone);

  // Gemini Flash TTS can occasionally return no audio; retry a few times.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await geminiClient.models.generateContent({
        model: geminiModel,
        contents: [{ role: 'user', parts: [{ text, speechMetadata: { style } }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: selectedVoice,
              },
            },
          },
        },
      });

      return extractAudioBuffer(response);
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error('Unknown Gemini TTS error');
    }
  }

  throw lastError || new Error('Gemini TTS failed after retries.');
}

/**
 * Internal helper to generate or fetch Part 1 TTS audio for a specific activity & child name.
 * Generated clips are private Storage objects; clients fetch them with an authenticated
 * `getDownloadURL(storagePath)`, never through a public URL.
 */
async function generatePart1AudioInternal(
  uid: string,
  childName: string,
  activityKey: string,
  tone?: Tone,
  voice?: Voice
): Promise<GeneratePart1AudioResponse> {
  const template = PART1_TEMPLATES[activityKey];
  if (!template) {
    throw new HttpsError('invalid-argument', `Unknown activityKey: ${activityKey}`);
  }

  const selectedTone = tone ?? template.prompt;
  const selectedVoice = voice ?? 'woman';
  const spokenText = template.textTemplate.replace(/\{name\}/g, childName);
  const cacheKey = buildPart1AudioKey(activityKey, childName, selectedTone, selectedVoice);
  const storagePath = audioStoragePath(cacheKey);
  const cacheRef = db.collection('audio_cache').doc(cacheKey);

  // Data minimization: the doc never stores the child's name in plain text.
  const claim = await claimAudioGeneration(uid, cacheRef, {
    id: cacheKey,
    type: 'part1',
    activityKey,
    tone: selectedTone,
    voice: selectedVoice,
    storagePath,
  });

  if (claim.action === 'ready') {
    return { storagePath, cacheKey, status: 'ready' };
  }
  if (claim.action === 'in-progress') {
    return { storagePath: null, cacheKey, status: 'generating' };
  }

  try {
    const rawAudio = await synthesizeWithGeminiTts(spokenText, selectedTone, selectedVoice);
    const audioBuffer = ttsAudioToWav(rawAudio);

    if (!isValidWavBuffer(audioBuffer)) {
      throw new Error('Generated audio failed WAV validation.');
    }

    await admin.storage().bucket().file(storagePath).save(audioBuffer, {
      resumable: false,
      contentType: 'audio/wav',
      metadata: {
        metadata: {
          activityKey,
          type: 'part1',
          ttsProvider: 'gemini',
          ttsModel: geminiModel,
          ttsVoice: mapVoiceToGemini(selectedVoice),
          ttsTone: selectedTone,
          generatedAt: new Date().toISOString(),
        },
      },
    });

    await cacheRef.set(
      {
        status: 'ready',
        ttsModel: geminiModel,
        ttsPromptVersion: TTS_PROMPT_VERSION,
        updatedAt: FieldValue.serverTimestamp(),
        expireAt: expireAtFromNow(),
      },
      { merge: true }
    );

    console.info(`[generatePart1Audio] Generated: ${cacheKey}`);
    return { storagePath, cacheKey, status: 'ready' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[generatePart1Audio] Error for ${cacheKey}:`, message);

    // Release the claim so a later attempt can retry.
    await cacheRef.set(
      { status: 'error', updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    throw new HttpsError('internal', 'Part 1 audio generation failed.');
  }
}

/**
 * Firebase Cloud Function: generatePart1Audio
 *
 * Synthesizes and caches Part 1 greeting audio for an activity step and child name.
 */
export const generatePart1Audio = onCall(
  { timeoutSeconds: 120, memory: '512MiB', maxInstances: 5 },
  async (
    request: CallableRequest<GeneratePart1AudioRequest>
  ): Promise<GeneratePart1AudioResponse> => {
    const uid = requireUid(request);
    const childName = validateChildName(request.data?.childName);
    const activityKey = typeof request.data?.activityKey === 'string' ? request.data.activityKey.trim() : '';
    if (!activityKey) {
      throw new HttpsError('invalid-argument', 'Missing required field: activityKey');
    }

    return generatePart1AudioInternal(
      uid,
      childName,
      activityKey,
      parseTone(request.data?.tone),
      parseVoice(request.data?.voice)
    );
  }
);

/**
 * Firebase Cloud Function: generateRoutinePart1Audio
 *
 * Batch synthesizes and caches Part 1 greeting audio for all activities in a routine.
 */
export const generateRoutinePart1Audio = onCall(
  { timeoutSeconds: 120, memory: '512MiB', maxInstances: 5 },
  async (
    request: CallableRequest<GenerateRoutinePart1AudioRequest>
  ): Promise<GenerateRoutinePart1AudioResponse> => {
    const uid = requireUid(request);
    const childName = validateChildName(request.data?.childName);
    const tone = parseTone(request.data?.tone);
    const voice = parseVoice(request.data?.voice);
    const rawKeys = request.data?.activityKeys;

    if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
      throw new HttpsError('invalid-argument', 'Missing or empty activityKeys array');
    }
    const activityKeys = Array.from(
      new Set(rawKeys.filter((key): key is string => typeof key === 'string').map((key) => key.trim()))
    );
    if (activityKeys.length === 0 || activityKeys.length > MAX_ACTIVITY_KEYS_PER_BATCH) {
      throw new HttpsError(
        'invalid-argument',
        `activityKeys must contain 1-${MAX_ACTIVITY_KEYS_PER_BATCH} distinct keys.`
      );
    }

    const results = await Promise.all(
      activityKeys.map(async (activityKey) => {
        try {
          const res = await generatePart1AudioInternal(uid, childName, activityKey, tone, voice);
          return { activityKey, ...res };
        } catch (err) {
          console.error(`[generateRoutinePart1Audio] Failed for ${activityKey}:`, err);
          return {
            activityKey,
            storagePath: null,
            cacheKey: buildPart1AudioKey(activityKey, childName, tone, voice),
            status: 'generating' as const,
          };
        }
      })
    );

    return { results };
  }
);

/**
 * Firebase Cloud Function: deleteAccount
 *
 * Permanently deletes the caller's family data (`users/{uid}` and every subcollection) and the
 * Firebase Auth user. Shared, name-keyed audio clips are not linked to a UID and expire via TTL.
 * Store subscriptions are owned by Apple/Google and must be cancelled by the parent.
 */
export const deleteAccount = onCall(
  { timeoutSeconds: 120, memory: '256MiB' },
  async (request: CallableRequest<unknown>): Promise<{ deleted: true }> => {
    const uid = requireUid(request);

    await db.recursiveDelete(db.collection('users').doc(uid));

    try {
      await admin.auth().deleteUser(uid);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code !== 'auth/user-not-found') throw err;
    }

    console.info(`[deleteAccount] Deleted account ${uid}`);
    return { deleted: true };
  }
);

export const submitEarlyAccessLead = onCall(
  { cors: true },
  async (
    request: CallableRequest<SubmitEarlyAccessLeadRequest>
  ): Promise<SubmitEarlyAccessLeadResponse> => {
    const normalizedEmail = normalizeEmail(request.data?.email ?? '');

    if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
      throw new HttpsError('invalid-argument', 'A valid email is required.');
    }

    const leadHash = hashEmail(normalizedEmail);
    const leadsCollection = db.collection('early_access');
    const leadRef = leadsCollection.doc(leadHash);
    const legacyLeadRef = leadsCollection.doc(normalizedEmail);

    const result = await db.runTransaction(async (transaction) => {
      const [leadDoc, legacyLeadDoc] = await Promise.all([
        transaction.get(leadRef),
        transaction.get(legacyLeadRef),
      ]);

      if (leadDoc.exists) {
        return 'exists' as const;
      }

      if (legacyLeadDoc.exists) {
        const legacyData = legacyLeadDoc.data() ?? {};
        transaction.create(leadRef, {
          ...legacyData,
          email: normalizedEmail,
          emailLower: normalizedEmail,
          emailHash: leadHash,
          source: 'website_welcome_video',
          migratedAt: FieldValue.serverTimestamp(),
        });
        transaction.delete(legacyLeadRef);
        return 'exists' as const;
      }

      transaction.create(leadRef, {
        email: normalizedEmail,
        emailLower: normalizedEmail,
        emailHash: leadHash,
        source: 'website_welcome_video',
        createdAt: FieldValue.serverTimestamp(),
      });

      return 'created' as const;
    });

    return { status: result };
  }
);

export const awardRoutineStepStar = onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (
    request: CallableRequest<AwardRoutineStepStarRequest>
  ): Promise<AwardRoutineStepStarResponse> => {
    const authUid = request.auth?.uid;
    if (!authUid) {
      throw new HttpsError('unauthenticated', 'Authentication is required.');
    }

    const { userId, routineId, date, segment, stepIndex, stepId, stars = 1 } = request.data ?? {};
    if (!userId || !routineId || !date || (segment !== 'morning' && segment !== 'evening')) {
      throw new HttpsError(
        'invalid-argument',
        'Missing required fields: userId, routineId, date, segment.'
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HttpsError('invalid-argument', 'date must be in YYYY-MM-DD format.');
    }
    if (!Number.isInteger(stepIndex) || stepIndex < 0) {
      throw new HttpsError(
        'invalid-argument',
        'stepIndex must be a non-negative integer.'
      );
    }
    if (typeof stepId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(stepId)) {
      throw new HttpsError('invalid-argument', 'stepId must be a valid task ID.');
    }
    if (!Number.isInteger(stars) || stars < 1 || stars > 2) {
      throw new HttpsError('invalid-argument', 'stars must be an integer between 1 and 2.');
    }
    if (authUid !== userId) {
      throw new HttpsError('permission-denied', 'Cannot award stars for a different user.');
    }

    const userRef = db.collection('users').doc(userId);
    const statsRef = userRef.collection('stats').doc('main');
    const eventId = `${date}_${routineId}_${segment}_${stepId}`;
    const awardRef = userRef.collection('awards').doc(eventId);

    return db.runTransaction(async (tx) => {
      const [statsSnap, awardSnap] = await Promise.all([tx.get(statsRef), tx.get(awardRef)]);
      const currentTotal = Number(statsSnap.data()?.totalStars ?? 0);

      if (awardSnap.exists) {
        return {
          totalStars: currentTotal,
          awarded: false,
        };
      }

      const nextTotal = currentTotal + stars;

      tx.set(
        statsRef,
        {
          userId,
          totalStars: nextTotal,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      tx.set(awardRef, {
        userId,
        routineId,
        date,
        segment,
        stepIndex,
        stepId,
        stars,
        createdAt: FieldValue.serverTimestamp(),
      });

      return {
        totalStars: nextTotal,
        awarded: true,
      };
    });
  }
);

export const onAudioCacheDocDeleted = onDocumentDeleted(
  'audio_cache/{cacheKey}',
  async (event) => {
    const cacheKey = event.params.cacheKey;
    const storagePaths = [`audio/${cacheKey}.wav`, `audio/${cacheKey}.mp3`];

    for (const storagePath of storagePaths) {
      try {
        await admin.storage().bucket().file(storagePath).delete();
        console.info(`[onAudioCacheDeleted] Deleted storage file: ${storagePath}`);
      } catch (err) {
        console.warn(`[onAudioCacheDeleted] Could not delete ${storagePath}:`, err);
      }
    }
  }
);
