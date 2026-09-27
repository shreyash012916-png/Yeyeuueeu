import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const root = new URL('.', import.meta.url).pathname;
const required = ['index.html','app.js','styles.css','server.js','analyzer.js','ffmpeg.js','gemini.js','timeline.js','job-manager.js','storage-store.js','package.json','package-lock.json','Dockerfile','render.yaml','.env.example','.gitignore','README.md','smoke-test.mjs','gemini-smoke.mjs'];
for (const file of required) await fs.access(`${root}/${file}`);
const entries = await fs.readdir(root, { withFileTypes: true });
const nestedDirs = entries.filter(e => e.isDirectory() && e.name !== 'node_modules').map(e => e.name);
if (nestedDirs.length) throw new Error(`Flat package check failed; unexpected directories: ${nestedDirs.join(', ')}`);
const pkg = JSON.parse(await fs.readFile(`${root}/package.json`, 'utf8'));
if (pkg.type !== 'module' || pkg.scripts?.start !== 'node server.js' || pkg.scripts?.build !== 'node build-check.mjs' || pkg.scripts?.test !== 'node smoke-test.mjs') throw new Error('package.json scripts/configuration are inconsistent.');
for (const file of required.filter(x => /\.(js|mjs)$/.test(x))) {
  const r = spawnSync(process.execPath, ['--check', `${root}/${file}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Syntax check failed for ${file}: ${r.stderr}`);
}
const render = await fs.readFile(`${root}/render.yaml`, 'utf8');
if (!render.includes('runtime: docker') || !render.includes('healthCheckPath: /health')) throw new Error('Render configuration missing Docker/health settings.');
const docker = await fs.readFile(`${root}/Dockerfile`, 'utf8');
if (!docker.includes('apt-get install') || !docker.includes('ffmpeg') || !docker.includes('CMD ["npm","start"]')) throw new Error('Dockerfile is missing required runtime steps.');
const gemini = await fs.readFile(`${root}/gemini.js`, 'utf8');
if (!gemini.includes("gemini-3.8-flash") || !gemini.includes('GEMINI_API_KEY') || !gemini.includes('file_data')) throw new Error('Gemini integration configuration missing.');
const app = await fs.readFile(`${root}/app.js`, 'utf8');
for (const token of ['multiple','source-video/','source-music','source-voice','EventSource','GEMINI 3.8 FLASH']) if (!app.includes(token)) throw new Error(`Frontend missing ${token}`);
const readme = await fs.readFile(`${root}/README.md`, 'utf8');
for (const token of ['4 minutes','GEMINI_API_KEY','/health','npm run build','npm start','40 video clips','RENDER_CONCURRENCY']) if (!readme.includes(token)) throw new Error(`README missing ${token}`);
console.log(`CUTFLOW build audit passed: flat root, ${required.length} required files, JS syntax, Render/Docker/Gemini configuration, multi-clip UI/API wiring.`);
