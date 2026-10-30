import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('experiment.html', root), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace('if (completedSubmission) screenEnd(); else screenConsent();', '');
const plain = value => JSON.parse(JSON.stringify(value));
const expected = {
  threat: ['1300', '1525', '2811', '6510'],
  integrity_disruption: ['3030', '3213', '3261', '9042'],
  positive_1: ['1463', '1710', '1920', '2071'],
  positive_2: ['2347', '5628', '7325', '8540']
};

function setup() {
  const elements = new Map(), listeners = new Map(), timers = new Map();
  const requests = [];
  let now = 0, timerId = 0;
  function element(tag) {
    const handlers = new Map();
    const node = {
      children: [], hidden: false, textContent: '', contentWindow: tag === 'iframe' ? {} : undefined,
      set id(id) { this._id = id; elements.set(id, this); }, get id() { return this._id; },
      set innerHTML(value) {
        const remove = child => { if (child.id) elements.delete(child.id); child.children.forEach(remove); };
        this.children.forEach(remove); this.children = []; this._html = value;
      },
      get innerHTML() { return this._html || ''; },
      appendChild(child) { this.children.push(child); },
      setAttribute() {}, addEventListener(name, handler) { handlers.set(name, handler); },
      fire(name) { handlers.get(name)?.(); }
    };
    return node;
  }
  for (const id of ['app', 'progress']) { const e = element('div'); e.id = id; }
  const context = vm.createContext({
    document: { createElement: element, getElementById: id => elements.get(id) },
    window: { addEventListener: (name, handler) => listeners.set(name, handler) },
    location: { href: 'https://pesojka.github.io/interomap/experiment.html' },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: webcrypto, AbortController, URL, performance: { now: () => now },
    requestAnimationFrame: fn => fn(),
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, due: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      return { ok: true, status: 201, json: async () => ({ saved: true, submissionId: body.submissionId }) };
    }
  });
  vm.runInContext(source + `\n globalThis.api = {
    CONFIG, CONSENT, state, createTrialOrder, buildDataset, toCSV, screenConsent, screenIntro, screenBaselineIntro, runTrial, showRating,
    saved: () => uploadSaved
  };`, context);
  const advance = ms => {
    const until = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, t]) => t.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      now = next[1].due; timers.delete(next[0]); next[1].fn();
    }
    now = until;
  };
  return { api: context.api, elements, listeners, advance, requests };
}

function checkOrder(order, trials) {
  assert.equal(order.length, 16);
  assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i));
  const blocks = [];
  for (let i = 0; i < 16; i += 4) {
    const group = order.slice(i, i + 4).map(index => trials[index]);
    assert.equal(new Set(group.map(t => t.block)).size, 1);
    blocks.push(group[0].block);
    assert.deepEqual(group.map(t => t.image.match(/(\d+)\.jpg$/)[1]).sort(), expected[group[0].block]);
  }
  assert.equal(new Set(blocks).size, 4);
}

test('manifest has the exact 16 images, stable unique variables and both positive blocks', async () => {
  const { api } = setup();
  const trials = plain(api.CONFIG.trials);
  checkOrder(trials.map((_, i) => i), trials);
  assert.equal(new Set(trials.map(t => t.variable)).size, 16);
  assert.equal(new Set(trials.map(t => t.image)).size, 16);
  for (const t of trials) {
    assert.match(t.variable, /^[A-Za-z][A-Za-z0-9_]{0,99}$/);
    assert.equal(t.condition, t.block.startsWith('positive_') ? 'positive' : t.block);
    const image = await readFile(new URL(t.image, root));
    assert.equal(image.readUInt16BE(0), 0xffd8, `${t.image} must be a JPEG`);
  }
});

test('all 24 block permutations are reachable without splitting blocks or changing the manifest', () => {
  const { api } = setup();
  const trials = plain(api.CONFIG.trials), original = JSON.stringify(trials), permutations = new Set();
  for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 2; c++) {
    const draws = [(a + 0.5) / 4, (b + 0.5) / 3, (c + 0.5) / 2];
    const order = plain(api.createTrialOrder(trials, () => draws.length ? draws.shift() : 0.999));
    checkOrder(order, trials);
    permutations.add(order.filter((_, i) => i % 4 === 0).map(index => trials[index].block).join(','));
  }
  assert.equal(permutations.size, 24);
  assert.equal(JSON.stringify(trials), original);
});

test('all 24 image permutations are reachable independently in each of the four blocks', () => {
  const { api } = setup();
  const trials = plain(api.CONFIG.trials);
  for (let block = 0; block < 4; block++) {
    const permutations = new Set();
    for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 2; c++) {
      const draws = Array(15).fill(0.999);
      draws.splice(3 + block * 3, 3, (a + 0.5) / 4, (b + 0.5) / 3, (c + 0.5) / 2);
      const order = plain(api.createTrialOrder(trials, () => draws.shift()));
      checkOrder(order, trials);
      permutations.add(order.slice(block * 4, block * 4 + 4).join(','));
      for (let other = 0; other < 4; other++) if (other !== block) {
        assert.deepEqual(order.slice(other * 4, other * 4 + 4), Array.from({ length: 4 }, (_, i) => other * 4 + i));
      }
    }
    assert.equal(permutations.size, 24);
  }
});

test('many participant sessions preserve every block and image while varying both orders', () => {
  const { api } = setup();
  const trials = plain(api.CONFIG.trials), blockOrders = new Set(), orders = new Set();
  let seed = 20261030;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let session = 0; session < 1000; session++) {
    const order = plain(api.createTrialOrder(trials, random));
    checkOrder(order, trials);
    orders.add(order.join(','));
    blockOrders.add(order.filter((_, i) => i % 4 === 0).map(index => trials[index].block).join(','));
  }
  assert.equal(blockOrders.size, 24);
  assert.ok(orders.size > 900);
});

test('consent, practice, baseline and all 16 maps and ratings export correct responses and metadata', async () => {
  const { api, elements, listeners, advance, requests } = setup();
  api.state.participant = 'LOCAL_BLOCK_TEST';
  const order = plain(api.state.order), trials = plain(api.CONFIG.trials);
  checkOrder(order, trials);
  api.CONFIG.askParticipantId = false;
  api.CONFIG.choosePersonaOnce = false;
  api.screenConsent();
  const checkbox = elements.get('consent-checkbox');
  checkbox.checked = true; checkbox.fire('change');
  elements.get('consent-continue').fire('click');
  assert.equal(api.state.phase, 'intro');
  elements.get('participant-start').fire('click');
  assert.equal(api.state.phase, 'practiceIntro');
  elements.get('practice-start').fire('click');
  assert.equal(api.state.phase, 'practice');
  const practiceFrame = elements.get('mapframe');
  assert.match(practiceFrame.src, /variable=practice&/);
  listeners.get('message')({ source: practiceFrame.contentWindow, origin: 'https://pesojka.github.io',
    data: { event: 'interomap_data', variable: 'practice',
      output: JSON.stringify({ FemaleFront: { strokes: [{ valence: 9, intensity: 9, points: [] }] } }) } });
  assert.equal(api.state.results.practice, undefined);
  assert.equal(requests.length, 0);
  advance(4567);
  const practiceDone = elements.get('map-next'); practiceDone.fire('click'); practiceDone.fire('click');
  assert.equal(api.state.phase, 'baselineIntro');
  assert.deepEqual(plain(api.state.practice), { completed: true, durationMs: 4567 });
  assert.equal(api.state.meta.practice, undefined);
  assert.deepEqual(plain(api.state.order), order);
  elements.get('baseline-start').fire('click');
  assert.notEqual(elements.get('mapframe'), practiceFrame);
  assert.match(elements.get('mapframe').src, /variable=baseline&/);
  advance(1234);
  elements.get('map-next').fire('click');
  assert.equal(api.state.phase, 'pictureTaskIntro');
  assert.equal(elements.has('mapframe'), false);
  assert.equal(elements.get('progress').textContent, '');
  advance(30000); // Instructions remain until the participant chooses to continue.
  assert.equal(api.state.phase, 'pictureTaskIntro');
  assert.equal(elements.has('mapping-image'), false);
  assert.equal(requests.length, 0);
  const pictureStart = elements.get('picture-task-start');
  pictureStart.fire('click'); pictureStart.fire('click');
  assert.equal(elements.has('blank'), true);
  advance(1000);
  for (let i = 0; i < 16; i++) {
    const trial = trials[order[i]], img = elements.get('mapping-image');
    assert.equal(img.src, trial.image);
    assert.equal(elements.get('progress').textContent, `${i + 1} / 16`);
    assert.equal(img.hidden, true);
    advance(7000); // Loading time is not included in the six-second exposure.
    assert.equal(elements.has('mapframe'), false);
    if (i === 0) {
      img.fire('error');
      assert.equal(elements.get('mapping-reload').hidden, false);
      advance(7000);
      assert.equal(elements.has('mapframe'), false);
      elements.get('mapping-reload').fire('click');
      assert.equal(new URL(img.src).pathname, '/interomap/' + trial.image);
      assert.ok(new URL(img.src).searchParams.has('retry'));
    }
    img.fire('load'); img.fire('load'); // Duplicate load events must not advance twice.
    assert.equal(img.hidden, false);
    advance(5999);
    assert.equal(elements.has('mapping-image'), true);
    advance(1);
    assert.equal(elements.has('blank'), true);
    advance(1000);
    const frame = elements.get('mapframe');
    assert.equal(new URL(frame.src, 'https://example.org').searchParams.get('variable'), trial.variable);
    // An empty map is a valid response; one map contains a stroke for CSV coverage.
    if (i === 0) listeners.get('message')({ source: frame.contentWindow, origin: 'https://pesojka.github.io',
      data: { event: 'interomap_data', variable: trial.variable,
        output: JSON.stringify({ FemaleFront: { strokes: [{ valence: 5, intensity: 7, points: [] }] } }) } });
    advance(2345);
    const next = elements.get('map-next'); next.fire('click'); next.fire('click');
    advance(1000);
    assert.equal(requests.length, 0);
  }
  assert.equal(api.state.phase, 'ratingIntro');
  elements.get('ratings-start').fire('click');
  for (let i = 0; i < 16; i++) {
    const img = elements.get('rating-image');
    assert.equal(img.src, trials[order[i]].image);
    img.fire('load'); elements.get('rating-manikins-preload').fire('load');
    advance(5999);
    assert.equal(api.state.phase, 'ratingPicture');
    advance(1);
    assert.equal(api.state.phase, 'ratings');
    const next = elements.get('rating-next');
    assert.equal(next.disabled, true);
    for (const key of ['valence', 'arousal', 'relevance']) {
      const value = key === 'relevance' ? (i === 0 ? 9 : i === 1 ? 1 : 5) : 5;
      const input = elements.get(`rating-${key}-${value}`); input.checked = true; input.fire('change');
    }
    advance(3456);
    next.fire('click'); next.fire('click');
    if (i < 15) {
      assert.equal(requests.length, 0);
      assert.equal(api.state.phase, 'ratingPreparation');
      advance(5000);
    }
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.saved(), true);
  assert.equal(requests.length, 1);
  const dataset = requests[0].dataset;
  assert.equal(dataset.schemaVersion, 5);
  assert.equal(dataset.consent.accepted, true);
  assert.equal(dataset.consent.version, api.CONSENT.version);
  assert.equal(dataset.consent.provisional, true);
  assert.ok(Number.isFinite(Date.parse(dataset.consent.acceptedAt)));
  assert.deepEqual(dataset.practice, { completed: true, durationMs: 4567 });
  assert.equal(dataset.trials.some(t => t.variable === 'practice'), false);
  assert.equal(dataset.pictureRatings.some(t => t.variable === 'practice'), false);
  assert.equal(dataset.ratingScales.relevanceDisplayOrder, '9-to-1');
  assert.deepEqual(dataset.bodyMapBrush, { size: 32, label: 'medium', fixed: true });
  assert.deepEqual(plain(api.state.order), order);
  assert.equal(dataset.baseline.variable, 'baseline');
  assert.equal(dataset.baseline.block, null);
  assert.equal(dataset.baseline.mapDurationMs, 1234);
  assert.equal(dataset.trials.length, 16);
  assert.equal(dataset.pictureRatings.length, 16);
  const blockOrder = order.filter((_, i) => i % 4 === 0).map(index => trials[index].block);
  assert.deepEqual(dataset.randomization.blockOrder, blockOrder);
  for (let i = 0; i < 16; i++) {
    const map = dataset.trials[i], rating = dataset.pictureRatings[i], configured = trials[order[i]];
    for (const record of [map, rating]) {
      for (const key of ['variable', 'image', 'block', 'condition']) assert.equal(record[key], configured[key]);
      assert.equal(record.position, i + 1);
      assert.equal(record.blockPosition, Math.floor(i / 4) + 1);
      assert.equal(record.positionWithinBlock, i % 4 + 1);
    }
    assert.equal(map.mapDurationMs, 2345);
    assert.equal(rating.mappingPosition, i + 1);
    assert.equal(rating.relevance, i === 0 ? 9 : i === 1 ? 1 : 5);
    assert.equal(rating.pictureDurationMs, 6000);
    assert.equal(rating.ratingDurationMs, 3456);
  }
  const rows = api.toCSV(dataset).split('\n').map(row => row.split(','));
  assert.equal(rows.length, 18);
  const at = name => rows[0].indexOf(name);
  for (const row of rows) assert.equal(row.length, rows[0].length);
  assert.equal(rows[1][at('block')], '');
  assert.equal(rows[1][at('consent_accepted')], 'true');
  assert.equal(rows[1][at('consent_version')], api.CONSENT.version);
  assert.equal(rows[1][at('practice_completed')], 'true');
  assert.equal(rows[2][at('valence')], '5');
  for (let i = 0; i < 16; i++) {
    assert.equal(rows[i + 2][at('block')], dataset.trials[i].block);
    assert.equal(rows[i + 2][at('condition')], dataset.trials[i].condition);
    assert.equal(rows[i + 2][at('block_position')], String(Math.floor(i / 4) + 1));
    assert.equal(rows[i + 2][at('position_within_block')], String(i % 4 + 1));
  }
});


test('consent is unchecked initially and cannot be bypassed or continued after unchecking', () => {
  const { api, elements, requests } = setup();
  api.CONFIG.askParticipantId = false;
  api.CONFIG.choosePersonaOnce = false;
  api.screenIntro(); // A direct attempt to enter setup must still show consent.
  assert.equal(api.state.phase, 'consent');
  const checkbox = elements.get('consent-checkbox'), next = elements.get('consent-continue');
  assert.equal(checkbox.checked, false);
  assert.equal(checkbox.required, true);
  assert.equal(next.disabled, true);
  next.fire('click');
  assert.equal(api.state.consent, null);
  assert.equal(api.state.phase, 'consent');
  checkbox.checked = true; checkbox.fire('change');
  assert.equal(next.disabled, false);
  checkbox.checked = false; checkbox.fire('change');
  next.fire('click');
  assert.equal(api.state.consent, null);
  assert.equal(next.disabled, true);
  checkbox.checked = true; checkbox.fire('change'); next.fire('click');
  assert.equal(api.state.phase, 'intro');
  assert.equal(api.state.consent.accepted, true);
  assert.equal(requests.length, 0);
});

test('all rating rows descend from 9 to 1 and relevance anchors match their stored values', () => {
  const { api, elements } = setup();
  api.showRating(0, 6000);
  for (const key of ['valence', 'arousal', 'relevance']) {
    const ids = [...elements.keys()].filter(id => new RegExp(`^rating-${key}-[1-9]$`).test(id));
    assert.deepEqual(ids.map(id => Number(elements.get(id).value)), [9,8,7,6,5,4,3,2,1]);
  }
  const all = [];
  const collect = node => { all.push(node); node.children.forEach(collect); };
  collect(elements.get('app'));
  const anchors = all.filter(node => node.className === 'rating-anchors');
  assert.deepEqual(anchors[2].children.map(node => node.textContent), ['9 — Mimořádně', '1 — Vůbec ne']);
});
