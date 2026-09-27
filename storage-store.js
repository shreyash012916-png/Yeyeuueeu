import fs from 'node:fs/promises';
import path from 'node:path';

export const ROOT = path.resolve(process.env.CUTFLOW_STORAGE_DIR || './tmp');

export async function ensureStorage() {
  await fs.mkdir(ROOT, { recursive: true });
}

export function projectDir(id) {
  return path.join(ROOT, id);
}

export async function createProjectDir(id) {
  const d = projectDir(id);
  await fs.mkdir(d, { recursive: true });
  return d;
}

export async function writeJson(id, name, obj) {
  await fs.writeFile(path.join(projectDir(id), name), JSON.stringify(obj, null, 2));
}

export async function readJson(id, name) {
  return JSON.parse(await fs.readFile(path.join(projectDir(id), name), 'utf8'));
}

export async function removeProject(id) {
  await fs.rm(projectDir(id), { recursive: true, force: true });
}

export async function size(file) {
  return (await fs.stat(file)).size;
}

export async function folderSize(dir) {
  let total = 0;
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else total += (await fs.stat(full)).size;
    }
  }
  try { await walk(dir); } catch {}
  return total;
}

export async function cleanupExpiredProjects(maxAgeMinutes = 180) {
  const cutoff = Date.now() - Math.max(5, maxAgeMinutes) * 60_000;
  let removed = 0;
  await fs.mkdir(ROOT, { recursive: true });
  for (const entry of await fs.readdir(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(ROOT, entry.name);
    try {
      const st = await fs.stat(full);
      if (st.mtimeMs < cutoff) {
        await fs.rm(full, { recursive: true, force: true });
        removed++;
      }
    } catch {}
  }
  return removed;
}
