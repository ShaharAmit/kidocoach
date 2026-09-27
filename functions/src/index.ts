import * as admin from 'firebase-admin';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { GoogleGenAI } from '@google/genai';

admin.initializeApp();

const db = admin.firestore();
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const geminiModel = 'gemini-3.1-flash-tts-preview';

if (!projectId) {
  throw new Error('Missing GCP project id (GCLOUD_PROJECT / GCP_PROJECT).');
}

const geminiClient = new GoogleGenAI({
  vertexai: true,
  project: projectId,
  location: 'us-central1',
});

interface GenerateTTSRequest {
  cacheKey: string;
  text: string;
  childName: string;
  activityKey: string;
  avatarId: string;
  tone?: 'cheerful' | 'encouraging' | 'calm';
  voice?: 'woman' | 'man';
}

interface GenerateTTSResponse {
  audioUrl: string;
  cacheKey: string;
}

interface GenerateNameAudioRequest {
  childName: string;
}

interface GenerateNameAudioResponse {
  audioUrl: string | null;
  cacheKey: string;
  status: 'ready' | 'generating';
}

interface GeneratePart1AudioRequest {
  childName: string;
  activityKey: string;
  tone?: 'cheerful' | 'encouraging' | 'calm';
  voice?: 'woman' | 'man';
}

interface GeneratePart1AudioResponse {
  audioUrl: string | null;
  cacheKey: string;
  status: 'ready' | 'generating';
}

interface GenerateRoutinePart1AudioRequest {
  childName: string;
  activityKeys: string[];
  tone?: 'cheerful' | 'encouraging' | 'calm';
  voice?: 'woman' | 'man';
}

interface GenerateRoutinePart1AudioResponse {
  results: Array<{
    activityKey: string;
    audioUrl: string | null;
    cacheKey: string;
    status: 'ready' | 'generating';
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

function buildTonePrompt(tone: GenerateTTSRequest['tone'], text: string): string {
  if (tone === 'encouraging') {
    return `Say in an encouraging, supportive way for a child named listener: ${text}`;
  }

  if (tone === 'calm') {
    return `Say in a calm, gentle way for a child named listener: ${text}`;
  }

  return `Say in a cheerful, enthusiastic way for a child named listener: ${text}`;
}

function mapVoiceToGemini(voice: GenerateTTSRequest['voice']): string {
  return voice === 'man' ? 'Kore' : 'Aoede';
}

/** Normalize a child name into a cache-key-safe token. Mirrors the client normalizer. */
function normalizeNameToken(childName: string): string {
  return childName.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
}

/** Firestore/Storage cache key for the reusable per-child name clip. */
function buildNameAudioKey(childName: string): string {
  return `name_${normalizeNameToken(childName)}_encouraging`;
}

const PART1_TEMPLATES: Record<string, { prompt: 'encouraging' | 'calm' | 'cheerful'; textTemplate: string }> = {
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
  tone?: 'cheerful' | 'encouraging' | 'calm',
  voice?: 'woman' | 'man'
): string {
  const normalizedName = normalizeNameToken(childName);
  const normalizedActivity = activityKey.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  const template = PART1_TEMPLATES[activityKey];
  const selectedTone = tone ?? template?.prompt ?? 'encouraging';
  const selectedVoice = voice ?? 'woman';
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
  tone: GenerateTTSRequest['tone'],
  voice: GenerateTTSRequest['voice']
): Promise<Buffer> {
  let lastError: Error | null = null;
  const selectedVoice = mapVoiceToGemini(voice);
  const prompt = buildTonePrompt(tone, text);

  // Gemini 3.1 Flash TTS can occasionally return no audio; retry a few times.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await geminiClient.models.generateContent({
        model: geminiModel,
        contents: prompt,
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
 * Firebase Cloud Function: generateRoutineAudio
 *
 * Called by the client when saving a routine to generate personalised TTS audio
 * for each activity step. Saves the .mp3 to Firebase Storage and updates the
 * audio_cache Firestore collection.
 *
 * Input: { cacheKey, text, childName, activityKey, avatarId }
 * Output: { audioUrl, cacheKey }
 */
export const generateRoutineAudio = onCall(
  { timeoutSeconds: 120, memory: '512MiB' },
  async (request: CallableRequest<GenerateTTSRequest>): Promise<GenerateTTSResponse> => {
    const { cacheKey, text, childName, activityKey, avatarId, tone, voice } = request.data;

    if (!cacheKey || !text || !childName || !activityKey || !avatarId) {
      throw new HttpsError(
        'invalid-argument',
        'Missing required fields: cacheKey, text, childName, activityKey, avatarId'
      );
    }

    // Sanitize text length to prevent abuse
    if (text.length > 500) {
      throw new HttpsError('invalid-argument', 'Text exceeds maximum length of 500 characters.');
    }

    const cacheRef = db.collection('audio_cache').doc(cacheKey);
    let tmpFilePath: string | null = null;

    try {
      const selectedVoice = mapVoiceToGemini(voice);
      const selectedTone = tone ?? 'cheerful';
      const rawPcmBuffer = await synthesizeWithGeminiTts(text, selectedTone, voice);
      const audioBuffer = pcm16ToWav(rawPcmBuffer);

      // Write to temp file
      const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      tmpFilePath = path.join(os.tmpdir(), `${cacheKey}-${uniqueSuffix}.wav`);
      fs.writeFileSync(tmpFilePath, audioBuffer);

      // Upload to Firebase Storage
      const bucket = admin.storage().bucket();
      const storagePath = `audio/${cacheKey}.wav`;

      await bucket.upload(tmpFilePath, {
        destination: storagePath,
        metadata: {
          contentType: 'audio/wav',
          metadata: {
            childName,
            activityKey,
            avatarId,
            ttsProvider: 'gemini',
            ttsModel: geminiModel,
            ttsVoice: selectedVoice,
            ttsTone: selectedTone,
            generatedAt: new Date().toISOString(),
          },
        },
      });

      // Make publicly readable and return a stable public URL.
      const file = bucket.file(storagePath);
      await file.makePublic();
      const audioUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;

      // Update Firestore cache document
      await cacheRef.set({
        id: cacheKey,
        audioUrl,
        status: 'ready',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        childName,
        activityKey,
        avatarId,
        tone: selectedTone,
        voice: voice ?? 'woman',
      });

      console.info(`[generateRoutineAudio] Generated: ${cacheKey}`);

      return { audioUrl, cacheKey };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[generateRoutineAudio] Error for ${cacheKey}:`, message);

      // Mark as error in Firestore
      await cacheRef.set({ status: 'error', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

      throw new HttpsError('internal', `TTS generation failed: ${message}`);
    } finally {
      if (tmpFilePath && fs.existsSync(tmpFilePath)) {
        try {
          fs.unlinkSync(tmpFilePath);
        } catch (cleanupErr) {
          console.warn('[generateRoutineAudio] Temp cleanup failed:', cleanupErr);
        }
      }
    }
  });

/**
 * Firebase Cloud Function: generateNameAudio
 *
 * Generates a single reusable "encouraging name" TTS clip (e.g. "Lia") that is overlaid on
 * avatar videos in place of the mis-recorded baked-in name. Globally cached by name so it is
 * only ever generated once. Race-safe via a Firestore transaction that writes
 * status:'generating' before synthesizing.
 *
 * Input: { childName }
 * Output: { audioUrl, cacheKey, status }
 */
export const generateNameAudio = onCall(
  { timeoutSeconds: 120, memory: '512MiB' },
  async (
    request: CallableRequest<GenerateNameAudioRequest>
  ): Promise<GenerateNameAudioResponse> => {
    const childName = (request.data?.childName ?? '').trim();

    if (!childName) {
      throw new HttpsError('invalid-argument', 'Missing required field: childName');
    }
    if (childName.length > 60) {
      throw new HttpsError('invalid-argument', 'childName exceeds maximum length of 60 characters.');
    }

    const cacheKey = buildNameAudioKey(childName);
    const cacheRef = db.collection('audio_cache').doc(cacheKey);

    // Race-condition guard: claim generation atomically.
    const claim = await db.runTransaction(async (tx) => {
      const snap = await tx.get(cacheRef);
      const data = snap.data();

      if (snap.exists && data?.status === 'ready' && data?.audioUrl) {
        return { action: 'ready' as const, audioUrl: data.audioUrl as string };
      }

      if (snap.exists && data?.status === 'generating') {
        return { action: 'in-progress' as const };
      }

      tx.set(
        cacheRef,
        {
          id: cacheKey,
          status: 'generating',
          type: 'name',
          text: childName,
          childName,
          tone: 'encouraging',
          voice: 'woman',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { action: 'generate' as const };
    });

    if (claim.action === 'ready') {
      return { audioUrl: claim.audioUrl, cacheKey, status: 'ready' };
    }
    if (claim.action === 'in-progress') {
      return { audioUrl: null, cacheKey, status: 'generating' };
    }

    let tmpFilePath: string | null = null;
    try {
      const rawPcmBuffer = await synthesizeWithGeminiTts(childName, 'encouraging', 'woman');
      const audioBuffer = pcm16ToWav(rawPcmBuffer);

      // Server-side WAV validation (client only checks file existence, per design).
      if (!isValidWavBuffer(audioBuffer)) {
        throw new Error('Generated audio failed WAV validation.');
      }

      const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      tmpFilePath = path.join(os.tmpdir(), `${cacheKey}-${uniqueSuffix}.wav`);
      fs.writeFileSync(tmpFilePath, audioBuffer);

      const bucket = admin.storage().bucket();
      const storagePath = `audio/${cacheKey}.wav`;

      await bucket.upload(tmpFilePath, {
        destination: storagePath,
        metadata: {
          contentType: 'audio/wav',
          metadata: {
            childName,
            type: 'name',
            ttsProvider: 'gemini',
            ttsModel: geminiModel,
            ttsVoice: 'Aoede',
            ttsTone: 'encouraging',
            generatedAt: new Date().toISOString(),
          },
        },
      });

      const file = bucket.file(storagePath);
      await file.makePublic();
      const audioUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;

      await cacheRef.set(
        {
          id: cacheKey,
          audioUrl,
          status: 'ready',
          type: 'name',
          text: childName,
          childName,
          tone: 'encouraging',
          voice: 'woman',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      console.info(`[generateNameAudio] Generated: ${cacheKey}`);
      return { audioUrl, cacheKey, status: 'ready' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[generateNameAudio] Error for ${cacheKey}:`, message);

      // Clear the 'generating' claim so a later attempt can retry.
      await cacheRef.set(
        { status: 'error', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );

      throw new HttpsError('internal', `Name audio generation failed: ${message}`);
    } finally {
      if (tmpFilePath && fs.existsSync(tmpFilePath)) {
        try {
          fs.unlinkSync(tmpFilePath);
        } catch (cleanupErr) {
          console.warn('[generateNameAudio] Temp cleanup failed:', cleanupErr);
        }
      }
    }
  });

/**
 * Internal helper to generate or fetch Part 1 TTS audio for a specific activity & child name.
 */
async function generatePart1AudioInternal(
  childName: string,
  activityKey: string,
  tone?: 'cheerful' | 'encouraging' | 'calm',
  voice?: 'woman' | 'man'
): Promise<{ audioUrl: string | null; cacheKey: string; status: 'ready' | 'generating' }> {
  const trimmedName = childName.trim();
  const template = PART1_TEMPLATES[activityKey];
  if (!template) {
    throw new HttpsError('invalid-argument', `Unknown activityKey: ${activityKey}`);
  }

  const selectedTone = tone ?? template.prompt ?? 'encouraging';
  const selectedVoice = voice ?? 'woman';
  const spokenText = template.textTemplate.replace(/\{name\}/g, trimmedName);
  const cacheKey = buildPart1AudioKey(activityKey, trimmedName, selectedTone, selectedVoice);
  const cacheRef = db.collection('audio_cache').doc(cacheKey);

  // Race-condition guard: claim generation atomically.
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(cacheRef);
    const data = snap.data();

    if (snap.exists && data?.status === 'ready' && data?.audioUrl) {
      return { action: 'ready' as const, audioUrl: data.audioUrl as string };
    }

    if (snap.exists && data?.status === 'generating') {
      return { action: 'in-progress' as const };
    }

    tx.set(
      cacheRef,
      {
        id: cacheKey,
        status: 'generating',
        type: 'part1',
        text: spokenText,
        childName: trimmedName,
        activityKey,
        tone: selectedTone,
        voice: selectedVoice,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { action: 'generate' as const };
  });

  if (claim.action === 'ready') {
    return { audioUrl: claim.audioUrl, cacheKey, status: 'ready' };
  }
  if (claim.action === 'in-progress') {
    return { audioUrl: null, cacheKey, status: 'generating' };
  }

  let tmpFilePath: string | null = null;
  try {
    const rawPcmBuffer = await synthesizeWithGeminiTts(spokenText, selectedTone, selectedVoice);
    const audioBuffer = pcm16ToWav(rawPcmBuffer);

    if (!isValidWavBuffer(audioBuffer)) {
      throw new Error('Generated audio failed WAV validation.');
    }

    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    tmpFilePath = path.join(os.tmpdir(), `${cacheKey}-${uniqueSuffix}.wav`);
    fs.writeFileSync(tmpFilePath, audioBuffer);

    const bucket = admin.storage().bucket();
    const storagePath = `audio/${cacheKey}.wav`;

    await bucket.upload(tmpFilePath, {
      destination: storagePath,
      metadata: {
        contentType: 'audio/wav',
        metadata: {
          childName: trimmedName,
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

    const file = bucket.file(storagePath);
    await file.makePublic();
    const audioUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;

    await cacheRef.set(
      {
        id: cacheKey,
        audioUrl,
        status: 'ready',
        type: 'part1',
        text: spokenText,
        childName: trimmedName,
        activityKey,
        tone: selectedTone,
        voice: selectedVoice,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.info(`[generatePart1Audio] Generated: ${cacheKey}`);
    return { audioUrl, cacheKey, status: 'ready' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[generatePart1Audio] Error for ${cacheKey}:`, message);

    await cacheRef.set(
      { status: 'error', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    throw new HttpsError('internal', `Part 1 audio generation failed: ${message}`);
  } finally {
    if (tmpFilePath && fs.existsSync(tmpFilePath)) {
      try {
        fs.unlinkSync(tmpFilePath);
      } catch (cleanupErr) {
        console.warn('[generatePart1Audio] Temp cleanup failed:', cleanupErr);
      }
    }
  }
}

/**
 * Firebase Cloud Function: generatePart1Audio
 *
 * Synthesizes and caches Part 1 greeting audio for an activity step and child name.
 */
export const generatePart1Audio = onCall(
  { timeoutSeconds: 120, memory: '512MiB' },
  async (
    request: CallableRequest<GeneratePart1AudioRequest>
  ): Promise<GeneratePart1AudioResponse> => {
    const childName = (request.data?.childName ?? '').trim();
    const activityKey = (request.data?.activityKey ?? '').trim();

    if (!childName) {
      throw new HttpsError('invalid-argument', 'Missing required field: childName');
    }
    if (!activityKey) {
      throw new HttpsError('invalid-argument', 'Missing required field: activityKey');
    }
    if (childName.length > 60) {
      throw new HttpsError('invalid-argument', 'childName exceeds maximum length of 60 characters.');
    }

    return generatePart1AudioInternal(
      childName,
      activityKey,
      request.data?.tone,
      request.data?.voice
    );
  }
);

/**
 * Firebase Cloud Function: generateRoutinePart1Audio
 *
 * Batch synthesizes and caches Part 1 greeting audio for all activities in a routine.
 */
export const generateRoutinePart1Audio = onCall(
  { timeoutSeconds: 120, memory: '512MiB' },
  async (
    request: CallableRequest<GenerateRoutinePart1AudioRequest>
  ): Promise<GenerateRoutinePart1AudioResponse> => {
    const childName = (request.data?.childName ?? '').trim();
    const activityKeys = request.data?.activityKeys ?? [];

    if (!childName) {
      throw new HttpsError('invalid-argument', 'Missing required field: childName');
    }
    if (!Array.isArray(activityKeys) || activityKeys.length === 0) {
      throw new HttpsError('invalid-argument', 'Missing or empty activityKeys array');
    }

    const results = await Promise.all(
      activityKeys.map(async (activityKey) => {
        try {
          const res = await generatePart1AudioInternal(
            childName,
            activityKey,
            request.data?.tone,
            request.data?.voice
          );
          return {
            activityKey,
            audioUrl: res.audioUrl,
            cacheKey: res.cacheKey,
            status: res.status,
          };
        } catch (err) {
          console.error(`[generateRoutinePart1Audio] Failed for ${activityKey}:`, err);
          return {
            activityKey,
            audioUrl: null,
            cacheKey: buildPart1AudioKey(activityKey, childName, request.data?.tone, request.data?.voice),
            status: 'generating' as const,
          };
        }
      })
    );

    return { results };
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
          migratedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        transaction.delete(legacyLeadRef);
        return 'exists' as const;
      }

      transaction.create(leadRef, {
        email: normalizedEmail,
        emailLower: normalizedEmail,
        emailHash: leadHash,
        source: 'website_welcome_video',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
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
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
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
