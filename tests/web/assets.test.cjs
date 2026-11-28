const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../../cmake/emscripten/asset-loader.js'), 'utf8');
const data = new Map([['System/Default.ini', Buffer.from('[Engine]\n')], ['Maps/00_Training.dx', Buffer.from('test map bytes')]]);
const files = [...data].map(([path, bytes]) => ({ path, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), startup: path.endsWith('.ini') }));

async function page({ failPath, badBytes, storageDisabled = false, corruptCache = false, manifest = { version: 1, files }, networkError = false, query = '' } = {}) {
    const disk = new Map(); const requests = []; const errors = []; const dependencies = new Set();
    const store = new Map();
    if (corruptCache) store.set('https://assets.example/game/Maps/00_Training.dx?opende-sha256=' + files[1].sha256, new Response('corrupt'));
    let fail = failPath;
    let readyCalls = 0;
    const Module = { arguments: ['--width', '800'], postRun: [() => readyCalls++], assetBaseURL: 'https://assets.example/game/', preRun: [], onAbort: text => errors.push(text), setStatus() {} };
    const context = {
        Module, URL, Response, Uint8Array, AbortController, performance, crypto: crypto.webcrypto,
        document: { baseURI: 'https://page.example/index.html' + query, hidden: false, hasFocus: () => true },
        console: { error() {} },
        caches: { async open() { if (storageDisabled) throw Error('storage denied'); return {
            async match(key) { return store.get(key)?.clone(); }, async delete(key) { return store.delete(key); },
            async put(key, response) { store.set(key, response.clone()); }
        }; } },
        FS: { mkdirTree() {}, stat(path) { if (!disk.has(path)) throw Error('ENOENT'); return { size: disk.get(path).length }; },
            writeFile(path, bytes) { disk.set(path, Buffer.from(bytes)); }, unlink(path) { disk.delete(path); } },
        addRunDependency(name) { dependencies.add(name); }, removeRunDependency(name) { dependencies.delete(name); },
        setTimeout(callback, ms) { return ms < 90000 ? setTimeout(callback, 0) : null; }, clearTimeout,
        async fetch(url) {
            if (url.endsWith('full-game-assets.json')) return Response.json(manifest);
            const path = new URL(url).pathname.slice('/game/'.length); requests.push(path);
            if (path === fail && networkError) throw new TypeError('Failed to fetch');
            if (path === fail) return new Response('missing', { status: 404 });
            return new Response(path === badBytes ? Buffer.alloc(data.get(path).length) : data.get(path));
        }
    };
    vm.runInNewContext(source, context);
    Module.preRun.forEach(fn => fn());
    for (let i = 0; i < 100 && dependencies.size && !errors.length; i++) await new Promise(r => setTimeout(r, 2));
    return { Module, disk, requests, errors, dependencies, context, store, readyCalls: () => readyCalls, recover() { fail = undefined; } };
}

test('startup downloads configuration only and registers package placeholders', async () => {
    const p = await page(); assert.equal(p.dependencies.size, 0);
    assert.deepEqual(p.requests, ['System/Default.ini']);
    assert.equal(p.disk.get('/game/Maps/00_Training.dx').length, 0);
    assert.equal(await p.Module.ensureAsset('/game/Maps/00_Training.dx'), 1);
    assert.deepEqual(p.disk.get('/game/Maps/00_Training.dx'), data.get('Maps/00_Training.dx'));
    assert.deepEqual(p.requests, ['System/Default.ini', 'Maps/00_Training.dx']);
});
test('concurrent requests deduplicate; released packages reload from verified cache', async () => {
    const p = await page();
    await Promise.all([p.Module.ensureAsset('/game/Maps/00_Training.dx'), p.Module.ensureAsset('/game/Maps/00_Training.dx')]);
    p.Module.releaseAsset('/game/Maps/00_Training.dx');
    assert.equal(p.disk.get('/game/Maps/00_Training.dx').length, 0);
    await p.Module.ensureAsset('/game/Maps/00_Training.dx');
    assert.equal(p.requests.filter(x => x.endsWith('.dx')).length, 1);
    assert.equal(p.Module.assetStats.cacheHits.length, 1);
    assert.equal(p.Module.assetDownloadPending, false);
});
test('bad cached bytes are discarded and downloaded again', async () => {
    const p = await page({ corruptCache: true });
    assert.equal(await p.Module.ensureAsset('/game/Maps/00_Training.dx'), 1);
    assert.equal(p.Module.assetStats.cacheHits.length, 0);
    assert.equal(p.requests.filter(x => x.endsWith('.dx')).length, 1);
});
test('cache denial does not prevent loading', async () => {
    const p = await page({ storageDisabled: true });
    assert.equal(await p.Module.ensureAsset('/game/Maps/00_Training.dx'), 1);
    assert.equal(p.errors.length, 0);
});
test('404 errors retry but never expose an incomplete package', async () => {
    const p = await page({ failPath: 'Maps/00_Training.dx' });
    assert.equal(await p.Module.ensureAsset('/game/Maps/00_Training.dx'), 0);
    assert.equal(p.requests.filter(x => x.endsWith('.dx')).length, 3);
    assert.equal(p.disk.get('/game/Maps/00_Training.dx').length, 0);
    assert.match(p.errors[0], /00_Training.dx: HTTP 404/);
    assert.equal(p.Module.assetDownloadPending, false);
});
test('checksum mismatch does not enter the filesystem or cache', async () => {
    const p = await page({ badBytes: 'Maps/00_Training.dx' });
    assert.equal(await p.Module.ensureAsset('/game/Maps/00_Training.dx'), 0);
    assert.equal(p.disk.get('/game/Maps/00_Training.dx').length, 0);
    assert.equal(p.store.size, 1); // Only the startup INI.
    assert.match(p.errors[0], /checksum mismatch/);
});
test('failed startup leaves main blocked and reports the missing file', async () => {
    const p = await page({ failPath: 'System/Default.ini' });
    assert.equal(p.dependencies.size, 1);
    assert.match(p.errors[0], /Default.ini/);
});
test('local saves bypass remote loading, and hidden/downloading frames cannot reenter WASM', async () => {
    const p = await page();
    assert.equal(await p.Module.ensureAsset('/home/web_user/save.dx'), 1);
    assert.equal(p.requests.length, 1);
    p.context.document.hidden = true; assert.equal(p.Module.preMainLoop(), false);
    p.context.document.hidden = false; p.Module.assetDownloadPending = true; assert.equal(p.Module.preMainLoop(), false);
});
test('unsafe manifest paths cannot be written outside the game directories', async () => {
    const p = await page({ manifest: { version: 1, files: [{ ...files[0], path: 'System/../../save' }] } });
    assert.equal(p.disk.size, 0); assert.equal(p.dependencies.size, 1); assert.match(p.errors[0], /invalid asset/);
});

test('network failures identify the affected package', async () => {
    const p = await page({ failPath: 'Maps/00_Training.dx', networkError: true });
    assert.equal(await p.Module.ensureAsset('/game/Maps/00_Training.dx'), 0);
    assert.match(p.errors[0], /Maps\/00_Training.dx: Failed to fetch/);
});
test('shell callbacks wait until C++ startup has finished', async () => {
    const p = await page();
    p.Module.postRun.forEach(fn => fn());
    assert.equal(p.readyCalls(), 0);
    p.Module.notifyGameReady();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(p.readyCalls(), 1);
    assert.equal(p.Module.gameReady, true);
});

test('direct map selection appends to the runtime argument array', async () => {
    const p = await page({ query: '?map=00_Training' });
    assert.deepEqual(p.Module.arguments, ['--width', '800', '00_Training']);
    assert.equal(p.requests.filter(x => x.endsWith('.dx')).length, 0);
});
