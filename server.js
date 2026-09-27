import fsEnv from 'node:fs';
if (fsEnv.existsSync('.env')) {
  for (const line of fsEnv.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureStorage, projectDir, cleanupExpiredProjects } from './storage-store.js';
import { createProject, saveUpload, saveVideoUpload, startCreate, getProject, publicProject, subscribe, runCommand, restoreVersion } from './job-manager.js';
import { healthProbe } from './gemini.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 10000;
await ensureStorage();
setInterval(() => cleanupExpiredProjects(Number(process.env.RETENTION_MINUTES) || 180).catch(() => {}), 15 * 60_000).unref();

const mimeByExt = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { status: 'ok', service: 'cutflow', ffmpeg: true, gemini: await healthProbe() });
    if (u.pathname === '/api/projects' && req.method === 'POST') return json(res, 201, publicProject(await createProject(await readBody(req))));

    const m = u.pathname.match(/^\/api\/projects\/([^/]+)(.*)$/);
    if (m) {
      const id = m[1], rest = m[2];
      const asset = rest.match(/^\/source-video\/(.+)$/);
      if (req.method === 'PUT' && asset) return json(res, 200, publicProject(await saveVideoUpload(id, decodeURIComponent(asset[1]), req, req.headers['x-file-name'] || 'clip.mp4', Number(req.headers['content-length'] || 0))));
      if (req.method === 'PUT' && rest === '/source-video') return json(res, 200, publicProject(await saveUpload(id, 'video', req, req.headers['x-file-name'] || 'clip.mp4', Number(req.headers['content-length'] || 0))));
      if (req.method === 'PUT' && rest === '/source-music') return json(res, 200, publicProject(await saveUpload(id, 'music', req, req.headers['x-file-name'] || 'music.mp3', Number(req.headers['content-length'] || 0))));
      if (req.method === 'PUT' && rest === '/source-audio') return json(res, 200, publicProject(await saveUpload(id, 'music', req, req.headers['x-file-name'] || 'music.mp3', Number(req.headers['content-length'] || 0))));
      if (req.method === 'PUT' && rest === '/source-voice') return json(res, 200, publicProject(await saveUpload(id, 'voice', req, req.headers['x-file-name'] || 'voice.mp3', Number(req.headers['content-length'] || 0))));
      if (req.method === 'GET' && rest === '') return json(res, 200, publicProject(getProject(id)));
      if (req.method === 'GET' && rest === '/events') return sse(id, res);
      if (req.method === 'POST' && rest === '/create') return json(res, 202, publicProject(await startCreate(id)));
      if (req.method === 'POST' && rest === '/retry') return json(res, 202, publicProject(await startCreate(id)));
      if (req.method === 'POST' && rest === '/commands') {
        const body = await readBody(req);
        return json(res, 200, publicProject(await runCommand(id, String(body.command || '').trim())));
      }
      const rv = rest.match(/^\/versions\/([^/]+)\/restore$/);
      if (req.method === 'POST' && rv) return json(res, 200, publicProject(await restoreVersion(id, rv[1])));
      if (req.method === 'GET' && rest === '/output') {
        const p = getProject(id);
        if (!p.output?.path) return json(res, 404, { error: 'No rendered output yet.' });
        return sendFile(res, p.output.path, 'video/mp4', 'cutflow-final.mp4');
      }
      if (req.method === 'GET' && rest === '/preview') {
        const p = getProject(id);
        const preview = p.output?.path || p.videos?.[0]?.path;
        if (!preview) return json(res, 404, { error: 'No media available for preview.' });
        return sendFile(res, preview, p.output ? 'video/mp4' : guessMime(preview));
      }
    }
    if (req.method === 'GET') return serveStatic(u.pathname, res);
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return json(res, e.status || 500, { error: e.message || 'Internal server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`CUTFLOW listening on 0.0.0.0:${PORT}`));

async function serveStatic(url, res) {
  const decoded = decodeURIComponent(url);
  const candidate = path.resolve(root, '.' + decoded);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return json(res, 403, { error: 'Forbidden' });
  let p = candidate;
  if (url === '/') p = path.join(root, 'index.html');
  try {
    const st = await fsp.stat(p);
    if (st.isDirectory()) p = path.join(p, 'index.html');
    return sendFile(res, p, mimeByExt[path.extname(p)] || 'text/plain; charset=utf-8');
  } catch {
    if (path.extname(url) === '') return sendFile(res, path.join(root, 'index.html'), 'text/html; charset=utf-8');
    return json(res, 404, { error: 'Not found' });
  }
}

function sse(id, res) {
  const p = getProject(id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`event: update\ndata: ${JSON.stringify({ status: p.status, progress: p.progress, ai: p.ai, render: p.render, timeline: p.timeline, output: p.output ? { duration: p.output.duration, size: p.output.size, valid: p.output.valid } : null })}\n\n`);
  subscribe(id, res);
}
function sendFile(res, file, mime = 'application/octet-stream', download) {
  res.writeHead(200, { 'Content-Type': mime, ...(download ? { 'Content-Disposition': `attachment; filename="${download}"` } : {}) });
  fs.createReadStream(file).pipe(res);
}
function json(res, status, obj) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
async function readBody(req) {
  if (req.method === 'POST' && Number(req.headers['content-length'] || 0) > 2 * 1024 * 1024) throw Object.assign(new Error('JSON body too large.'), { status: 413 });
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}
function guessMime(p = '') {
  const e = path.extname(p).toLowerCase();
  return e === '.mp4' ? 'video/mp4' : e === '.mov' ? 'video/quicktime' : e === '.webm' ? 'video/webm' : e === '.mp3' ? 'audio/mpeg' : e === '.wav' ? 'audio/wav' : e === '.m4a' ? 'audio/mp4' : e === '.aac' ? 'audio/aac' : e === '.ogg' ? 'audio/ogg' : 'application/octet-stream';
}
