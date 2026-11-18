const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');

const html = fs.readFileSync('index.html', 'utf8');
const constants = html.slice(html.indexOf('    const MEMPOOL_DEFAULT'), html.indexOf('    const FEE_CACHE_TTL'));
const implementation = html.slice(html.indexOf('    let mempoolPreferred'), html.indexOf('    function getPendingSyncTotal'));

function harness(fetch, initialBase = 'https://mempool.space/testnet/api') {
  let base = initialBase;
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const context = vm.createContext({
    fetch, AbortController, Date, JSON, Number, Math, Error, Promise,
    performance: { now: () => now },
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    getMempoolApi: () => base.replace(/\/+$/, ''),
    appendLog() {},
    TXID_RE: /^[0-9a-fA-F]{64}$/,
    b2h: b => Buffer.from(b).toString('hex'),
    h2b: h => Uint8Array.from(Buffer.from(h, 'hex')),
    sha256: async b => new Uint8Array(await webcrypto.subtle.digest('SHA-256', b)),
  });
  vm.runInContext(`${constants}\n${implementation}\nthis.api = { mempoolJson, mempoolRequest, broadcastMempoolTx, MEMPOOL_ALTERNATES };`, context);
  return {
    ...context.api,
    setBase(value) { base = value; },
    advance(ms) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

function response(status, text = '', headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: name => headers[name] || null }, body: null, text: async () => text };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('default endpoint fails over and later requests prefer the regional Testnet3 node', async () => {
  const calls = [];
  const app = harness(async url => {
    calls.push(url);
    if (calls.length === 1) throw new TypeError('network error');
    return response(200, '{"confirmed":true}');
  });
  assert.equal(app.MEMPOOL_ALTERNATES.length, 47);
  assert.equal(new Set(app.MEMPOOL_ALTERNATES).size, 47);
  assert.equal((await app.mempoolJson('/tx/abc/status')).confirmed, true);
  await app.mempoolJson('/address/address');
  assert.deepEqual(calls, [
    'https://mempool.space/testnet/api/tx/abc/status',
    'https://node201.va1.mempool.space/testnet/api/tx/abc/status',
    'https://node201.va1.mempool.space/testnet/api/address/address',
  ]);
});

test('a timed-out endpoint is aborted and fails over', async () => {
  const calls = [];
  const app = harness((url, options) => {
    calls.push(url);
    if (calls.length === 1) return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    return Promise.resolve(response(200, '{}'));
  });
  const request = app.mempoolJson('/address/a');
  await flush();
  app.advance(10_000);
  await request;
  assert.match(calls[1], /^https:\/\/node201\.va1\.mempool\.space\/testnet\/api/);
});

test('custom endpoints do not fall back to public Testnet3 nodes', async () => {
  const calls = [];
  const app = harness(async url => { calls.push(url); throw new Error('offline'); }, 'https://example.test/api/');
  await assert.rejects(app.mempoolJson('/address/a'), /offline/);
  assert.deepEqual(calls, ['https://example.test/api/address/a']);
});

test('server errors and invalid JSON trigger failover', async () => {
  const calls = [];
  const app = harness(async url => {
    calls.push(url);
    if (calls.length === 1) return response(503);
    if (calls.length === 2) return response(200, 'not json');
    return response(200, '{"ok":true}');
  });
  assert.equal((await app.mempoolJson('/address/a')).ok, true);
  assert.match(calls[2], /^https:\/\/node202\.va1\.mempool\.space\/testnet\/api/);
});

test('the shared queue limits simultaneous requests to ten starts per burst', async () => {
  const calls = [];
  const app = harness(async url => { calls.push(url); return response(200, '{}'); });
  const requests = Array.from({ length: 11 }, (_, i) => app.mempoolJson(`/address/${i}`));
  await flush();
  assert.equal(calls.length, 10);
  app.advance(9_999);
  await flush();
  assert.equal(calls.length, 10);
  app.advance(1);
  await Promise.all(requests);
  assert.equal(calls.length, 11);
});

test('429 pauses the shared queue according to Retry-After before retrying', async () => {
  const calls = [];
  const app = harness(async url => {
    calls.push(url);
    return calls.length === 1 ? response(429, '', { 'Retry-After': '20' }) : response(200, '{}');
  });
  const request = app.mempoolJson('/address/a');
  await flush();
  assert.equal(calls.length, 1);
  const another = app.mempoolJson('/address/b');
  await flush();
  assert.equal(calls.length, 1);
  app.advance(19_999);
  await flush();
  assert.equal(calls.length, 1);
  app.advance(1);
  await Promise.all([request, another]);
  assert.equal(calls.length, 3);
});

test('client errors are surfaced without failover', async () => {
  const calls = [];
  const app = harness(async url => { calls.push(url); return response(400, 'bad request'); });
  await assert.rejects(app.mempoolJson('/address/a'), /HTTP 400.*bad request/);
  assert.equal(calls.length, 1);
});

test('a lost broadcast response followed by already-known returns the local transaction id', async () => {
  let calls = 0;
  const app = harness(async () => {
    if (++calls === 1) throw new Error('connection lost');
    return response(400, 'txn-already-in-mempool');
  });
  const raw = '01020304';
  const firstHash = createHash('sha256').update(Buffer.from(raw, 'hex')).digest();
  const txid = createHash('sha256').update(firstHash).digest().reverse().toString('hex');
  assert.equal(await app.broadcastMempoolTx(raw), txid);
  assert.equal(calls, 2);
});

test('confirmation polling does not overlap while a request is pending', async () => {
  const source = html.slice(html.indexOf('    let confirmationRefreshRunning'), html.indexOf("    $('unlockBtn')"));
  const row = { cid: 'cid', hasP2fk: false };
  const state = { status: 'broadcasted', txid: 'abc' };
  let resolveRequest;
  let calls = 0;
  const context = vm.createContext({
    S: { comparisonRows: [row] },
    getSyncState: () => state,
    setSyncState: (_, update) => Object.assign(state, update),
    mempoolJson: () => {
      calls++;
      return new Promise(resolve => { resolveRequest = resolve; });
    },
    appendLog() {},
  });
  vm.runInContext(`${source}\nthis.refresh = refreshConfirmationStates;`, context);
  const first = context.refresh();
  await context.refresh();
  assert.equal(calls, 1);
  resolveRequest({ confirmed: true });
  await first;
  assert.equal(state.status, 'confirmed');
  assert.equal(row.hasP2fk, true);
});
