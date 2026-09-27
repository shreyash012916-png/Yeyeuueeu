const THEMES = {
  cinematic: { color: 'cinematic', target: 3.6, preferredEffects: ['fade', 'film-grain', 'vignette'] },
  hype: { color: 'hype', target: 1.2, preferredEffects: ['flash', 'punch-zoom', 'impact-shake'] },
  clean: { color: 'clean', target: 2.5, preferredEffects: ['fade', 'smooth-zoom'] },
  luxury: { color: 'luxury', target: 4.2, preferredEffects: ['fade', 'vignette', 'smooth-zoom'] },
  travel: { color: 'travel', target: 3.2, preferredEffects: ['fade', 'smooth-zoom'] },
  sports: { color: 'hype', target: 1.05, preferredEffects: ['impact-shake', 'punch-zoom', 'flash'] },
  emotional: { color: 'cinematic', target: 4.8, preferredEffects: ['fade', 'vignette'] },
  documentary: { color: 'clean', target: 5.5, preferredEffects: ['fade'] }
};

export const EFFECT_REGISTRY = [
  ['punch-zoom', ['intensity', 'duration'], ['impact', 'drop', 'action'], ['dialogue', 'quiet']],
  ['smooth-zoom', ['intensity', 'duration'], ['cinematic', 'luxury', 'clean'], []],
  ['impact-shake', ['intensity', 'duration'], ['drop', 'sports', 'hype'], ['dialogue', 'emotional']],
  ['flash', ['intensity', 'duration'], ['impact', 'drop', 'hype'], ['dialogue', 'quiet']],
  ['glitch', ['intensity', 'duration'], ['experimental', 'hype', 'impact'], ['luxury', 'documentary']],
  ['film-grain', ['intensity', 'duration'], ['cinematic', 'documentary', 'luxury'], []],
  ['vignette', ['intensity', 'duration'], ['cinematic', 'emotional', 'luxury'], []],
  ['fade', ['duration'], ['intro', 'outro', 'cinematic', 'documentary'], []]
].map(([id, parameters, recommendedContexts, prohibitedContexts]) => ({ id, parameters, recommendedContexts, prohibitedContexts }));

export function normalizeTimeline(raw, analysis, { theme, aspectRatio, instruction = '', targetDuration = null }) {
  const resolvedTheme = THEMES[theme] ? theme : 'cinematic';
  const th = THEMES[resolvedTheme];
  const availableVideo = Number(analysis.video.duration || 0);
  const musicDuration = Number(analysis.audio.duration || 0);
  const requested = Number(targetDuration) > 0 ? Number(targetDuration) : parseTargetDuration(instruction);
  const outputDuration = Number(Math.min(240, musicDuration, availableVideo, requested > 0 ? requested : Math.min(availableVideo, musicDuration)).toFixed(3));
  if (outputDuration < 0.5) throw new Error('Not enough usable media to create an edit of at least 0.5 seconds.');

  const sourceSegments = buildSourceSegments(analysis.video.assets, th.target);
  const targetClipCount = chooseTargetClipCount(sourceSegments, outputDuration, th.target, instruction);
  const ranked = sourceSegments.map((s, i) => ({
    ...s,
    rank: score(s, resolvedTheme, analysis.audio, instruction) + ((sourceSegments.length - i) / Math.max(1, sourceSegments.length)) * 0.0005
  })).sort((a, b) => b.rank - a.rank);

  let chosen = chooseCoverage(ranked, targetClipCount, outputDuration, instruction);
  if (!chosen.length) chosen = [ranked[0]];
  chosen.sort((a, b) => a.originalOrder - b.originalOrder);
  const clips = chosen.map((s, i) => createClip(s, i, resolvedTheme, th));

  const base = {
    schemaVersion: '2.0',
    project: {
      duration: outputDuration,
      requestedDuration: requested > 0 ? requested : outputDuration,
      fps: Math.min(60, analysis.video.assets.reduce((m, a) => Math.max(m, a.fps || 30), 30)),
      aspectRatio,
      theme: resolvedTheme
    },
    music: {
      duration: musicDuration,
      bpm: analysis.audio.bpm,
      beatPositions: analysis.audio.beatPositions,
      sections: analysis.audio.sections,
      originalAudio: true,
      musicVolume: 0.38,
      voiceVolume: 0.92
    },
    clips,
    captions: [],
    text: [],
    effects: [],
    transitions: [],
    editorialNotes: []
  };

  applyGeminiPlan(base, raw);
  const withIntent = applyUserIntent(base, instruction);
  fitToDuration(withIntent.clips, outputDuration);
  rebuildDerived(withIntent);
  if (withIntent.project.duration < 0.5) throw new Error('Editorial plan produced a timeline that is too short.');
  return withIntent;
}

function buildSourceSegments(assets, targetSeconds) {
  const segments = [];
  let order = 0;
  for (const asset of assets || []) {
    for (const scene of asset.scenes || []) {
      const preferred = Math.max(0.45, targetSeconds);
      const parts = scene.duration > preferred * 1.55 ? Math.ceil(scene.duration / preferred) : 1;
      for (let j = 0; j < parts; j++) {
        const start = scene.start + (j * scene.duration / parts);
        const end = scene.start + ((j + 1) * scene.duration / parts);
        if (end - start >= 0.35) {
          segments.push({
            id: `${asset.id}:${scene.id}:${j + 1}`,
            sourceKey: `${asset.id}:${scene.id}`,
            assetId: asset.id,
            assetName: asset.name,
            start,
            end,
            duration: end - start,
            sourceSceneIndex: asset.scenes.indexOf(scene),
            motionScore: scene.motionScore,
            compositionScore: scene.compositionScore,
            qualityScore: scene.qualityScore,
            subjectScore: scene.subjectScore,
            energyScore: scene.energyScore,
            brightnessScore: scene.brightnessScore,
            sharpnessScore: scene.sharpnessScore,
            subjectX: scene.subjectX,
            originalOrder: order++
          });
        }
      }
    }
  }
  return segments;
}

function chooseTargetClipCount(segments, duration, target, instruction) {
  if (/use all clips|use every clip|all footage|every clip/i.test(instruction)) return segments.length;
  const natural = Math.ceil(duration / Math.max(0.55, target));
  const efficiencyCap = duration <= 15 ? 12 : duration <= 30 ? 14 : 18;
  return Math.max(1, Math.min(segments.length, efficiencyCap, natural));
}

function chooseCoverage(ranked, targetCount, targetDuration, instruction) {
  const selected = [];
  const usedAssets = new Set();
  let total = 0;
  const diversityFirst = !/repeat|replay|same shot|use fewer clips/i.test(instruction);

  const take = s => {
    if (!s || (selected.length >= targetCount && total >= targetDuration - 0.05) || total >= targetDuration - 0.05) return;
    const remaining = targetDuration - total;
    const length = Math.min(s.duration, remaining);
    if (length < 0.35) return;
    selected.push({ ...s, duration: length, end: s.start + length });
    usedAssets.add(s.assetId);
    total += length;
  };

  if (diversityFirst) {
    for (const s of ranked) {
      if (usedAssets.has(s.assetId)) continue;
      take(s);
      if (selected.length >= targetCount && total >= targetDuration - 0.05) break;
    }
  }
  for (const s of ranked) {
    if (selected.length >= targetCount && total >= targetDuration - 0.05) break;
    if (!selected.includes(s)) take(s);
  }
  if (total < targetDuration - 0.05) {
    for (const s of ranked) {
      if (total >= targetDuration - 0.05) break;
      const remaining = targetDuration - total;
      const length = Math.min(s.duration, remaining);
      if (length < 0.35) continue;
      const copy = { ...s, id: `${s.id}:fill`, duration: length, end: s.start + length };
      selected.push(copy);
      total += length;
    }
  }
  return selected;
}

function createClip(s, i, theme, th) {
  return {
    id: `clip-${i + 1}`,
    sourceKey: s.id,
    sourceAssetId: s.assetId,
    sourceName: s.assetName,
    sourceStart: Number(s.start.toFixed(3)),
    sourceDuration: Number(s.duration.toFixed(3)),
    timelineStart: 0,
    speed: speedFor(s, theme),
    crop: { x: Number((s.subjectX ?? 0.5).toFixed(3)) },
    color: th.color,
    effects: chooseThemeEffects(i, s, theme),
    transition: 'cut',
    sourceMetrics: {
      motion: s.motionScore,
      quality: s.qualityScore,
      energy: s.energyScore,
      brightness: s.brightnessScore,
      sharpness: s.sharpnessScore,
      composition: s.compositionScore
    }
  };
}

function chooseThemeEffects(i, s, theme) {
  if (theme === 'documentary' && i > 0 && i % 8 !== 0) return [];
  if (theme === 'hype' || theme === 'sports') {
    if (s.energyScore > 0.74 && i % 5 === 2) return [{ id: 'impact-shake', duration: 0.20, intensity: 0.18 }];
    if (s.energyScore > 0.62 && i % 4 === 1) return [{ id: 'punch-zoom', duration: 0.30, intensity: 0.18 }];
    if (i % 9 === 0) return [{ id: 'flash', duration: 0.08, intensity: 0.13 }];
  }
  if (theme === 'cinematic' || theme === 'luxury' || theme === 'emotional') {
    if (i === 0) return [{ id: 'fade', duration: 0.18, intensity: 0.3 }];
    if (i % 7 === 3) return [{ id: 'vignette', duration: 0.5, intensity: 0.16 }];
    if (i % 9 === 4) return [{ id: 'film-grain', duration: 0.5, intensity: 0.16 }];
  }
  if (theme === 'clean' || theme === 'travel' || theme === 'documentary') {
    if (i === 0) return [{ id: 'fade', duration: 0.18, intensity: 0.24 }];
    if (i % 10 === 5 && s.qualityScore > 0.64) return [{ id: 'smooth-zoom', duration: 0.45, intensity: 0.11 }];
  }
  return [];
}

function speedFor(s, theme) {
  if ((theme === 'hype' || theme === 'sports') && s.motionScore > 0.70) return 1.12;
  if (theme === 'emotional' && s.motionScore < 0.35) return 0.90;
  return 1;
}

function score(s, theme, audio, instruction = '') {
  const visual = (s.qualityScore ?? 0.5) * 0.31 + (s.motionScore ?? 0.5) * 0.22 + (s.compositionScore ?? 0.5) * 0.20 + (s.subjectScore ?? 0.5) * 0.12 + (s.sharpnessScore ?? 0.5) * 0.15;
  const energy = s.energyScore ?? 0.5;
  let base = visual * 0.94 + energy * 0.06;
  if (theme === 'emotional') base = visual * 0.78 + (1 - s.motionScore) * 0.22;
  if (theme === 'hype' || theme === 'sports') base = visual * 0.70 + energy * 0.30;
  if (/best|strongest|hero|main subject/i.test(instruction)) base += (s.subjectScore || 0.5) * 0.05;
  if (/slow|cinematic|calm/i.test(instruction)) base += (1 - energy) * 0.04;
  if (/energetic|fast|aggressive|crazy|insane/i.test(instruction)) base += energy * 0.05;
  if (audio?.sections?.length) base += 0.003;
  return base;
}

function applyGeminiPlan(t, raw) {
  const map = new Map(t.clips.map(c => [c.sourceKey, c]));
  if (Array.isArray(raw.clipOrder) && raw.clipOrder.length) {
    const reordered = [];
    for (const key of raw.clipOrder) {
      const candidate = map.get(String(key));
      if (candidate && !reordered.includes(candidate)) reordered.push(candidate);
    }
    for (const c of t.clips) if (!reordered.includes(c)) reordered.push(c);
    t.clips = reordered.map((c, i) => ({ ...c, id: `clip-${i + 1}` }));
  }
  for (const o of raw.clipOverrides || []) {
    const c = map.get(String(o.sourceKey));
    if (!c) continue;
    if (o.keep === false) c.sourceDuration = 0;
    if (Number.isFinite(o.speed)) c.speed = clamp(Number(o.speed), 0.5, 1.8);
    if (Number.isFinite(o.cropX)) c.crop.x = clamp(Number(o.cropX), 0.08, 0.92);
    if (Array.isArray(o.effects)) c.effects = uniqueEffects(o.effects.filter(isAllowedEffect).map(id => ({ id, duration: defaultEffectDuration(id), intensity: 0.16 })));
  }
  t.clips = t.clips.filter(c => c.sourceDuration > 0.2);
  if (Number.isFinite(raw.targetDuration) && raw.targetDuration >= 0.5) t.project.requestedDuration = clamp(raw.targetDuration, 0.5, 240);
  if (Array.isArray(raw.captions)) t.captions = mapSourceCaptionsToTimeline(t, raw.captions);
  if (Array.isArray(raw.text)) t.text = raw.text.slice(0, 24);
  if (Array.isArray(raw.editorialNotes)) t.editorialNotes.push(...raw.editorialNotes.slice(0, 10));
  if (raw.audio && typeof raw.audio === 'object') {
    t.music.originalAudio = raw.audio.useOriginalAudio !== false;
    if (Number.isFinite(raw.audio.musicVolume)) t.music.musicVolume = clamp(raw.audio.musicVolume, 0, 0.9);
    if (Number.isFinite(raw.audio.voiceVolume)) t.music.voiceVolume = clamp(raw.audio.voiceVolume, 0, 1.2);
  }
}

function mapSourceCaptionsToTimeline(t, captions) {
  const mapped = [];
  const clipMap = new Map(t.clips.map(c => [c.sourceKey, c]));
  for (const c of captions) {
    const clip = clipMap.get(String(c.sourceKey));
    const start = Number(c.start), end = Number(c.end), text = String(c.text || '').trim();
    if (!clip || !text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const clipStart = Math.max(start, clip.sourceStart);
    const clipEnd = Math.min(end, clip.sourceStart + clip.sourceDuration);
    if (clipEnd <= clipStart) continue;
    const timelineStart = clip.timelineStart + (clipStart - clip.sourceStart) / Math.max(0.1, clip.speed || 1);
    const timelineEnd = clip.timelineStart + (clipEnd - clip.sourceStart) / Math.max(0.1, clip.speed || 1);
    if (timelineEnd - timelineStart >= 0.05) mapped.push({ id: `cap-${mapped.length + 1}`, start: timelineStart, end: timelineEnd, text });
  }
  return mapped.slice(0, 160);
}

export function applyUserIntent(timeline, instruction = '') {
  const text = String(instruction || '').toLowerCase();
  const t = structuredClone(timeline);
  if (!text) return t;
  const target = parseTargetDuration(instruction);
  if (target > 0) t.project.requestedDuration = target;
  if (/less effects|fewer effects|remove flashy|restrained|professional|premium/.test(text)) {
    t.clips = t.clips.map(c => ({ ...c, effects: (c.effects || []).filter(e => ['fade', 'film-grain', 'vignette', 'smooth-zoom'].includes(e.id)), transition: 'cut' }));
  }
  if (/no glitch|don't use glitch|do not use glitch/.test(text)) t.clips = t.clips.map(c => ({ ...c, effects: (c.effects || []).filter(e => e.id !== 'glitch') }));
  if (/no shake|don't use shake|do not use shake/.test(text)) t.clips = t.clips.map(c => ({ ...c, effects: (c.effects || []).filter(e => e.id !== 'impact-shake') }));
  if (/cinematic|darker|dramatic/.test(text)) { t.project.theme = 'cinematic'; t.clips = t.clips.map(c => ({ ...c, color: 'cinematic' })); }
  if (/luxury|premium/.test(text)) { t.project.theme = 'luxury'; t.clips = t.clips.map(c => ({ ...c, color: 'luxury' })); }
  if (/clean|minimal/.test(text)) { t.project.theme = 'clean'; t.clips = t.clips.map(c => ({ ...c, color: 'clean' })); }
  if (/faster|more intense|aggressive|energetic|crazy|insane/.test(text)) t.clips = t.clips.map((c, i) => i % 2 === 0 ? ({ ...c, sourceDuration: Math.max(0.4, c.sourceDuration * 0.82), speed: Math.max(c.speed, 1.08) }) : c);
  if (/slower|slow intro|start slow|starts? slow/.test(text)) t.clips = t.clips.map((c, i) => i < Math.max(1, Math.ceil(t.clips.length * 0.2)) ? ({ ...c, sourceDuration: c.sourceDuration * 1.12, speed: Math.min(1, c.speed) }) : c);
  if (/slow motion|slow-mo/.test(text)) t.clips = t.clips.map((c, i) => i % 3 === 0 ? ({ ...c, speed: 0.72 }) : c);
  if (/more zoom|punch zoom/.test(text)) t.clips = t.clips.map((c, i) => i % 3 === 1 ? ({ ...c, effects: uniqueEffects([...(c.effects || []), { id: 'punch-zoom', duration: 0.30, intensity: 0.16 }]) }) : c);
  if (/drop|chorus|climax/.test(text)) t.clips = t.clips.map((c, i) => i >= Math.floor(t.clips.length * 0.65) ? ({ ...c, effects: uniqueEffects([...(c.effects || []), { id: 'impact-shake', duration: 0.18, intensity: 0.14 }]), speed: Math.max(c.speed, 1.08) }) : c);
  if (/original audio|keep original audio|keep voice|preserve voice/.test(text)) t.music.originalAudio = true;
  if (/music quieter|lower music|duck the music/.test(text)) t.music.musicVolume = 0.26;
  if (/music louder|raise music/.test(text)) t.music.musicVolume = 0.5;
  if (/caption.*smaller|smaller.*caption/.test(text)) t.captions = t.captions.map(c => ({ ...c, style: { ...(c.style || {}), fontSize: 'small' } }));
  t.editorialNotes.push(`User intent applied: ${instruction}`);
  return t;
}

export function applyCommand(timeline, command) { return applyUserIntent(timeline, command); }

export function parseTargetDuration(text = '') {
  const s = String(text);
  const m = s.match(/(?:make|create|edit|export|keep|length|duration|target|around|under|within)?[^\n]{0,30}?(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i) || s.match(/(?:0:)?(\d+):(\d{2})\b/);
  if (!m) return 0;
  if (m[2] && String(m[2]).length === 2 && Number(m[1]) < 60) return Number(m[1]) * 60 + Number(m[2]);
  return Number(m[1]);
}

export function rebuildDerived(t) {
  const hardCap = 240;
  const requested = clamp(Number(t.project.requestedDuration || t.project.duration || 0), 0.5, hardCap);
  const kept = (t.clips || []).filter(c => c.sourceDuration > 0.2);
  let pos = 0;
  for (const c of kept) {
    c.timelineStart = Number(pos.toFixed(3));
    pos += c.sourceDuration / Math.max(0.1, c.speed || 1);
  }
  if (pos > requested + 0.03 && kept.length) {
    let excess = pos - requested;
    for (let i = kept.length - 1; i >= 0 && excess > 0.001; i--) {
      const c = kept[i];
      const current = c.sourceDuration / Math.max(0.1, c.speed || 1);
      const reducible = Math.max(0, current - 0.35);
      const take = Math.min(reducible, excess);
      c.sourceDuration -= take * Math.max(0.1, c.speed || 1);
      excess -= take;
    }
    pos = 0;
    for (const c of kept) { c.timelineStart = Number(pos.toFixed(3)); pos += c.sourceDuration / Math.max(0.1, c.speed || 1); }
  }
  t.clips = kept;
  t.project.duration = Number(Math.min(hardCap, requested, pos).toFixed(3));
  t.effects = kept.flatMap(c => (c.effects || []).map(e => ({ ...e, clipId: c.id })));
  t.transitions = kept.map((c, i) => ({ index: i, type: c.transition || 'cut' })).filter(x => x.type !== 'cut');
  return t;
}

function fitToDuration(clips, duration) {
  if (!clips.length) return;
  let total = clips.reduce((sum, c) => sum + c.sourceDuration / Math.max(0.1, c.speed || 1), 0);
  if (total < duration - 0.05) {
    let remaining = duration - total;
    for (let i = 0; i < clips.length && remaining > 0.05; i++) {
      const c = clips[i];
      const room = Math.max(0, c.sourceDuration - 0.05);
      if (!room) continue;
      const add = Math.min(room, remaining * Math.max(0.1, c.speed || 1));
      c.sourceDuration += add;
      remaining -= add / Math.max(0.1, c.speed || 1);
    }
  }
  total = clips.reduce((sum, c) => sum + c.sourceDuration / Math.max(0.1, c.speed || 1), 0);
  if (total > duration) {
    let excess = total - duration;
    for (let i = clips.length - 1; i >= 0 && excess > 0.001; i--) {
      const c = clips[i];
      const current = c.sourceDuration / Math.max(0.1, c.speed || 1);
      const reducible = Math.max(0, current - 0.35);
      const take = Math.min(reducible, excess);
      c.sourceDuration -= take * Math.max(0.1, c.speed || 1);
      excess -= take;
    }
  }
  let pos = 0;
  for (const c of clips) { c.timelineStart = Number(pos.toFixed(3)); pos += c.sourceDuration / Math.max(0.1, c.speed || 1); }
}

function uniqueEffects(effects) {
  const seen = new Set();
  return effects.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
}
function isAllowedEffect(id) { return EFFECT_REGISTRY.some(e => e.id === id); }
function defaultEffectDuration(id) { return id === 'fade' ? 0.18 : id === 'flash' ? 0.08 : 0.3; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, Number(v))); }
