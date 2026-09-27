import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';

export async function run(cmd, args, { encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', code => {
      const stdout = Buffer.concat(out).toString(encoding);
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`FFmpeg process failed (${code}): ${stderr.slice(-6000)}\nCOMMAND: ${cmd} ${args.join(' ')}`), { code, stdout, stderr, cmd, args }));
    });
  });
}

export async function runRaw(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', code => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) resolve({ buffer: Buffer.concat(out), stderr });
      else reject(Object.assign(new Error(`FFmpeg process failed (${code}): ${stderr.slice(-6000)}`), { code, stderr }));
    });
  });
}

export async function ffprobe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
  return JSON.parse(stdout);
}

export async function detectScenes(file, duration) {
  let stderr = '';
  try {
    ({ stderr } = await run(FFMPEG, [
      '-hide_banner', '-i', file,
      '-vf', "scale=320:-2,select='gt(scene,0.30)',showinfo",
      '-an', '-f', 'null', '-'
    ]));
  } catch (e) { stderr = e.stderr || ''; }
  const times = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map(m => Number(m[1])).filter(Number.isFinite);
  const cuts = [...new Set([0, ...times.filter(t => t > 0.15 && t < duration - 0.15)])].sort((a, b) => a - b);
  const scenes = [];
  for (let i = 0; i < cuts.length; i++) {
    const start = cuts[i], end = i + 1 < cuts.length ? cuts[i + 1] : duration;
    if (end - start >= 0.35) scenes.push({ id: `shot-${i + 1}`, start, end, duration: end - start });
  }
  return scenes.length ? scenes : [{ id: 'shot-1', start: 0, end: duration, duration }];
}

export async function sampleVideoMetrics(file, duration) {
  const fps = duration < 5 ? 3 : 2;
  const width = 128, height = 72, frameSize = width * height;
  const { buffer } = await runRaw(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `fps=${fps},scale=${width}:${height},format=gray`,
    '-an', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'
  ]);
  const rows = [];
  let previous = null;
  const totalFrames = Math.min(Math.ceil(duration * fps), Math.floor(buffer.length / frameSize));
  for (let n = 0; n < totalFrames; n++) {
    const frame = buffer.subarray(n * frameSize, (n + 1) * frameSize);
    let sum = 0, edgeSum = 0, diffSum = 0, weightedX = 0, edgeWeight = 0;
    for (let y = 1; y < height; y++) {
      const row = y * width, prevRow = (y - 1) * width;
      for (let x = 1; x < width; x++) {
        const v = frame[row + x];
        sum += v;
        const gx = Math.abs(v - frame[row + x - 1]), gy = Math.abs(v - frame[prevRow + x]);
        const edge = gx + gy;
        edgeSum += edge; weightedX += x * edge; edgeWeight += edge;
        if (previous) diffSum += Math.abs(v - previous[row + x]);
      }
    }
    const pixels = (width - 1) * (height - 1);
    const brightness = sum / (width * height * 255);
    const sharpness = Math.min(1, (edgeSum / pixels) / 75);
    const motion = previous ? Math.min(1, (diffSum / pixels) / 46) : 0;
    const subjectX = edgeWeight > 0 ? weightedX / edgeWeight / width : 0.5;
    rows.push({
      t: n / fps,
      brightnessScore: brightness,
      sharpnessScore: sharpness,
      motionScore: motion,
      energyScore: Math.min(1, 0.20 + brightness * 0.30 + motion * 0.50),
      subjectX: Math.max(0.08, Math.min(0.92, subjectX))
    });
    previous = frame;
  }
  return rows;
}

export async function analyzeAudio(file, duration) {
  const rate = 11025;
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'], { encoding: 'latin1' });
  const buf = Buffer.from(stdout, 'latin1');
  const n = Math.floor(buf.length / 2), frame = 1024, hop = 512, energy = [];
  for (let i = 0; i + frame < n; i += hop) {
    let s = 0;
    for (let j = 0; j < frame; j++) { const x = buf.readInt16LE((i + j) * 2) / 32768; s += x * x; }
    energy.push({ t: i / rate, e: Math.sqrt(s / frame) });
  }
  const mean = energy.reduce((a, b) => a + b.e, 0) / Math.max(1, energy.length);
  const peaks = [];
  for (let i = 1; i < energy.length - 1; i++) if (energy[i].e > energy[i - 1].e && energy[i].e >= energy[i + 1].e && energy[i].e > mean * 1.45) peaks.push(energy[i].t);
  const diffs = [];
  for (let i = 1; i < peaks.length; i++) { const d = peaks[i] - peaks[i - 1]; if (d >= 0.20 && d <= 1.25) diffs.push(d); }
  diffs.sort((a, b) => a - b);
  const median = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0.5;
  let bpm = Math.round(Math.max(70, Math.min(180, 60 / median)));
  if (!Number.isFinite(bpm)) bpm = 120;
  const beat = 60 / bpm, beats = [];
  for (let t = 0; t < duration; t += beat) beats.push(Number(t.toFixed(3)));
  const energies = energy.length ? energy.map(x => x.e) : [0];
  const sorted = [...energies].sort((a, b) => a - b);
  const medianEnergy = sorted[Math.floor(sorted.length / 2)] || 0;
  const sectionBounds = [0, duration * 0.25, duration * 0.55, duration * 0.82, duration];
  return {
    bpm,
    beatPositions: beats,
    onsetPositions: peaks,
    onsetCount: peaks.length,
    energyMean: Number(mean.toFixed(4)),
    energyMedian: Number(medianEnergy.toFixed(4)),
    sections: [
      { name: 'intro', start: Number(sectionBounds[0].toFixed(2)), end: Number(sectionBounds[1].toFixed(2)), energy: 'low' },
      { name: 'verse', start: Number(sectionBounds[1].toFixed(2)), end: Number(sectionBounds[2].toFixed(2)), energy: 'steady' },
      { name: 'build', start: Number(sectionBounds[2].toFixed(2)), end: Number(sectionBounds[3].toFixed(2)), energy: 'rising' },
      { name: 'climax', start: Number(sectionBounds[3].toFixed(2)), end: Number(sectionBounds[4].toFixed(2)), energy: 'high' }
    ]
  };
}

function filterPathSafe(p) {
  return String(p).replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'");
}

function clipScaleCrop(vs, outW, outH, cropX = 0.5, zoom = 1, shake = false) {
  const inputRatio = (Number(vs.width) || outW) / (Number(vs.height) || outH);
  const outRatio = outW / outH;
  const cx = Math.max(0.08, Math.min(0.92, cropX));
  const jitterX = shake ? '+7*sin(74*t)' : '';
  const jitterY = shake ? '+5*sin(57*t)' : '';
  if (inputRatio > outRatio) {
    const h = Math.round(outH * zoom);
    return [`scale=-2:${h}`, `crop=${outW}:${outH}:min(max((iw-${outW})*${cx}${jitterX}\\,0)\\,iw-${outW}):min(max((ih-${outH})/2${jitterY}\\,0)\\,ih-${outH})`];
  }
  const w = Math.round(outW * zoom);
  return [`scale=${w}:-2`, `crop=${outW}:${outH}:min(max((iw-${outW})/2${jitterX}\\,0)\\,iw-${outW}):min(max((ih-${outH})*${cx}${jitterY}\\,0)\\,ih-${outH})`];
}

export async function renderTimeline({ assets, musicPath, voicePath = null, timeline, outputPath, tmpDir, onProgress = () => {} }) {
  if (!Array.isArray(assets) || !assets.length) throw new Error('No source video assets available.');
  const assetMap = new Map(assets.map(a => [a.id, a]));
  const [outW, outH] = timeline.project.aspectRatio === '9:16' ? [1080, 1920] : timeline.project.aspectRatio === '1:1' ? [1080, 1080] : [1920, 1080];
  if (!Array.isArray(timeline.clips) || !timeline.clips.length) throw new Error('Timeline contains no clips.');

  const finalDuration = Number(Math.min(240, Math.max(0.5, timeline.project.duration)).toFixed(3));
  const totalClips = timeline.clips.length;
  const [workW, workH] = outW >= outH ? [1280, 720] : [720, 1280];
  const ffArgs = ['-y', '-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:2'];
  const graph = [];
  const audioLabels = [];
  const videoLabels = [];

  for (let i = 0; i < totalClips; i++) {
    const c = timeline.clips[i];
    const asset = assetMap.get(c.sourceAssetId);
    if (!asset) throw new Error(`Source asset not found for ${c.id}: ${c.sourceAssetId}`);
    const speed = Math.max(0.5, Math.min(1.8, Number(c.speed) || 1));
    ffArgs.push('-ss', String(Math.max(0, c.sourceStart)), '-t', String(Math.max(0.05, c.sourceDuration)), '-i', asset.path);
  }
  ffArgs.push('-stream_loop', '-1', '-t', String(finalDuration), '-i', musicPath);
  const musicInputIndex = totalClips;
  let voiceInputIndex = null;
  if (voicePath) { ffArgs.push('-stream_loop', '-1', '-t', String(finalDuration), '-i', voicePath); voiceInputIndex = totalClips + 1; }

  for (let i = 0; i < totalClips; i++) {
    const c = timeline.clips[i];
    const asset = assetMap.get(c.sourceAssetId);
    if (!asset) throw new Error(`Source asset not found for ${c.id}: ${c.sourceAssetId}`);
    const speed = Math.max(0.5, Math.min(1.8, Number(c.speed) || 1));
    const ids = new Set((c.effects || []).map(e => e.id));
    const zoom = ids.has('punch-zoom') ? 1.07 : ids.has('smooth-zoom') || ids.has('impact-shake') ? 1.035 : 1;
    const shake = ids.has('impact-shake');
    const vf = clipScaleCrop(asset, workW, workH, c.crop?.x ?? 0.5, zoom, shake);
    vf.push('setsar=1');
    if (ids.has('film-grain')) vf.push('noise=alls=4:allf=t');
    if (ids.has('vignette')) vf.push('vignette=PI/5');
    if (ids.has('flash')) vf.push("eq=brightness=0.10:contrast=1.05:enable='lt(t\\,0.10)'");
    if (ids.has('glitch')) vf.push("rgbashift=rs=3:gs=-2:bs=-1:enable='between(t\\,0.03\\,0.14)'");
    if (ids.has('fade')) vf.push('fade=t=in:st=0:d=0.18');
    if (c.color === 'cinematic') vf.push('eq=contrast=1.06:saturation=.92:brightness=-.01');
    if (c.color === 'clean') vf.push('eq=contrast=1.03:saturation=1.02');
    if (c.color === 'luxury') vf.push('eq=contrast=1.05:saturation=.94:gamma=1.01');
    if (c.color === 'hype') vf.push('eq=contrast=1.10:saturation=1.08');
    if (c.color === 'travel') vf.push('eq=contrast=1.03:saturation=1.02');
    if (c.color === 'emotional') vf.push('eq=contrast=1.04:saturation=.90:brightness=-.015');
    if (speed !== 1) vf.push(`setpts=${(1 / speed).toFixed(5)}*PTS`);
    graph.push(`[${i}:v]${vf.join(',')}[v${i}]`);
    videoLabels.push(`[v${i}]`);

    if (asset.hasAudio) {
      graph.push(`[${i}:a]asetpts=PTS-STARTPTS,atempo=${speed.toFixed(3)}[a${i}]`);
    } else {
      graph.push(`anullsrc=r=48000:cl=stereo:d=${Math.max(0.05, c.sourceDuration / speed).toFixed(3)}[a${i}]`);
    }
    audioLabels.push(`[a${i}]`);
  }

  const concatInputs = [];
  for (let i = 0; i < totalClips; i++) concatInputs.push(`[v${i}][a${i}]`);
  graph.push(`${concatInputs.join('')}concat=n=${totalClips}:v=1:a=1[vcat][acat]`);
  graph.push(`[${musicInputIndex}:a]volume=${clamp(Number(timeline.music?.musicVolume ?? 0.38), 0, 0.9).toFixed(3)}[mus]`);
  const originalVol = timeline.music?.originalAudio === false ? 0 : 0.92;
  graph.push(`[acat]volume=${originalVol.toFixed(3)}[orig]`);
  if (voiceInputIndex !== null) {
    graph.push(`[${voiceInputIndex}:a]volume=${clamp(Number(timeline.music?.voiceVolume ?? 0.92), 0, 1.2).toFixed(3)}[voi]`);
    graph.push(`[orig][mus][voi]amix=inputs=3:duration=first:dropout_transition=1:normalize=1,apad=pad_dur=1,atrim=duration=${finalDuration.toFixed(3)},asetpts=PTS-STARTPTS[aout]`);
  } else {
    graph.push(`[orig][mus]amix=inputs=2:duration=first:dropout_transition=1:normalize=1,apad=pad_dur=1,atrim=duration=${finalDuration.toFixed(3)},asetpts=PTS-STARTPTS[aout]`);
  }

  const subtitleFile = timeline.captions?.length ? `${tmpDir}/captions.srt` : null;
  if (subtitleFile) {
    await fs.writeFile(subtitleFile, timeline.captions.map((c, i) => `${i + 1}\n${srt(c.start)} --> ${srt(c.end)}\n${String(c.text).replaceAll('-->', '–>')}\n`).join('\n'));
    graph.push(`[vcat]subtitles=${filterPathSafe(subtitleFile)}:force_style='FontName=Arial\\,FontSize=18\\,Outline=2\\,Alignment=2\\,MarginV=96',format=yuv420p[vout]`);
  } else {
    graph.push(`[vcat]tpad=stop_mode=clone:stop_duration=1,trim=duration=${finalDuration.toFixed(3)},setpts=PTS-STARTPTS,scale=${outW}:${outH}:flags=lanczos,setsar=1,format=yuv420p[vout]`);
  }

  ffArgs.push('-filter_complex', graph.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', String(finalDuration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', outputPath);
  onProgress(78, 'FFmpeg is rendering the validated timeline', { render: { phase: 'rendering', currentClip: 0, totalClips, fraction: 0, currentTime: 0, completedIndexes: [] } });
  await runFfmpegWithProgress(ffArgs, finalDuration, timeline.clips, onProgress);
  onProgress(97, 'Final render finished', { render: { phase: 'finished', currentClip: totalClips, totalClips, fraction: 1, currentTime: finalDuration, completedIndexes: timeline.clips.map((_, i) => i) } });
  return ffprobe(outputPath);
}

function runFfmpegWithProgress(args, totalDuration, clips, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', lastEmit = 0, latestTime = 0;
    const handle = line => {
      if (!line) return;
      stderr += line + '\\n';
      const m = line.match(/^out_time_(?:ms|us)=(\d+)/);
      const raw = m ? Number(m[1]) : NaN;
      if (Number.isFinite(raw)) {
        latestTime = raw > 1e8 ? raw / 1e6 : raw / 1e6;
        const now = Date.now();
        if (now - lastEmit >= 180 || latestTime >= totalDuration - 0.05) {
          lastEmit = now;
          const fraction = Math.max(0, Math.min(1, latestTime / Math.max(0.1, totalDuration)));
          const completed = clips.map((c, i) => ({ i, end: Number(c.timelineStart || 0) + Number(c.sourceDuration || 0) / Math.max(0.1, Number(c.speed || 1)) })).filter(x => x.end <= latestTime + 0.02).map(x => x.i);
          let currentClip = clips.findIndex(c => latestTime < Number(c.timelineStart || 0) + Number(c.sourceDuration || 0) / Math.max(0.1, Number(c.speed || 1)));
          if (currentClip < 0) currentClip = clips.length;
          onProgress(79 + Math.round(fraction * 16), `FFmpeg rendering · ${latestTime.toFixed(1)}s / ${totalDuration.toFixed(1)}s`, { render: { phase: 'rendering', currentClip, totalClips: clips.length, fraction, currentTime: Number(Math.min(totalDuration, latestTime).toFixed(3)), completedIndexes: completed } });
        }
      }
    };
    let carry = '';
    p.stderr.on('data', d => {
      carry += d.toString('utf8');
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() || '';
      for (const line of lines) handle(line);
    });
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`FFmpeg render failed (${code}): ${stderr.slice(-6000)}`), { code, stderr, args }));
    });
  });
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, Number.isFinite(v) ? v : min)); }
function srt(t) {
  const safe = Math.max(0, Number(t) || 0), h = Math.floor(safe / 3600), m = Math.floor((safe % 3600) / 60), sec = Math.floor(safe % 60), ms = Math.floor((safe - Math.floor(safe)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}
