import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, writeFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { validate } from './server.mjs';

const html = await readFile(new URL('../experiment.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace('startExperiment();', '');

function setup(fetchImpl, initial = null, storageFails = false) {
  const elements = new Map();
  const listeners = new Map();
  const trialTimers = [];
  let now = 0;
  const storage = new Map(initial ? [['interomap.pending-submission.v1', JSON.stringify(initial)]] : []);
  function element() {
    const handlers = new Map();
    return {
      children: [], hidden: false, textContent: '', innerHTML: '',
      set id(id) { this._id = id; elements.set(id, this); }, get id() { return this._id; },
      appendChild(child) { this.children.push(child); },
      setAttribute() {}, addEventListener(name, handler) { handlers.set(name, handler); },
      fire(name) { handlers.get(name)?.(); },
    };
  }
  for (const id of ['app', 'progress']) { const e = element(); e.id = id; }
  const context = vm.createContext({
    document: { createElement: element, getElementById: id => elements.get(id) },
    window: { addEventListener: (name, handler) => listeners.set(name, handler) },
    location: { href: 'https://pesojka.github.io/interomap/experiment.html' },
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { if (storageFails) throw new Error('QuotaExceeded'); storage.set(key, value); },
      removeItem: key => storage.delete(key),
    },
    crypto: webcrypto, AbortController, URL, console, performance: { now: () => now }, fetch: fetchImpl,
    requestAnimationFrame: fn => fn(),
    // Skip backoff delays, but preserve abort deadlines so ordinary requests can finish.
    setTimeout: (fn, ms) => {
      if ((ms === 6000 || ms === 5000) && ['ratingPicture', 'ratingPreparation'].includes(context.testApi.state.phase)) {
        trialTimers.push({ fn, due: now + ms }); return;
      }
      return setTimeout(fn, ms === 20000 ? ms : 0);
    }, clearTimeout,
  });
  vm.runInContext(source + `
    globalThis.testApi = {
      finish: screenEnd, upload: uploadResults,
      pending: () => completedSubmission, saved: () => uploadSaved,
      busy: () => uploadInProgress, UI,
      startRatings: () => runTrial(state.order.length),
      startBaseline: screenBaselineIntro,
      dataset: buildDataset,
      CONFIG,
      state, toCSV,
      prepare: () => { state.participant = 'LOCAL_TEST';
        for (const t of CONFIG.trials) state.meta[t.variable] = { persona: 'female', mapDurationMs: 1000 };
      }
    };`, context);
  context.testApi.prepare();
  const advanceTime = ms => {
    now += ms;
    for (const timer of [...trialTimers]) {
      if (timer.due <= now) { trialTimers.splice(trialTimers.indexOf(timer), 1); timer.fn(); }
    }
  };
  return { api: context.testApi, elements, storage, listeners, advanceTime };
}

async function finished(api) {
  const deadline = Date.now() + 2000;
  while (api.busy()) {
    if (Date.now() > deadline) throw new Error('Upload did not finish');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const receipt = body => ({ ok: true, status: 201,
  json: async () => ({ saved: true, submissionId: JSON.parse(body).submissionId }) });

test('completion submits valid data once and only confirms matching receipt', async () => {
  const requests = [];
  const { api, elements, storage } = setup(async (url, options) => {
    requests.push({ url, ...options }); return receipt(options.body);
  });
  api.finish(); await finished(api);
  assert.equal(requests.length, 1);
  assert.equal(validate(JSON.parse(requests[0].body)), true);
  assert.equal(api.saved(), true);
  assert.equal(elements.get('upload-status').textContent, api.UI.uploaded);
  assert.equal(storage.size, 0);
  assert.equal(elements.get('upload-backup').hidden, true);
});

test('lost response retries identical UUID, timestamp, and dataset', async () => {
  const requests = [];
  const { api } = setup(async (url, options) => {
    requests.push(options.body);
    if (requests.length === 1) throw new Error('Connection lost after saving');
    return receipt(options.body);
  });
  api.finish(); await finished(api);
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  assert.equal(api.saved(), true);
});

test('persistent failure retains backup, offers retry and never claims saved', async () => {
  let count = 0;
  const { api, elements, storage } = setup(async () => { count++; return { ok: false, status: 503 }; });
  api.finish(); await finished(api);
  assert.equal(count, 3);
  assert.equal(api.saved(), false);
  assert.equal(elements.get('upload-status').textContent, api.UI.uploadFailed);
  assert.equal(elements.get('upload-retry').hidden, false);
  assert.equal(elements.get('upload-backup').hidden, false);
  assert.equal(storage.size, 1);
});

test('wrong receipt rejected; manual retry preserves original submission', async () => {
  const requests = [];
  const { api } = setup(async (url, options) => {
    requests.push(options.body);
    return requests.length === 1 ? { ok: true, status: 200, json: async () => ({ saved: true, submissionId: 'wrong' }) }
      : receipt(options.body);
  });
  api.finish(); await finished(api);
  assert.equal(api.saved(), false);
  await api.upload();
  assert.equal(api.saved(), true);
  assert.equal(requests[0], requests[1]);
});

test('reload recovers completed pending submission from same tab', async () => {
  const first = setup(async () => ({ ok: false, status: 400 }));
  first.api.finish(); await finished(first.api);
  const pending = JSON.parse(JSON.stringify(first.api.pending()));
  let sent;
  const restored = setup(async (url, options) => { sent = JSON.parse(options.body); return receipt(options.body); }, pending);
  restored.api.finish(); await finished(restored.api);
  assert.deepEqual(sent, pending);
  assert.equal(restored.api.saved(), true);
});

test('upload works with browser storage disabled and blocks concurrent duplicate clicks', async () => {
  let resolveFetch, count = 0;
  const { api } = setup((url, options) => {
    count++; return new Promise(resolve => { resolveFetch = () => resolve(receipt(options.body)); });
  }, null, true);
  api.finish();
  await api.upload();
  assert.equal(count, 1);
  resolveFetch(); await finished(api);
  assert.equal(api.saved(), true);
});

test('six-second exposure, required SAM ratings, five-second preparation and combined upload', async () => {
  let sent, requests = 0;
  const { api, elements, advanceTime } = setup(async (url, options) => {
    requests++; sent = JSON.parse(options.body); return receipt(options.body);
  });
  const expected = api.state.order.map(index => api.CONFIG.trials[index]);
  api.startRatings();
  assert.equal(api.state.phase, 'ratingIntro');
  assert.equal(requests, 0);
  assert.ok(elements.get('ratings-start'));
  elements.get('ratings-start').fire('click');
  for (let i = 0; i < expected.length; i++) {
    const img = elements.get('rating-image');
    assert.equal(img.src, expected[i].image);
    assert.equal(api.state.phase, 'ratingPicture');
    assert.equal(api.state.pictureRatings.length, i);
    assert.equal(img.hidden, true);
    img.fire('load');
    advanceTime(7000); // No exposure starts while the manikins are still loading.
    assert.equal(img.hidden, true);
    elements.get('rating-manikins-preload').fire('load');
    assert.equal(img.hidden, false);
    advanceTime(5999);
    assert.equal(api.state.phase, 'ratingPicture');
    advanceTime(1);
    assert.equal(api.state.phase, 'ratings');
    const next = elements.get('rating-next');
    next.fire('click');
    assert.equal(api.state.pictureRatings.length, i);
    assert.equal(next.disabled, true); // Image load alone cannot select a default answer.
    for (const [key, value] of [['valence', 1+(i%9)], ['arousal', 9-(i%9)], ['relevance', 5]]) {
      assert.equal(next.disabled, true);
      const input = elements.get(`rating-${key}-${value}`);
      assert.notEqual(input.checked, true);
      input.checked = true; input.fire('change');
    }
    assert.equal(next.disabled, false);
    advanceTime(1234);
    next.fire('click'); next.fire('click'); // Rapid double click cannot duplicate a trial.
    assert.equal(api.state.pictureRatings.length, i+1);
    if (i < expected.length - 1) {
      assert.equal(requests, 0);
      assert.equal(api.state.phase, 'ratingPreparation');
      assert.equal(elements.get('rating-preparation').textContent, 'Připravte se na hodnocení dalšího obrázku.');
      advanceTime(4999);
      assert.equal(api.state.phase, 'ratingPreparation');
      advanceTime(1);
      assert.equal(api.state.phase, 'ratingPicture');
    }
  }
  await finished(api);
  assert.equal(requests, 1);
  assert.equal(validate(sent), true); // Compatible with the already deployed collector.
  assert.equal(sent.dataset.schemaVersion, 7);
  assert.equal(sent.dataset.pictureRatings.length, 16);
  assert.equal(sent.dataset.trials.length, 16);
  sent.dataset.pictureRatings.forEach((r, i) => {
    assert.equal(r.variable, sent.dataset.trials[i].variable);
    assert.equal(r.image, sent.dataset.trials[i].image);
    assert.equal(r.mappingPosition, i+1);
    assert.equal(r.valence, 1+(i%9));
    assert.equal(r.arousal, 9-(i%9));
    assert.equal(r.relevance, 5);
    assert.equal(r.pictureDurationMs, 6000);
    assert.equal(r.ratingDurationMs, 1234);
  });
  const csv = api.toCSV(sent.dataset).split('\n').map(row => row.split(','));
  assert.equal(csv.length, 17);
  for (const row of csv) assert.equal(row.length, csv[0].length);
  assert.equal(csv[1][csv[0].indexOf('picture_valence_1_9')], '1');
  assert.equal(csv[4][csv[0].indexOf('picture_arousal_1_9')], '6');
  if (process.env.WRITE_RATING_FIXTURE) {
    sent.dataset.participant = 'SETUP_RATINGS_TEST_NOT_A_PARTICIPANT';
    await writeFile('/tmp/interomap-ratings-smoke.json', JSON.stringify(sent));
  }
});

test('broken rating image prevents exposure until retry loads', () => {
  const { api, elements, advanceTime } = setup(async () => { throw new Error('Should not upload'); });
  api.startRatings(); elements.get('ratings-start').fire('click');
  const img = elements.get('rating-image');
  img.fire('error');
  assert.equal(elements.has('rating-next'), false);
  elements.get('rating-manikins-preload').fire('load');
  advanceTime(6000);
  assert.equal(api.state.phase, 'ratingPicture');
  assert.equal(img.hidden, true);
  assert.equal(elements.get('rating-reload').hidden, false);
  elements.get('rating-reload').fire('click');
  assert.equal(new URL(img.src).pathname, '/interomap/' + api.CONFIG.trials[api.state.order[0]].image);
  assert.ok(new URL(img.src).searchParams.has('retry'));
  img.fire('load');
  assert.equal(elements.get('rating-reload').hidden, true);
  advanceTime(6000);
  assert.equal(elements.get('rating-next').disabled, true);
});

test('SAM and personal relevance rows all descend from 9 to 1', () => {
  const { api, elements, advanceTime } = setup(async () => { throw new Error('Should not upload'); });
  api.startRatings(); elements.get('ratings-start').fire('click');
  elements.get('rating-image').fire('load');
  elements.get('rating-manikins-preload').fire('load');
  advanceTime(6000);
  for (const key of ['valence', 'arousal', 'relevance']) {
    const ids = [...elements.keys()].filter(id => new RegExp(`^rating-${key}-[1-9]$`).test(id));
    assert.deepEqual(ids.map(id => Number(elements.get(id).value)),
      [9,8,7,6,5,4,3,2,1]);
  }
});

test('baseline precedes pictures, captures its own map and exports separately to JSON and CSV', async () => {
  const { api, elements, listeners, advanceTime } = setup(async () => { throw new Error('Should not upload'); });
  api.startBaseline();
  assert.equal(api.state.phase, 'baselineIntro');
  assert.equal(elements.has('mapframe'), false);
  elements.get('baseline-start').fire('click');
  assert.equal(api.state.phase, 'baseline');
  assert.equal(elements.has('picwrap'), false);
  const frame = elements.get('mapframe');
  assert.match(frame.src, /variable=baseline&/);
  assert.match(frame.src, /persona=female&/);
  frame.contentWindow = {};
  const output = { FemaleFront: { strokes: [{ valence: 5, intensity: 9, points: [{ x: 1, y: 2 }] }] } };
  const event = { source: frame.contentWindow, origin: 'https://pesojka.github.io',
    data: { event: 'interomap_data', variable: 'baseline', output: JSON.stringify(output) } };
  listeners.get('message')({ ...event, source: {} });
  assert.equal(api.state.results.baseline, undefined);
  listeners.get('message')(event);
  advanceTime(2345);
  elements.get('map-next').fire('click');
  elements.get('map-next').fire('click');
  assert.equal(api.state.phase, 'pictureTaskIntro');
  elements.get('picture-task-start').fire('click');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(api.state.phase, 'mapping');
  assert.equal(api.state.idx, 0);
  assert.equal(elements.get('progress').textContent, '1 / 16');
  assert.equal(api.state.pictureRatings.length, 0);
  const dataset = JSON.parse(JSON.stringify(api.dataset()));
  assert.equal(dataset.baseline.variable, 'baseline');
  assert.equal(dataset.baseline.type, 'baseline');
  assert.equal(dataset.baseline.image, '');
  assert.equal(dataset.baseline.mapDurationMs, 2345);
  assert.deepEqual(dataset.baseline.output, output);
  assert.equal(dataset.trials.length, 16);
  assert.ok(dataset.trials.every(trial => trial.variable !== 'baseline'));
  assert.deepEqual([dataset.bodyMapScales.min, dataset.bodyMapScales.max], [1, 9]);
  const rows = api.toCSV(dataset).split('\n').map(row => row.split(','));
  assert.equal(rows.length, 18);
  const at = name => rows[0].indexOf(name);
  assert.equal(rows[1][at('map_type')], 'baseline');
  assert.equal(rows[1][at('valence')], '5');
  assert.equal(rows[1][at('intensity')], '9');
  assert.equal(rows[1][at('picture_valence_1_9')], '');
  assert.equal(rows[2][at('map_type')], 'picture');
});

test('an empty baseline is retained and preserved in the combined submission', async () => {
  let sent;
  const { api, elements } = setup(async (url, options) => {
    sent = JSON.parse(options.body); return receipt(options.body);
  });
  api.startBaseline(); elements.get('baseline-start').fire('click');
  elements.get('map-next').fire('click');
  await new Promise(resolve => setTimeout(resolve, 5));
  api.finish(); await finished(api);
  assert.equal(validate(sent), true);
  assert.equal(sent.dataset.baseline.output, null);
  assert.equal(sent.dataset.baseline.responded, false);
  assert.equal(sent.dataset.baseline.mapDurationMs, 0);
  const csv = api.toCSV(sent.dataset).split('\n').map(row => row.split(','));
  assert.equal(csv.length, 18);
  for (const row of csv) assert.equal(row.length, csv[0].length);
});
