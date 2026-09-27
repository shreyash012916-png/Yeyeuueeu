# CUTFLOW

Standalone autonomous AI video post-production studio. Upload one clip or dozens of short clips, add background music (and optionally a separate voice track), describe the idea and target duration, then CUTFLOW selects, orders, grades and renders the real edit.

## Flat GitHub package

Every deployable project file is at the repository root. There are **no project subfolders**. Extract the ZIP and upload every file shown directly to the GitHub repository root.

Do not upload `.env`, `node_modules`, temporary media, rendered videos or caches.

## Core workflow

- Add **1–40 video clips**. They may be long source footage or tiny 0.2–3 second moments.
- Add **background music**.
- Optionally add a **separate voice/narration track**. Original audio inside video clips can also be preserved and mixed.
- Choose a theme and aspect ratio.
- Describe the idea in natural language. CUTFLOW parses a duration such as `10 seconds` or `27s` from the brief, or you can enter the target length explicitly.
- Gemini 3.8 Flash receives the actual source media through the server-side Files API when `GEMINI_API_KEY` is configured.
- Gemini returns a bounded editorial plan: clip selection/order, targeted speed/crop/effect choices, captions only when justified by the media, text, target duration and audio mix.
- The deterministic timeline engine validates and normalizes that plan.
- FFmpeg renders every selected source clip for the timeline, assembles them, mixes music/voice/original audio, and produces a real H.264/AAC MP4.

### Example: 10-second micro-montage

Give CUTFLOW 20+ small clips and write:

> Create a 10-second cinematic travel montage. Use the strongest moments, build gently for the first few seconds, hit the music peak with the best shots, keep the voice clear, use elegant effects only, and finish on the hero shot.

CUTFLOW chooses distinct source moments across the uploaded clips instead of simply concatenating every file.

### Example: 27-second cinematic edit

Upload 5–6 shots plus music and write:

> Make this 27 seconds. Cinematic and premium. Slow opening, controlled build, strongest wide shot at the climax, subtle film grain and restrained zooms, consistent grade, clean ending.

CUTFLOW selects and trims the best windows, then renders the requested duration when enough source material exists.

## Real progress and AI status

The workspace uses Server-Sent Events (SSE) for job updates. The timeline identifies which real FFmpeg clip renders have completed and moves the playhead accordingly. The status panel distinguishes:

- **GEMINI 3.8 FLASH · REQUESTING** — the backend is actively making the Gemini editorial request.
- **GEMINI 3.8 FLASH · ACTIVE** — Gemini returned the structured plan.
- **GEMINI 3.8 FLASH · ERROR → LOCAL** — a configured Gemini request failed, so the deterministic local editor took over.
- **LOCAL EDITORIAL ENGINE** — no Gemini key is configured.

CUTFLOW never labels the local fallback as Gemini.

## Media limits

- Up to **40 video clips** per project.
- Each video clip: **0.15–4 minutes (240 seconds)**.
- Background music: **0.5–240 seconds**.
- Optional voice track: **0.5–240 seconds**.
- Final timeline/output: **0.5–240 seconds**.
- Default project storage ceiling: **2 GB**; configurable in `job-manager.js` via `MAX_PROJECT_MB` when the deployment environment is appropriate.

## Local setup

Requirements: Node.js 22+ and FFmpeg/FFprobe on PATH.

```bash
npm install
cp .env.example .env
# Add GEMINI_API_KEY to .env when Gemini editorial intelligence is desired.
npm run build
npm start
```

Open `http://localhost:10000`.

## Production

Build command:

```bash
npm run build
```

Start command:

```bash
npm start
```

The server respects the `PORT` environment variable and binds to `0.0.0.0`.

## Render

Create a **Web Service** connected to the GitHub repository and select **Docker**. The included Dockerfile installs FFmpeg and starts the Node.js service. The included `render.yaml` declares the service and `/health` health check.

Manual settings:

- Runtime: **Docker**
- Dockerfile: `./Dockerfile`
- Docker context: repository root
- Health check path: `/health`
- Required secret: `GEMINI_API_KEY`
- Optional: `MAX_UPLOAD_MB` (default `500`)
- Optional: `RENDER_CONCURRENCY` (default `4`)
- Optional: `RETENTION_MINUTES` (default `180`)
- Optional test hook: `GEMINI_API_BASE_URL`

Do not manually set `PORT`; Render supplies it.

## API

- `POST /api/projects` — create a project.
- `PUT /api/projects/:id/source-video/:assetId` — upload one source video asset.
- `PUT /api/projects/:id/source-video` — backwards-compatible single-video upload route.
- `PUT /api/projects/:id/source-music` — upload background music.
- `PUT /api/projects/:id/source-audio` — backwards-compatible alias for background music.
- `PUT /api/projects/:id/source-voice` — upload optional separate voice.
- `POST /api/projects/:id/create` — start the autonomous edit.
- `POST /api/projects/:id/retry` — retry the autonomous edit after an error.
- `GET /api/projects/:id/events` — live SSE job events.
- `POST /api/projects/:id/commands` — apply a natural-language edit to the current timeline and render a new version.
- `POST /api/projects/:id/versions/:versionId/restore` — restore a saved version.
- `GET /api/projects/:id/preview` — preview source/output media.
- `GET /api/projects/:id/output` — download the rendered MP4.
- `GET /health` — service health and Gemini model availability.

## Architecture

`USER → FRONTEND → BACKEND → GEMINI 3.8 FLASH → EDITORIAL PLAN → TIMELINE ENGINE → PARALLEL FFmpeg CLIP RENDERS → CONCAT → AUDIO MIX → QC → OUTPUT`

Gemini is an editorial planner, not a renderer and not a filesystem agent. The timeline is the source of truth. FFmpeg executes the validated timeline deterministically.

## Efficiency

Short source clips are analyzed concurrently. Long clips use real scene detection; micro-clips skip expensive scene detection because each uploaded micro-clip is already a user-defined shot. Timeline clip renders run concurrently (default up to four at a time) before a fast concat/mix pass.

A one-minute finished video is **not guaranteed to render in one minute** on every Render plan. Actual time depends on CPU, clip count, source resolution, effects, captions, Gemini latency and storage I/O. The application prioritizes real rendering and honest progress over fake speed.

## Validation scripts

```bash
npm run build
npm test
node gemini-smoke.mjs
```

`npm test` generates a multi-clip synthetic project, uploads five distinct source clips plus music and voice, requests a 10-second edit, validates a real MP4 with video+audio, checks live SSE progress, verifies that output pixels differ from a source clip, and exercises a versioned natural-language command. `gemini-smoke.mjs` exercises the Gemini adapter protocol with a local compatibility server without requiring a real secret.
