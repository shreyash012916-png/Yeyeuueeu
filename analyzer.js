import path from 'node:path';
import { ffprobe, detectScenes, analyzeAudio, sampleVideoMetrics } from './ffmpeg.js';

const MAX_SECONDS = 240;
const MAX_VIDEO_ASSETS = 40;

export async function analyzeMedia(videoAssets, audioPath, voicePath = null, progress = () => {}) {
  const assets = Array.isArray(videoAssets) ? videoAssets : [videoAssets];
  if (!assets.length) throw new Error('Upload at least one video clip.');
  if (assets.length > MAX_VIDEO_ASSETS) throw new Error(`A project can contain up to ${MAX_VIDEO_ASSETS} video clips.`);

  progress(10, 'Validating uploaded media');
  const [videoAnalyses, musicProbe, voiceProbe] = await Promise.all([
    mapLimit(assets, 4, async (asset, index) => analyzeVideoAsset(asset, index, assets.length, progress)),
    ffprobe(audioPath),
    voicePath ? ffprobe(voicePath) : null
  ]);

  const musicDuration = Number(musicProbe.format?.duration || 0);
  if (!musicDuration || musicDuration < 0.5 || musicDuration > MAX_SECONDS) {
    throw new Error('Background music must be between 0.5 seconds and 4 minutes (240 seconds).');
  }
  if (voiceProbe) {
    const voiceDuration = Number(voiceProbe.format?.duration || 0);
    if (!voiceDuration || voiceDuration > MAX_SECONDS) throw new Error('Voice track must be between 0.5 seconds and 4 minutes (240 seconds).');
  }

  progress(42, 'Analyzing music rhythm and energy');
  const audio = await analyzeAudio(audioPath, musicDuration);
  progress(45, voicePath ? 'Audio mix tracks validated' : 'Music map ready');

  const totalVideoDuration = videoAnalyses.reduce((sum, a) => sum + a.duration, 0);
  return {
    video: {
      duration: Number(totalVideoDuration.toFixed(3)),
      assets: videoAnalyses,
      assetCount: videoAnalyses.length
    },
    audio: {
      duration: musicDuration,
      mimeType: mime(audioPath),
      ...audio
    },
    voice: voiceProbe ? {
      duration: Number(voiceProbe.format?.duration || 0),
      mimeType: mime(voicePath)
    } : null
  };
}

async function analyzeVideoAsset(asset, index, totalAssets, progress) {
  const probe = await ffprobe(asset.path);
  const vs = probe.streams.find(s => s.codec_type === 'video');
  if (!vs) throw new Error(`Video clip ${index + 1} contains no video stream.`);
  const duration = Number(probe.format?.duration || vs.duration || 0);
  if (!duration || duration < 0.15 || duration > MAX_SECONDS) throw new Error(`Video clip ${index + 1} must be between 0.15 seconds and 4 minutes.`);

  const shouldDetectScenes = duration >= 3.2;
  const [scenes, metrics] = await Promise.all([
    shouldDetectScenes ? detectScenes(asset.path, duration) : Promise.resolve([{ id: 'shot-1', start: 0, end: duration, duration }]),
    sampleVideoMetrics(asset.path, duration)
  ]);
  const enriched = scenes.map((scene, sceneIndex) => ({
    ...scene,
    assetId: asset.id,
    assetName: asset.name,
    ...aggregateSceneMetrics(scene, metrics, sceneIndex)
  }));

  progress(18 + Math.round(((index + 1) / Math.max(1, totalAssets)) * 18), `Measured clip ${index + 1}/${totalAssets}`);
  return {
    id: asset.id,
    name: asset.name,
    path: asset.path,
    mimeType: mime(asset.path),
    duration,
    width: Number(vs.width || 1920),
    height: Number(vs.height || 1080),
    fps: fps(vs.r_frame_rate),
    hasAudio: probe.streams.some(s => s.codec_type === 'audio'),
    scenes: enriched
  };
}

function aggregateSceneMetrics(scene, metrics, index) {
  const rows = metrics.filter(m => m.t >= scene.start && m.t < scene.end + 0.001);
  if (!rows.length) {
    return { motionScore: 0.35, compositionScore: 0.5, qualityScore: 0.5, subjectScore: 0.5, energyScore: 0.5, brightnessScore: 0.5, sharpnessScore: 0.5, subjectX: 0.5 };
  }
  const avg = key => rows.reduce((sum, r) => sum + Number(r[key] || 0), 0) / rows.length;
  const brightness = clamp01(avg('brightnessScore'));
  const sharpness = clamp01(avg('sharpnessScore'));
  const motion = clamp01(avg('motionScore'));
  const quality = clamp01(sharpness * 0.58 + exposureQuality(brightness) * 0.42);
  const energy = clamp01(motion * 0.62 + avg('energyScore') * 0.38);
  return {
    motionScore: Number(motion.toFixed(3)),
    compositionScore: Number((0.6 * sharpness + 0.4 * exposureQuality(brightness)).toFixed(3)),
    qualityScore: Number(quality.toFixed(3)),
    subjectScore: Number((0.5 + 0.5 * sharpness).toFixed(3)),
    energyScore: Number(energy.toFixed(3)),
    brightnessScore: Number(brightness.toFixed(3)),
    sharpnessScore: Number(sharpness.toFixed(3)),
    subjectX: Number(avg('subjectX').toFixed(3)),
    metricSamples: rows.length,
    metricIndex: index
  };
}

function exposureQuality(v) {
  return clamp01(1 - Math.abs(v - 0.52) * 1.85);
}

function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
function fps(s) { const [a, b] = String(s || '30/1').split('/').map(Number); return b ? Number((a / b).toFixed(3)) : 30; }
function mime(p) {
  const e = path.extname(p).toLowerCase();
  return e === '.mp4' ? 'video/mp4' : e === '.mov' ? 'video/quicktime' : e === '.webm' ? 'video/webm' : e === '.m4a' ? 'audio/mp4' : e === '.wav' ? 'audio/wav' : e === '.ogg' ? 'audio/ogg' : e === '.aac' ? 'audio/aac' : e === '.mp3' ? 'audio/mpeg' : 'application/octet-stream';
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
