import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, copyFile, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCollector } from './server.mjs';

const origin = 'https://pesojka.github.io';

test('starts when entry point is mounted through Kubernetes ConfigMap symlinks', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'interomap-configmap-'));
  await mkdir(join(root, '..version'));
  await copyFile(fileURLToPath(new URL('./server.mjs', import.meta.url)), join(root, '..version', 'server.mjs'));
  await symlink('..version', join(root, '..data'));
  await symlink('..data/server.mjs', join(root, 'server.mjs'));
  const child = spawn(process.execPath, [join(root, 'server.mjs')], {
    env: { ...process.env, DATA_DIR: join(root, 'results'), PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill('SIGTERM');
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let output = '', errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('InteroMap collector listening')) resolve();
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Exited before listening (code ${code}): ${errors}`)));
  });
  assert.equal(child.exitCode, null);
});
const sample = () => ({ submissionId: randomUUID(), dataset: {
  participant: 'TEST', timestamp: '2026-09-18T10:00:00.000Z', lang: 'cs',
  trials: [{ position: 1, variable: 'trial1', image: 'stimuli/img1.jpg',
    persona: 'female', mapDurationMs: 1000, responded: false, output: null }],
} });

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'interomap-collector-'));
  const server = await createCollector({ dataDir, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (value, extra = {}) => fetch(url + '/submissions', {
    method: 'POST', headers: { origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(value), ...extra,
  });
  return { dataDir, server, url, post };
}

test('save, acknowledge, persist original data, retry and reject conflicting overwrite', async t => {
  const { post, dataDir } = await fixture(t);
  const value = sample();
  const first = await post(value);
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { saved: true, submissionId: value.submissionId });
  const saved = JSON.parse(await readFile(join(dataDir, `${value.submissionId}.json`)));
  assert.deepEqual(saved.dataset, value.dataset);
  assert.ok(saved.receivedAt);
  assert.equal((await post(value)).status, 200);
  assert.equal((await post({ ...value, dataset: { ...value.dataset, participant: 'changed' } })).status, 409);
  assert.equal((await readdir(dataDir)).filter(n => n.endsWith('.json')).length, 1);
});

test('simultaneous retries publish exactly one complete record', async t => {
  const { post, dataDir } = await fixture(t);
  const value = sample();
  const results = await Promise.all([post(value), post(value), post(value)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 201]);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, `${value.submissionId}.json`))).dataset, value.dataset);
});

test('public routes never expose stored records; browser CORS preflight works', async t => {
  const { url, post } = await fixture(t);
  const value = sample();
  await post(value);
  assert.equal((await fetch(url + '/healthz')).status, 200);
  assert.equal((await fetch(url + '/submissions', { headers: { origin } })).status, 405);
  assert.equal((await fetch(url + `/${value.submissionId}.json`)).status, 404);
  const preflight = await fetch(url + '/submissions', { method: 'OPTIONS', headers: { origin } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal((await post(value, { headers: { origin: 'https://other.example', 'Content-Type': 'application/json' } })).status, 403);
});

test('invalid JSON, unsafe IDs, invalid trials, content type and oversized data rejected', async t => {
  const { post } = await fixture(t, { maxBody: 1024 });
  assert.equal((await post(sample(), { body: '{' })).status, 400);
  assert.equal((await post({ ...sample(), submissionId: '../../outside' })).status, 400);
  const invalid = sample(); invalid.dataset.trials = [];
  assert.equal((await post(invalid)).status, 400);
  assert.equal((await post(sample(), { headers: { origin, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post(sample(), { body: 'x'.repeat(1025) })).status, 413);
});

test('storage limits return failure but still acknowledge previously saved retries', async t => {
  const { post } = await fixture(t, { maxSubmissions: 1 });
  const first = sample();
  assert.equal((await post(first)).status, 201);
  assert.equal((await post(sample())).status, 503);
  assert.equal((await post(first)).status, 200);
});

test('rate limit is enforced', async t => {
  const { post } = await fixture(t, { requestsPerMinute: 1 });
  assert.equal((await post(sample())).status, 201);
  assert.equal((await post(sample())).status, 429);
});

test('previous submissions remain readable by collector after restart', async t => {
  const { post, server, dataDir } = await fixture(t);
  const value = sample();
  await post(value);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  const restarted = await createCollector({ dataDir });
  await new Promise(resolve => restarted.listen(0, '127.0.0.1', resolve));
  t.after(() => { restarted.closeAllConnections(); restarted.close(); });
  const result = await fetch(`http://127.0.0.1:${restarted.address().port}/submissions`, {
    method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  assert.equal(result.status, 200);
});

const draft = () => {
  const value = sample();
  return { ...value, writeToken: randomUUID(), revision: 1,
    dataset: { ...value.dataset, status: 'in_progress', consent: { accepted: true } } };
};
const checkpointPost = url => value => fetch(url + '/checkpoints', {
  method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value),
});

test('checkpoints replace only their own older revisions, retain one draft, and require the write token', async t => {
  const { url, dataDir } = await fixture(t);
  const post = checkpointPost(url), first = draft();
  assert.equal((await post(first)).status, 201);
  assert.equal((await post(first)).status, 200);
  const newer = { ...first, revision: 3, dataset: { ...first.dataset, participant: 'NEWER_TEST' } };
  assert.equal((await post(newer)).status, 200);
  assert.equal((await (await post(first)).json()).revision, 3);
  assert.equal((await post({ ...newer, dataset: first.dataset })).status, 409);
  assert.equal((await post({ ...newer, revision: 4, writeToken: randomUUID() })).status, 403);
  const record = JSON.parse(await readFile(join(dataDir, 'drafts', `${first.submissionId}.json`)));
  assert.equal(record.status, 'in_progress');
  assert.equal(record.revision, 3);
  assert.deepEqual(record.dataset, newer.dataset);
  assert.equal(record.writeToken, undefined);
  assert.notEqual(record.writeTokenHash, first.writeToken);
  assert.equal((await readdir(join(dataDir, 'drafts'))).length, 1);
  assert.equal((await fetch(url + `/drafts/${first.submissionId}.json`)).status, 404);
  assert.equal((await fetch(url + '/checkpoints', { headers: { origin } })).status, 405);
});

test('completion atomically supersedes draft, cannot be overwritten, and late checkpoints cannot revive it', async t => {
  const { url, post, dataDir } = await fixture(t, { maxSubmissions: 1 });
  const save = checkpointPost(url), first = draft();
  await save(first);
  const final = { submissionId: first.submissionId, writeToken: first.writeToken,
    dataset: { ...first.dataset, status: 'complete' } };
  assert.equal((await post({ ...final, writeToken: randomUUID() })).status, 403);
  assert.equal((await post(final)).status, 201); // Promotion works even at the record limit.
  assert.equal((await post(final)).status, 200);
  assert.equal((await readdir(join(dataDir, 'drafts'))).length, 0);
  const late = await save({ ...first, revision: 2 });
  assert.equal((await late.json()).complete, true);
  assert.equal((await readdir(join(dataDir, 'drafts'))).length, 0);
  assert.equal((await post({ ...final, dataset: first.dataset })).status, 400);
  const stored = JSON.parse(await readFile(join(dataDir, `${first.submissionId}.json`)));
  assert.deepEqual(stored.dataset, final.dataset);
});

test('simultaneous checkpoints retain highest revision and can race safely with completion', async t => {
  const { url, post, dataDir } = await fixture(t);
  const save = checkpointPost(url), first = draft();
  const updates = [3, 1, 2].map(revision => ({ ...first, revision }));
  const results = await Promise.all(updates.map(save));
  assert.ok(results.every(r => r.ok));
  assert.equal(JSON.parse(await readFile(join(dataDir, 'drafts', `${first.submissionId}.json`))).revision, 3);
  const final = { ...first, dataset: { ...first.dataset, status: 'complete' } };
  const raced = await Promise.all([save({ ...first, revision: 4 }), post(final)]);
  assert.ok(raced.every(r => r.ok));
  assert.equal((await readdir(join(dataDir, 'drafts'))).length, 0);
  assert.equal(JSON.parse(await readFile(join(dataDir, `${first.submissionId}.json`))).status, 'complete');
});

test('checkpoint validation rejects missing consent, token and invalid revision; quota covers drafts', async t => {
  const { url } = await fixture(t, { maxSubmissions: 1 });
  const save = checkpointPost(url), first = draft();
  for (const invalid of [ { ...first, writeToken: undefined }, { ...first, revision: 0 },
    { ...first, dataset: { ...first.dataset, consent: null } },
    { ...first, dataset: { ...first.dataset, status: 'complete' } } ]) {
    assert.equal((await save(invalid)).status, 400);
  }
  assert.equal((await save(first)).status, 201);
  assert.equal((await save(draft())).status, 503);
  assert.equal((await save({ ...first, revision: 2 })).status, 200);
  const preflight = await fetch(url + '/checkpoints', { method: 'OPTIONS', headers: { origin } });
  assert.equal(preflight.status, 204);
});

test('draft ownership and revisions persist across collector restart', async t => {
  const { url, server, dataDir } = await fixture(t);
  const first = draft();
  await checkpointPost(url)({ ...first, revision: 5 });
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  const restarted = await createCollector({ dataDir });
  await new Promise(resolve => restarted.listen(0, '127.0.0.1', resolve));
  t.after(() => { restarted.closeAllConnections(); restarted.close(); });
  const save = checkpointPost(`http://127.0.0.1:${restarted.address().port}`);
  assert.equal((await (await save(first)).json()).revision, 5);
  assert.equal((await save({ ...first, revision: 6, writeToken: randomUUID() })).status, 403);
  assert.equal((await save({ ...first, revision: 6 })).status, 200);
});
