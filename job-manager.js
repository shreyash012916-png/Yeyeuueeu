import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProjectDir, projectDir, writeJson, size, folderSize } from './storage-store.js';
import { analyzeMedia } from './analyzer.js';
import { editorialPlan, commandPlan, MODEL, geminiAvailable } from './gemini.js';
import { normalizeTimeline, applyCommand, applyUserIntent, rebuildDerived, parseTargetDuration } from './timeline.js';
import { renderTimeline, ffprobe } from './ffmpeg.js';

const projects = new Map();
const listeners = new Map();
const MAX_ASSETS = 40;
const MAX_PROJECT_BYTES = (Number(process.env.MAX_PROJECT_MB) || 2048) * 1024 * 1024;

export function getProject(id) {
  const p = projects.get(id);
  if (!p) throw Object.assign(new Error('Project not found.'), { status: 404 });
  return p;
}

function emit(id, payload) {
  for (const res of listeners.get(id) || []) {
    try { res.write(`event: update\ndata: ${JSON.stringify(payload)}\n\n`); } catch {}
  }
}

export function subscribe(id, res) {
  if (!listeners.has(id)) listeners.set(id, []);
  listeners.get(id).push(res);
  res.on('close', () => listeners.set(id, (listeners.get(id) || []).filter(x => x !== res)));
}

export async function createProject({ theme, instruction, aspectRatio, targetDuration }) {
  const id = randomUUID();
  const dir = await createProjectDir(id);
  const p = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    theme: validTheme(theme),
    instruction: String(instruction || '').slice(0, 1200),
    aspectRatio: ['9:16', '1:1', '16:9'].includes(aspectRatio) ? aspectRatio : '9:16',
    targetDuration: Number(targetDuration) > 0 ? Math.min(240, Number(targetDuration)) : parseTargetDuration(instruction || ''),
    status: 'uploaded',
    progress: { percent: 0, label: 'Upload ready', indeterminate: false },
    ai: initialAI(),
    render: { phase: 'idle', currentClip: 0, totalClips: 0, fraction: 0 },
    videos: [],
    music: null,
    voice: null,
    versions: [],
    currentVersionId: null,
    timeline: null,
    analysis: null,
    qc: null,
    output: null,
    error: null,
    dir
  };
  projects.set(id, p);
  await persist(p);
  return p;
}

export async function saveVideoUpload(id, assetId, sourceStream, filename, contentLength) {
  const p = getProject(id);
  if (p.videos.length >= MAX_ASSETS) throw Object.assign(new Error(`A project can contain up to ${MAX_ASSETS} video clips.`), { status: 413 });
  await assertProjectCapacity(p, contentLength);
  const safe = safeName(filename);
  const idSafe = safeName(assetId || `clip-${p.videos.length + 1}`);
  const out = path.join(projectDir(id), `video-${idSafe}-${safe}`);
  await streamToFile(sourceStream, out);
  const asset = { id: assetId || randomUUID(), path: out, name: filename, mimeType: guessMime(filename) };
  p.videos.push(asset);
  p.updatedAt = new Date().toISOString();
  await persist(p);
  return p;
}

export async function saveUpload(id, type, sourceStream, filename, contentLength) {
  const p = getProject(id);
  if (type === 'video') return saveVideoUpload(id, `asset-${p.videos.length + 1}`, sourceStream, filename, contentLength);
  if (!['music', 'voice'].includes(type)) throw Object.assign(new Error('Unsupported upload type.'), { status: 400 });
  await assertProjectCapacity(p, contentLength);
  const safe = safeName(filename);
  const out = path.join(projectDir(id), `${type}-${safe}`);
  await streamToFile(sourceStream, out);
  p[type] = { path: out, name: filename, mimeType: guessMime(filename) };
  p.updatedAt = new Date().toISOString();
  await persist(p);
  return p;
}

async function assertProjectCapacity(p, contentLength) {
  const incoming = Number(contentLength) || 0;
  if (incoming > (Number(process.env.MAX_UPLOAD_MB) || 500) * 1024 * 1024) throw Object.assign(new Error('Upload exceeds the configured per-file limit.'), { status: 413 });
  const current = await folderSize(p.dir);
  if (current + incoming > MAX_PROJECT_BYTES) throw Object.assign(new Error(`Project storage limit exceeded (${Math.round(MAX_PROJECT_BYTES / 1048576)} MB).`), { status: 413 });
}

async function streamToFile(sourceStream, out) {
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(out);
    sourceStream.pipe(w);
    sourceStream.on('error', reject);
    w.on('error', reject);
    w.on('finish', resolve);
  });
}

export async function startCreate(id) {
  const p = getProject(id);
  if (!p.videos.length || !p.music) throw Object.assign(new Error('Upload at least one video clip and a background music track before creating the edit.'), { status: 409 });
  if (p.status === 'processing') return p;
  p.status = 'processing';
  p.error = null;
  p.output = null;
  p.ai = initialAI();
  p.render = { phase: 'analysis', currentClip: 0, totalClips: 0, fraction: 0 };
  p.progress = { percent: 3, label: 'Starting autonomous edit', indeterminate: false };
  emit(id, snapshotEvent(p));
  await persist(p);
  processEdit(p).catch(async e => failProject(p, e));
  return p;
}

async function processEdit(p) {
  const set = async (percent, label, extras = {}) => {
    p.progress = { percent, label, indeterminate: Boolean(extras.indeterminate) };
    if (extras.render) p.render = { ...p.render, ...extras.render };
    emit(p.id, snapshotEvent(p));
    await persist(p);
  };

  await set(8, `Validating ${p.videos.length} clip${p.videos.length === 1 ? '' : 's'} + audio`);
  const analysis = await analyzeMedia(p.videos, p.music.path, p.voice?.path || null, (pc, label) => {
    p.progress = { percent: pc, label, indeterminate: false };
    emit(p.id, snapshotEvent(p));
  });
  p.analysis = analysis;
  await persist(p);

  if (p.targetDuration > 0) p.targetDuration = Math.min(240, p.targetDuration);
  const baseProject = { theme: p.theme, aspectRatio: p.aspectRatio, targetDuration: p.targetDuration || 0 };
  p.ai = geminiAvailable() ? { status: 'requesting', available: true, configured: true, model: MODEL, message: `Gemini 3.8 Flash is reviewing ${analysis.video.assetCount} source clips and the music.` } : { status: 'offline', available: false, configured: false, model: MODEL, message: 'Gemini is not configured; deterministic local editorial intelligence is active.' };
  p.render = { phase: 'editorial-planning', currentClip: 0, totalClips: 0, fraction: 0 };
  emit(p.id, { status: p.status, progress: { percent: 46, label: geminiAvailable() ? 'Gemini 3.8 Flash · analyzing edit intent' : 'Local editorial intelligence · planning', indeterminate: !geminiAvailable() }, ai: publicAI(p.ai), render: p.render });

  let ai = { available: false };
  try {
    ai = await editorialPlan({
      videoAssets: p.videos,
      musicPath: p.music.path,
      voicePath: p.voice?.path || null,
      project: baseProject,
      videoAnalysis: analysis.video,
      audioAnalysis: analysis.audio,
      voiceAnalysis: analysis.voice,
      instruction: p.instruction
    });
  } catch (e) { ai = { available: false, reason: e.message }; }

  p.ai = ai.available
    ? { status: 'active', available: true, configured: true, model: ai.model || MODEL, message: 'Gemini returned a structured clip-selection and editorial plan.' }
    : { status: geminiAvailable() ? 'error' : 'offline', available: false, configured: geminiAvailable(), model: MODEL, message: ai.reason || 'Local editorial intelligence remains active.' };

  const raw = ai.plan || {};
  p.timeline = normalizeTimeline(raw, analysis, {
    theme: p.theme,
    aspectRatio: p.aspectRatio,
    instruction: p.instruction,
    targetDuration: p.targetDuration || null
  });
  p.render = { phase: 'timeline-built', currentClip: 0, totalClips: p.timeline.clips.length, fraction: 0 };
  await set(58, `${ai.available ? 'Gemini' : 'Local'} plan locked · ${p.timeline.clips.length} clips selected`);

  const v = {
    id: `v-${Date.now()}-${randomUUID().slice(0, 6)}`,
    label: 'v1',
    createdAt: new Date().toISOString(),
    reason: ai.available ? 'Gemini editorial plan + deterministic render' : 'Local editorial plan + deterministic render',
    aiAvailable: Boolean(ai.available),
    timeline: structuredClone(p.timeline)
  };
  p.currentVersionId = v.id;
  p.versions = [v];

  await set(63, 'Applying professional polish', { render: { phase: 'preparing-render', currentClip: 0, totalClips: p.timeline.clips.length, fraction: 0 } });
  p.qc = qc(p.timeline);
  if (!p.qc.pass) {
    p.timeline = polish(p.timeline);
    v.timeline = structuredClone(p.timeline);
    v.reason += ' + QC correction';
    p.qc = qc(p.timeline);
  }
  await persist(p);

  const out = path.join(p.dir, 'cutflow-final.mp4');
  const probe = await renderTimeline({
    assets: p.analysis.video.assets,
    musicPath: p.music.path,
    voicePath: p.voice?.path || null,
    timeline: p.timeline,
    outputPath: out,
    tmpDir: p.dir,
    onProgress: (pc, label, extra) => {
      p.progress = { percent: pc, label, indeterminate: false };
      p.render = extra.render || p.render;
      emit(p.id, snapshotEvent(p));
    }
  });
  p.output = { path: out, duration: Number(probe.format?.duration || 0), size: await size(out), valid: hasAV(probe) };
  p.render = { ...p.render, phase: 'validation' };
  await set(98, 'Final validation');
  validateFinalOutput(p);
  p.status = 'complete';
  p.progress = { percent: 100, label: 'Edit complete', indeterminate: false };
  p.render = { ...p.render, phase: 'complete', fraction: 1 };
  await persist(p);
  emit(p.id, snapshotEvent(p));
}

export async function runCommand(id, command) {
  const p = getProject(id);
  if (!p.timeline) throw Object.assign(new Error('Create an edit before using the command bar.'), { status: 409 });
  if (!command) throw Object.assign(new Error('Enter an edit command.'), { status: 400 });
  if (p.status === 'processing') throw Object.assign(new Error('CUTFLOW is already rendering. Wait for the current version to finish.'), { status: 409 });

  p.status = 'processing';
  p.error = null;
  p.ai = geminiAvailable() ? { status: 'requesting', available: true, configured: true, model: MODEL, message: 'Gemini is interpreting your command against the current timeline.' } : { status: 'offline', available: false, configured: false, model: MODEL, message: 'Gemini unavailable; using the local timeline command interpreter.' };
  p.progress = { percent: 48, label: geminiAvailable() ? 'Gemini 3.8 Flash · modifying current edit' : 'Local editorial command · modifying current edit', indeterminate: !geminiAvailable() };
  emit(id, snapshotEvent(p));

  let ai = { available: false };
  try { ai = await commandPlan({ timeline: p.timeline, command, project: { theme: p.theme, aspectRatio: p.aspectRatio, targetDuration: p.timeline.project.requestedDuration } }); }
  catch (e) { ai = { available: false, reason: e.message }; }

  p.ai = ai.available
    ? { status: 'active', available: true, configured: true, model: ai.model || MODEL, message: 'Gemini returned a targeted modification plan.' }
    : { status: geminiAvailable() ? 'error' : 'offline', available: false, configured: geminiAvailable(), model: MODEL, message: ai.reason || 'Local command interpreter used.' };

  let next = ai.available ? applyOperations(p.timeline, ai.modification.operations || []) : applyCommand(p.timeline, command);
  if (ai.available && hasExplicitGuardrail(command)) next = applyUserIntent(next, command);
  rebuildDerived(next);
  p.timeline = next;

  const v = {
    id: `v-${Date.now()}-${randomUUID().slice(0, 6)}`,
    label: `v${p.versions.length + 1}`,
    createdAt: new Date().toISOString(),
    reason: command,
    aiAvailable: Boolean(ai.available),
    timeline: structuredClone(p.timeline)
  };
  p.currentVersionId = v.id;
  p.versions.push(v);
  p.render = { phase: 'rendering', currentClip: 0, totalClips: p.timeline.clips.length, fraction: 0 };
  emit(id, { status: p.status, progress: { percent: 60, label: 'Timeline updated · rendering new version', indeterminate: false }, ai: publicAI(p.ai), render: p.render, timeline: lightweightTimeline(p.timeline) });

  const out = path.join(p.dir, `cutflow-${v.id}.mp4`);
  try {
    const probe = await renderTimeline({
      assets: p.analysis.video.assets,
      musicPath: p.music.path,
      voicePath: p.voice?.path || null,
      timeline: p.timeline,
      outputPath: out,
      tmpDir: p.dir,
      onProgress: (pc, label, extra) => {
        p.progress = { percent: Math.max(60, pc), label, indeterminate: false };
        p.render = extra.render || p.render;
        emit(p.id, snapshotEvent(p));
      }
    });
    p.output = { path: out, duration: Number(probe.format?.duration || 0), size: await size(out), valid: hasAV(probe) };
    validateFinalOutput(p);
    p.status = 'complete';
    p.progress = { percent: 100, label: `${v.label} complete`, indeterminate: false };
    p.render = { ...p.render, phase: 'complete', fraction: 1 };
    await persist(p);
    emit(id, snapshotEvent(p));
    return p;
  } catch (e) {
    await failProject(p, e);
    throw e;
  }
}

function applyOperations(t, ops) {
  const o = structuredClone(t);
  for (const op of ops) {
    const idxs = Array.isArray(op.clipIndexes) ? op.clipIndexes : o.clips.map((_, i) => i);
    if (op.op === 'removeEffects') idxs.forEach(i => { if (o.clips[i]) o.clips[i].effects = []; });
    if (op.op === 'addEffect' && op.value) idxs.forEach(i => { if (o.clips[i] && isEffect(op.value)) o.clips[i].effects = [{ id: op.value, duration: .25, intensity: .16 }]; });
    if (op.op === 'setSpeed' && Number.isFinite(op.number)) idxs.forEach(i => { if (o.clips[i]) o.clips[i].speed = Math.max(.5, Math.min(1.8, op.number)); });
    if (op.op === 'setTheme' && op.value && ['cinematic','hype','clean','luxury','travel','sports','emotional','documentary'].includes(op.value)) { o.project.theme = op.value; }
    if (op.op === 'setCaptionSize') o.captions = o.captions.map(c => ({ ...c, style: { ...(c.style || {}), fontSize: op.value || 'small' } }));
    if (op.op === 'setTargetDuration' && Number.isFinite(op.number)) o.project.requestedDuration = Math.max(.5, Math.min(240, op.number));
    if (op.op === 'setAudioMix' && Number.isFinite(op.number)) o.music.musicVolume = Math.max(0, Math.min(.9, op.number));
  }
  return o;
}

function isEffect(id) { return ['punch-zoom','smooth-zoom','impact-shake','flash','glitch','film-grain','vignette','fade'].includes(id); }

export async function restoreVersion(id, vid) {
  const p = getProject(id), v = p.versions.find(x => x.id === vid);
  if (!v) throw Object.assign(new Error('Version not found.'), { status: 404 });
  p.timeline = structuredClone(v.timeline);
  p.currentVersionId = v.id;
  p.status = 'complete';
  p.progress = { percent: 100, label: `${v.label} restored`, indeterminate: false };
  await persist(p);
  emit(id, snapshotEvent(p));
  return p;
}

function qc(t) {
  const effectCount = t.effects?.length || 0;
  const clips = t.clips?.length || 0;
  const issues = [];
  if (!clips) issues.push('no clips');
  if (effectCount > Math.max(8, clips * .38)) issues.push('effect density high');
  if (!t.project?.duration || t.project.duration < 0.5) issues.push('duration too short');
  if (t.project.duration > 240.01) issues.push('timeline exceeds 4 minute limit');
  if (clips > 1 && effectCount / clips > .75) issues.push('too many clips carry effects');
  return { pass: !issues.length, issues, metrics: { clipCount: clips, effectCount, duration: t.project.duration, effectDensity: Number((effectCount / Math.max(1, clips)).toFixed(2)) } };
}

function polish(t) {
  const o = structuredClone(t);
  o.clips = o.clips.map(c => ({ ...c, effects: (c.effects || []).slice(0, 1) }));
  rebuildDerived(o);
  return o;
}

function validateFinalOutput(p) {
  const duration = Number(p.output?.duration || 0);
  if (!p.output?.valid) throw new Error('Final validation failed: output does not contain both video and audio streams.');
  if (duration < 0.5) throw new Error('Final validation failed: rendered video is too short.');
  if (duration > 240.5) throw new Error('Final validation failed: output exceeds the 4-minute maximum.');
  const target = Number(p.timeline?.project?.duration || 0);
  if (target > 0 && Math.abs(duration - target) > Math.max(.35, target * .08)) throw new Error(`Final validation failed: expected about ${target.toFixed(2)}s, got ${duration.toFixed(2)}s.`);
}

async function failProject(p, e) {
  p.status = 'error';
  p.error = e.message || 'Processing failed.';
  p.progress = { percent: 100, label: 'Edit failed', indeterminate: false };
  p.render = { ...p.render, phase: 'error' };
  if (p.ai?.status === 'requesting') p.ai = { ...p.ai, status: 'error', message: e.message || 'AI request failed.' };
  await persist(p);
  emit(p.id, snapshotEvent(p));
}

function hasExplicitGuardrail(command) { return /no glitch|don't use glitch|do not use glitch|no shake|don't use shake|do not use shake|fewer effects|less effects|remove flashy|keep original audio|music quieter|lower music|duck the music/i.test(command); }
function hasAV(probe) { return Boolean(probe.streams?.some(s => s.codec_type === 'video') && probe.streams?.some(s => s.codec_type === 'audio')); }
function initialAI() { return { status: geminiAvailable() ? 'ready' : 'offline', available: geminiAvailable(), configured: geminiAvailable(), model: MODEL, message: geminiAvailable() ? 'Gemini is configured; it will be called when editing starts.' : 'GEMINI_API_KEY is not configured.' }; }
function publicAI(ai) { return ai ? { status: ai.status, available: Boolean(ai.available), configured: Boolean(ai.configured), model: ai.model || MODEL, message: ai.message || '' } : null; }
function lightweightTimeline(t) { return t ? { project: t.project, music: t.music, clips: t.clips, captions: t.captions, effects: t.effects, transitions: t.transitions } : null; }
function snapshotEvent(p) { return { status: p.status, progress: p.progress, ai: publicAI(p.ai), render: p.render, timeline: p.timeline ? lightweightTimeline(p.timeline) : null, output: p.output ? publicOutput(p.output) : null, error: p.error || null }; }
async function persist(p) { p.updatedAt = new Date().toISOString(); await writeJson(p.id, 'project.json', publicProject(p)); }
function publicOutput(o) { return o ? { duration: o.duration, size: o.size, valid: o.valid } : null; }

export function publicProject(p) {
  return {
    id: p.id,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    theme: p.theme,
    instruction: p.instruction,
    aspectRatio: p.aspectRatio,
    targetDuration: p.targetDuration || null,
    status: p.status,
    progress: p.progress,
    ai: publicAI(p.ai),
    render: p.render,
    videos: (p.videos || []).map(v => ({ id: v.id, name: v.name, mimeType: v.mimeType })),
    music: p.music?.name || null,
    voice: p.voice?.name || null,
    analysis: publicAnalysis(p.analysis),
    currentVersionId: p.currentVersionId,
    versions: (p.versions || []).map(v => ({ id: v.id, label: v.label, createdAt: v.createdAt, reason: v.reason, aiAvailable: v.aiAvailable, clipCount: v.timeline?.clips?.length || 0, effectCount: v.timeline?.effects?.length || 0, duration: v.timeline?.project?.duration || 0 })),
    timeline: p.timeline,
    qc: p.qc,
    output: publicOutput(p.output),
    error: p.error
  };
}


function publicAnalysis(a) {
  if (!a) return null;
  return {
    video: {
      duration: a.video?.duration || 0,
      assetCount: a.video?.assetCount || 0,
      assets: (a.video?.assets || []).map(v => ({
        id: v.id, name: v.name, mimeType: v.mimeType, duration: v.duration, width: v.width, height: v.height, fps: v.fps, hasAudio: v.hasAudio,
        scenes: (v.scenes || []).map(s => ({ id: s.id, assetId: s.assetId, assetName: s.assetName, start: s.start, end: s.end, duration: s.duration, motionScore: s.motionScore, qualityScore: s.qualityScore, compositionScore: s.compositionScore, subjectScore: s.subjectScore, energyScore: s.energyScore, brightnessScore: s.brightnessScore, sharpnessScore: s.sharpnessScore, subjectX: s.subjectX, metricSamples: s.metricSamples }))
      }))
    },
    audio: a.audio ? { duration: a.audio.duration, mimeType: a.audio.mimeType, bpm: a.audio.bpm, onsetCount: a.audio.onsetCount, beatPositions: a.audio.beatPositions, onsetPositions: a.audio.onsetPositions, sections: a.audio.sections, energyMean: a.audio.energyMean, energyMedian: a.audio.energyMedian } : null,
    voice: a.voice ? { duration: a.voice.duration, mimeType: a.voice.mimeType } : null
  };
}

function validTheme(theme) { return ['cinematic','hype','clean','luxury','travel','sports','emotional','documentary'].includes(theme) ? theme : 'cinematic'; }
function safeName(name) { return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120); }
function guessMime(name) {
  const e = path.extname(String(name || '')).toLowerCase();
  return e === '.mp4' ? 'video/mp4' : e === '.mov' ? 'video/quicktime' : e === '.webm' ? 'video/webm' : e === '.m4a' ? 'audio/mp4' : e === '.wav' ? 'audio/wav' : e === '.ogg' ? 'audio/ogg' : e === '.aac' ? 'audio/aac' : e === '.mp3' ? 'audio/mpeg' : 'application/octet-stream';
}
