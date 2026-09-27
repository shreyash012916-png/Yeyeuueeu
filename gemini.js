import fs from 'node:fs/promises';

export const MODEL = 'gemini-3.8-flash';
const BASE = process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com';
const MAX_GEMINI_ASSETS = 40;

const planSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    editorialNotes: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    clipOrder: { type: 'array', items: { type: 'string' }, maxItems: 120 },
    targetDuration: { type: 'number' },
    captions: {
      type: 'array', maxItems: 160,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          sourceKey: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' }
        }, required: ['sourceKey', 'start', 'end', 'text']
      }
    },
    text: {
      type: 'array', maxItems: 24,
      items: {
        type: 'object', additionalProperties: false,
        properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' }, kind: { type: 'string' } },
        required: ['start', 'end', 'text', 'kind']
      }
    },
    clipOverrides: {
      type: 'array', maxItems: 120,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          sourceKey: { type: 'string' }, keep: { type: 'boolean' }, speed: { type: 'number' }, cropX: { type: 'number' },
          effects: { type: 'array', items: { type: 'string' }, maxItems: 3 }
        }, required: ['sourceKey']
      }
    },
    audio: {
      type: 'object', additionalProperties: false,
      properties: { useOriginalAudio: { type: 'boolean' }, musicVolume: { type: 'number' }, voiceVolume: { type: 'number' } },
      required: ['useOriginalAudio', 'musicVolume', 'voiceVolume']
    }
  },
  required: ['summary', 'editorialNotes', 'clipOrder', 'targetDuration', 'captions', 'text', 'clipOverrides', 'audio']
};

const commandSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    operations: {
      type: 'array', maxItems: 24,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          op: { type: 'string', enum: ['setTheme', 'setSpeed', 'removeEffects', 'addEffect', 'setCaptionSize', 'setTargetDuration', 'setAudioMix'] },
          clipIndexes: { type: 'array', items: { type: 'integer' }, maxItems: 120 },
          value: { type: 'string' }, number: { type: 'number' }
        }, required: ['op']
      }
    }
  },
  required: ['summary', 'operations']
};

function key() { return process.env.GEMINI_API_KEY || ''; }
export function geminiAvailable() { return Boolean(key()); }

async function uploadFile(filePath, mime) {
  const k = key();
  const data = await fs.readFile(filePath);
  const start = await fetch(`${BASE}/upload/v1beta/files?key=${encodeURIComponent(k)}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(data.length),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: filePath.split('/').pop() } })
  });
  if (!start.ok) throw new Error(`Gemini file start failed (${start.status})`);
  const url = start.headers.get('x-goog-upload-url');
  if (!url) throw new Error('Gemini upload URL missing.');
  const up = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Length': String(data.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize', 'Content-Type': mime },
    body: data
  });
  if (!up.ok) throw new Error(`Gemini file upload failed (${up.status})`);
  const info = await up.json();
  return await waitForFileReady(info.file);
}


async function waitForFileReady(file) {
  if (!file?.name || !file?.state) return file;
  let current = file;
  for (let attempt = 0; attempt < 20; attempt++) {
    const state = String(current.state?.name || current.state || '').toUpperCase();
    if (state === 'ACTIVE') return current;
    if (state && state !== 'PROCESSING') throw new Error(`Gemini file ${file.name} entered state ${state}.`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    const r = await fetch(`${BASE}/v1beta/${encodeURIComponent(file.name).replaceAll('%2F', '/') }?key=${encodeURIComponent(key())}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Gemini file status failed (${r.status}).`);
    current = await r.json();
  }
  throw new Error(`Gemini file ${file.name} was still processing after 60 seconds.`);
}

async function uploadFiles(items, limit = 4) {
  const result = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      result[i] = await uploadFile(items[i].path, items[i].mimeType);
    }
  });
  await Promise.all(workers);
  return result;
}

async function generate(contents, schema) {
  const r = await fetch(`${BASE}/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, thinkingConfig: { thinkingLevel: 'low' } } }),
    signal: AbortSignal.timeout(75_000)
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Gemini request failed (${r.status}): ${body.slice(0, 1200)}`);
  const j = JSON.parse(body);
  const text = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error('Gemini returned no editorial plan.');
  return JSON.parse(text);
}

export async function editorialPlan({ videoAssets, musicPath, voicePath, project, videoAnalysis, audioAnalysis, voiceAnalysis, instruction }) {
  if (!key()) return { available: false, reason: 'GEMINI_API_KEY is not configured.' };
  if (!Array.isArray(videoAssets) || !videoAssets.length) return { available: false, reason: 'No video assets available.' };
  if (videoAssets.length > MAX_GEMINI_ASSETS) return { available: false, reason: `Gemini input is limited to ${MAX_GEMINI_ASSETS} clips per request.` };

  const files = await uploadFiles([
    ...videoAssets.map(v => ({ path: v.path, mimeType: v.mimeType })),
    { path: musicPath, mimeType: audioAnalysis.mimeType }
  ], 4);
  let voiceFile = null;
  if (voicePath && voiceAnalysis) voiceFile = (await uploadFiles([{ path: voicePath, mimeType: voiceAnalysis.mimeType }], 1))[0];

  const assets = videoAnalysis.assets.map((a, i) => ({
    assetId: a.id,
    name: a.name,
    duration: a.duration,
    width: a.width,
    height: a.height,
    fps: a.fps,
    hasAudio: a.hasAudio,
    scenes: a.scenes.slice(0, 24).map(s => ({
      sourceKey: `${a.id}:${s.id}`,
      start: s.start,
      end: s.end,
      duration: s.duration,
      motion: s.motionScore,
      quality: s.qualityScore,
      composition: s.compositionScore,
      energy: s.energyScore,
      sharpness: s.sharpnessScore,
      brightness: s.brightnessScore,
      subjectX: s.subjectX
    }))
  }));
  const prompt = `You are CUTFLOW's editorial brain. You receive the actual user footage files and music. Build the strongest professional edit that matches the user's request.

Theme=${project.theme}; Aspect=${project.aspectRatio}; Requested target duration=${project.targetDuration || 'infer from user intent'} seconds; User intent=${instruction || 'Use the footage and music intelligently; make it professional.'}

Rules:
- Treat every uploaded clip as a distinct source asset. A sourceKey is assetId:sceneId.
- Choose only usable footage. Prefer visually strong, relevant, varied shots and avoid near-duplicates unless the user's intent calls for repetition.
- Match pacing to the music map. Do not cut on every beat; use musical phrases, builds and climaxes intelligently.
- For a 10-second montage with many tiny clips, select or combine enough distinct moments to fill the requested duration without filler.
- For a 27-second cinematic edit with 5-6 shots, favor longer cinematic holds, controlled transitions/effects and color consistency.
- Respect the exact target duration when it is explicitly requested, using the best available footage windows. Do not invent source material.
- Effects are optional and restrained. Normal cuts are preferred when an effect adds no editorial value.
- Captions may only be returned when real dialogue is audible in the supplied media. Never invent dialogue, words, names or facts.
- Text should only be included when clearly useful from the user's intent or supplied context; never fabricate facts.
- If the source clips contain usable original audio/voice, preserve it and mix it under the supplied music. The optional voice track is a separate vocal source if present.
- Return bounded JSON only. You do not render video or access arbitrary files.

Music map=${JSON.stringify(audioAnalysis)}
Voice metadata=${JSON.stringify(voiceAnalysis || null)}
Asset metadata=${JSON.stringify(assets)}`;

  const parts = [{ text: prompt }];
  for (let i = 0; i < files.length; i++) parts.push({ file_data: { mime_type: files[i].mime_type, file_uri: files[i].uri } });
  if (voiceFile) parts.push({ file_data: { mime_type: voiceFile.mime_type, file_uri: voiceFile.uri } });

  const plan = await generate([{ role: 'user', parts }], planSchema);
  return { available: true, plan, model: MODEL };
}

export async function commandPlan({ timeline, command, project }) {
  if (!key()) return { available: false, reason: 'GEMINI_API_KEY is not configured.' };
  const plan = await generate([{ role: 'user', parts: [{ text: `Modify the EXISTING CUTFLOW timeline only where necessary.
User command: ${command}
Project: ${JSON.stringify(project)}
Existing timeline: ${JSON.stringify(timeline)}
Return only bounded operations. Preserve unrelated clips and structure. If the user requests a duration, use setTargetDuration. If they request a tone/theme, use setTheme. Never invent captions or footage.` }] }], commandSchema);
  return { available: true, modification: plan, model: MODEL };
}

export async function healthProbe() {
  if (!key()) return { available: false, model: MODEL };
  try {
    const r = await fetch(`${BASE}/v1beta/models/${MODEL}?key=${encodeURIComponent(key())}`, { signal: AbortSignal.timeout(8_000) });
    return r.ok ? { available: true, model: MODEL } : { available: false, model: MODEL, error: `HTTP ${r.status}` };
  } catch (e) { return { available: false, model: MODEL, error: e.message }; }
}
