import http from 'node:http';
import { mkdir, readdir, readFile, open, link, unlink, stat, realpath, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hashToken = token => createHash('sha256').update(token).digest('hex');

export function validate(value) {
  if (!object(value) || !uuid.test(value.submissionId)) return false;
  const d = value.dataset;
  if (!object(d) || typeof d.participant !== 'string' || d.participant.length > 200 ||
      typeof d.timestamp !== 'string' || !Number.isFinite(Date.parse(d.timestamp)) ||
      typeof d.lang !== 'string' || d.lang.length > 16 ||
      !Array.isArray(d.trials) || d.trials.length < 1 || d.trials.length > 200) return false;
  const variables = new Set();
  return d.trials.every((t, i) => {
    if (!object(t) || t.position !== i + 1 || typeof t.variable !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(t.variable) || variables.has(t.variable) ||
        typeof t.image !== 'string' || t.image.length > 1000 ||
        !['female', 'male'].includes(t.persona) || typeof t.responded !== 'boolean' ||
        !(t.mapDurationMs === null || (Number.isFinite(t.mapDurationMs) && t.mapDurationMs >= 0)) ||
        !(t.output === null || object(t.output))) return false;
    variables.add(t.variable);
    return true;
  });
}

export async function createCollector({
  dataDir, origin = 'https://pesojka.github.io', maxBody = 10 * 1024 * 1024,
  maxStorage = 1024 * 1024 * 1024, maxSubmissions = 10000, requestsPerMinute = 120,
} = {}) {
  if (!dataDir) throw new Error('DATA_DIR is required');
  const draftDir = join(dataDir, 'drafts');
  await mkdir(draftDir, { recursive: true, mode: 0o700 });
  const probe = join(dataDir, `.probe-${randomUUID()}`);
  const probeFile = await open(probe, 'wx', 0o600);
  await probeFile.close(); await unlink(probe);
  const recordNames = async dir => (await readdir(dir)).filter(name =>
    name.endsWith('.json') && uuid.test(name.slice(0, -5)));
  const completeNames = await recordNames(dataDir);
  const completeSet = new Set(completeNames);
  // Recover a crash between publishing a completion and removing its superseded draft.
  for (const name of await recordNames(draftDir)) if (completeSet.has(name)) await unlink(join(draftDir, name));
  const draftNames = await recordNames(draftDir);
  let storedCount = completeNames.length + draftNames.length;
  let storedBytes = 0;
  for (const [dir, names] of [[dataDir, completeNames], [draftDir, draftNames]]) {
    for (const name of names) storedBytes += (await stat(join(dir, name))).size;
  }
  let active = 0, reservedBytes = 0, reservedCount = 0;
  let minute = Date.now(), requests = 0;
  const locks = new Map();
  const readRecord = async path => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Origin');
    const respond = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/healthz') return respond(200, { status: 'ok' });
    const checkpoint = req.url === '/checkpoints';
    if (!checkpoint && req.url !== '/submissions') return respond(404, { error: 'not_found' });
    if (req.headers.origin !== origin) return respond(403, { error: 'origin_not_allowed' });
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return respond(204, {});
    }
    if (req.method !== 'POST') return respond(405, { error: 'method_not_allowed' });
    if (Date.now() - minute >= 60000) { minute = Date.now(); requests = 0; }
    if (++requests > requestsPerMinute || active >= 4) {
      res.setHeader('Retry-After', '60');
      return respond(429, { error: 'retry_later' });
    }
    if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
      return respond(415, { error: 'json_required' });
    }
    if (req.headers['content-encoding'] || Number(req.headers['content-length']) > maxBody) {
      return respond(413, { error: 'payload_too_large' });
    }
    active++;
    let tempPath, reservation = 0, countReservation = 0, unlock, lockId, gate;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBody) { respond(413, { error: 'payload_too_large' }); return; }
        chunks.push(chunk);
      }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return respond(400, { error: 'invalid_json' }); }
      if (!validate(value) || (!checkpoint && value.dataset.status !== undefined && value.dataset.status !== "complete") || (value.writeToken !== undefined && !uuid.test(value.writeToken))) {
        return respond(400, { error: 'invalid_submission' });
      }
      if (checkpoint && (!uuid.test(value.writeToken) || !Number.isSafeInteger(value.revision) ||
          value.revision < 1 || value.dataset.status !== 'in_progress' || value.dataset.consent?.accepted !== true)) {
        return respond(400, { error: 'invalid_checkpoint' });
      }
      const submissionId = value.submissionId.toLowerCase();
      // Serialize updates and completion for each session, including simultaneous retries.
      lockId = submissionId;
      const previousLock = locks.get(lockId);
      gate = new Promise(resolve => { unlock = resolve; });
      locks.set(lockId, gate);
      if (previousLock) await previousLock;
      const target = join(dataDir, `${submissionId}.json`);
      const draftPath = join(draftDir, `${submissionId}.json`);
      const final = await readRecord(target);
      const tokenHash = value.writeToken ? hashToken(value.writeToken) : null;
      if (final) {
        if (checkpoint) {
          if (!final.writeTokenHash || final.writeTokenHash !== tokenHash) return respond(403, { error: 'invalid_write_token' });
          return respond(200, { saved: true, submissionId, revision: value.revision, complete: true });
        }
        const same = JSON.stringify(final.dataset) === JSON.stringify(value.dataset);
        return respond(same ? 200 : 409, same ? { saved: true, submissionId } : { error: 'submission_id_conflict' });
      }
      const draft = await readRecord(draftPath);
      if (draft && draft.writeTokenHash !== tokenHash) return respond(403, { error: 'invalid_write_token' });
      if (checkpoint && draft && value.revision <= draft.revision) {
        if (value.revision === draft.revision && JSON.stringify(value.dataset) !== JSON.stringify(draft.dataset)) {
          return respond(409, { error: 'revision_conflict' });
        }
        return respond(200, { saved: true, submissionId, revision: draft.revision });
      }
      const record = { submissionId, receivedAt: new Date().toISOString(),
        status: checkpoint ? 'in_progress' : 'complete',
        ...(tokenHash ? { writeTokenHash: tokenHash } : {}),
        ...(checkpoint ? { revision: value.revision } : {}), dataset: value.dataset };
      const serialized = JSON.stringify(record);
      const bytes = Buffer.byteLength(serialized);
      const previousBytes = draft ? (await stat(draftPath)).size : 0;
      const growth = Math.max(0, bytes - previousBytes);
      const newCount = draft ? 0 : 1;
      if (storedBytes + reservedBytes + growth > maxStorage || storedCount + reservedCount + newCount > maxSubmissions) {
        return respond(503, { error: 'storage_limit' });
      }
      reservation = growth; countReservation = newCount;
      reservedBytes += reservation; reservedCount += countReservation;
      const destination = checkpoint ? draftPath : target;
      tempPath = join(checkpoint ? draftDir : dataDir, `.pending-${randomUUID()}`);
      const file = await open(tempPath, 'wx', 0o600);
      try { await file.writeFile(serialized); await file.sync(); }
      finally { await file.close(); }
      if (checkpoint) await rename(tempPath, destination);
      else await link(tempPath, destination); // Completed records remain immutable.
      if (!checkpoint && draft) await unlink(draftPath);
      storedBytes += bytes - previousBytes; storedCount += newCount;
      return respond(checkpoint && draft ? 200 : 201, { saved: true, submissionId,
        ...(checkpoint ? { revision: value.revision } : {}) });
    } catch (error) {
      console.error('Submission failed:', error.code || error.name);
      if (!res.headersSent && !res.destroyed) respond(503, { error: 'save_failed' });
    } finally {
      if (tempPath) await unlink(tempPath).catch(() => {});
      reservedBytes -= reservation; reservedCount -= countReservation;
      if (unlock) { unlock(); if (locks.get(lockId) === gate) locks.delete(lockId); }
      active--;
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.timeout = 30000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const server = await createCollector({ dataDir: process.env.DATA_DIR, origin: process.env.ALLOWED_ORIGIN });
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('InteroMap collector listening'));
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 35000).unref();
  });
}
