// Included with --pre-js only in loose-asset builds. Native/bundled builds are unchanged.
(function () {
    const base = Module['assetBaseURL'] || 'https://storage.googleapis.com/demos_opende/full_game/deus_ex_data/';
    const manifestURL = Module['assetManifestURL'] || new URL('full-game-assets.json', document.baseURI).href;
    const entries = new Map();
    const pending = new Map();
    let cachePromise;
    let fatal = false;
    // Asyncify returns from main on its first suspension, before Game exists.
    // Defer the shell's input/audio lifecycle hooks until C++ finishes startup.
    const readyCallbacks = [];
    Module['postRun'] = (Module['postRun'] || []).map(callback => () => readyCallbacks.push(callback));
    Module['notifyGameReady'] = () => setTimeout(() => {
        Module['gameReady'] = true;
        for (const callback of readyCallbacks.splice(0)) callback();
    }, 0);
    const stats = Module['assetStats'] = { downloads: [], cacheHits: [], bytes: 0 };

    function status(text) {
        if (!fatal && Module['setStatus']) Module['setStatus'](text);
    }
    function fail(error) {
        fatal = true;
        const message = 'Asset download failed: ' + error.message + '. Reload to retry.';
        if (Module['onAbort']) Module['onAbort'](message);
        console.error(message);
    }
    async function cache() {
        if (!cachePromise) cachePromise = Promise.resolve().then(() => caches.open('opende-assets-v1')).catch(() => null);
        return cachePromise;
    }
    async function verify(bytes, entry) {
        if (bytes.byteLength !== entry.size) throw new Error(entry.path + ': incorrect file size');
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        const hex = Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
        if (hex !== entry.sha256) throw new Error(entry.path + ': checksum mismatch');
    }
    async function download(entry) {
        const url = new URL(entry.path.split('/').map(encodeURIComponent).join('/'), base).href;
        const key = url + '?opende-sha256=' + entry.sha256;
        const storage = await cache();
        if (storage) {
            try {
                const saved = await storage.match(key);
                if (saved) {
                    const bytes = await saved.arrayBuffer();
                    await verify(bytes, entry);
                    stats.cacheHits.push(entry.path);
                    return new Uint8Array(bytes);
                }
            } catch (_) {
                try { await storage.delete(key); } catch (_) { /* Cache is optional. */ }
            }
        }
        let bytes;
        for (let attempt = 0; attempt < 3; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 90000);
            try {
                const response = await fetch(url, { signal: controller.signal, credentials: 'omit', cache: 'no-cache' });
                if (!response.ok) throw new Error(entry.path + ': HTTP ' + response.status);
                bytes = await response.arrayBuffer();
                await verify(bytes, entry);
                break;
            } catch (error) {
                if (attempt === 2) {
                    const message = error.message || String(error);
                    throw new Error(message.startsWith(entry.path + ':') ? message : entry.path + ': ' + message);
                }
                await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
            } finally {
                clearTimeout(timeout);
            }
        }
        stats.downloads.push(entry.path);
        stats.bytes += bytes.byteLength;
        if (storage) {
            try { await storage.put(key, new Response(bytes)); } catch (_) { /* Quota/private mode: continue uncached. */ }
        }
        return new Uint8Array(bytes);
    }
    async function ensure(path) {
        const entry = entries.get(path);
        if (!entry) return; // Saved games and user packages are local files.
        if (FS.stat(path).size === entry.size) return;
        if (pending.has(path)) return pending.get(path);
        const started = performance.now();
        const task = (async () => {
            Module['assetDownloadPending'] = true;
            status('Loading ' + entry.path + '…');
            const bytes = await download(entry);
            FS.writeFile(path, bytes, { canOwn: true });
        })();
        pending.set(path, task);
        try { await task; } finally {
            Module['assetWaitSeconds'] = (Module['assetWaitSeconds'] || 0) + (performance.now() - started) / 1000;
            pending.delete(path);
            Module['assetDownloadPending'] = pending.size > 0;
            if (!pending.size) status('');
        }
    }
    Module['ensureAsset'] = async path => {
        try { await ensure(path); return 1; } catch (error) { fail(error); return 0; }
    };
    Module['releaseAsset'] = path => {
        const entry = entries.get(path);
        // Package owns its C++ copy now; retain only the browser disk cache.
        if (entry && !entry.startup) { FS.unlink(path); FS.writeFile(path, new Uint8Array(0)); }
    };
    const priorPreMainLoop = Module['preMainLoop'];
    Module['preMainLoop'] = () => {
        if (Module['assetDownloadPending'] || document.hidden || !document.hasFocus()) return false;
        return priorPreMainLoop ? priorPreMainLoop() : undefined;
    };
    Module['preRun'] = Module['preRun'] || [];
    Module['preRun'].push(() => {
        addRunDependency('loose-assets');
        (async () => {
            status('Loading asset index…');
            const response = await fetch(manifestURL, { cache: 'no-cache' });
            if (!response.ok) throw new Error('asset index: HTTP ' + response.status);
            const manifest = await response.json();
            if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('unsupported asset index');
            for (const entry of manifest.files) {
                if (!/^(System|Maps|Textures|Sounds|Music)\/[A-Za-z0-9_. -]+$/.test(entry.path) ||
                    ['.', '..'].includes(entry.path.split('/')[1]) || !Number.isSafeInteger(entry.size) || entry.size <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
                    typeof entry.startup !== 'boolean' || entries.has('/game/' + entry.path)) throw new Error('invalid asset index entry');
                const path = '/game/' + entry.path;
                entries.set(path, entry);
                FS.mkdirTree(path.substring(0, path.lastIndexOf('/')));
                FS.writeFile(path, new Uint8Array(0));
            }
            const requestedMap = new URL(document.baseURI).searchParams.get('map');
            if (requestedMap) {
                if (!entries.has('/game/Maps/' + requestedMap + '.dx')) throw new Error('unknown map: ' + requestedMap);
                // Emscripten already holds this array when preRun executes.
                Module['arguments'].push(requestedMap);
            }
            // Small configuration/localization files must exist before C++ startup.
            const startup = Array.from(entries).filter(([, entry]) => entry.startup).map(([path]) => path);
            let next = 0;
            await Promise.all(Array.from({ length: 6 }, async () => {
                while (next < startup.length) await ensure(startup[next++]);
            }));
            status('');
            removeRunDependency('loose-assets');
        })().catch(fail); // Keep the dependency on failure: never run against partial files.
    });
})();
