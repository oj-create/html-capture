const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

function request(fetch, asText = false) {
  let listener;
  vm.runInNewContext(background, {
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    fetch, AbortController, Uint8Array, btoa,
    setTimeout: fn => setTimeout(fn, 10), clearTimeout,
  });
  return new Promise(resolve => listener({ action: 'fetchResource', url: 'https://example.test/file', asText }, {}, resolve));
}
const untilAbort = signal => new Promise((resolve, reject) => {
  signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
});

test('stalled network request times out', async () => {
  const result = await request((url, options) => untilAbort(options.signal));
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
});
test('stalled response body times out', async () => {
  const result = await request(async (url, options) => ({
    ok: true, headers: new Headers(), text: () => untilAbort(options.signal),
  }), true);
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
});
test('normal resource still becomes a data URL', async () => {
  const result = await request(async () => new Response('image', { headers: { 'content-type': 'image/png' } }));
  assert.equal(result.dataUrl, 'data:image/png;base64,aW1hZ2U=');
});
test('HTTP failures are reported', async () => {
  const result = await request(async () => new Response('', { status: 403 }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'HTTP 403');
});
test('content script survives a worker that never calls back', async () => {
  const start = content.indexOf('  let skippedResources = new Set();');
  const end = content.indexOf('  // ── CSS processing', start);
  const context = vm.createContext({
    chrome: { runtime: { sendMessage() {} } },
    setTimeout: fn => setTimeout(fn, 10), clearTimeout,
  });
  vm.runInContext(content.slice(start, end) + '\nglobalThis.run = bgFetch; globalThis.skipped = skippedResources;', context);
  assert.equal(await context.run('https://example.test/stalled'), null);
  assert.equal(context.skipped.size, 1);
});
test('performance API fetch entries are not treated as binary assets', () => {
  assert.doesNotMatch(content, /\['css', 'embed', 'fetch'/);
});
