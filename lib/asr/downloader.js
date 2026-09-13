/**
 * Model downloader (design D4): sequential 3-file download with per-file
 * HTTP Range resume (.part), sha256 + size verification, disk space
 * precheck, cancellation that keeps partial files, and a main-process
 * state machine (idle → downloading → verifying → ready | error).
 *
 * State is module-level singleton, mirroring engine-local's recognizer
 * singleton style. Progress is throttled; subscribers get full snapshots.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { net } = require('electron');
const {
  MODEL_FILES,
  DOWNLOAD_BASES,
  DEFAULT_MODEL_SOURCE,
  TOTAL_DOWNLOAD_BYTES,
  resolveModelDir,
  isLocalModelReady
} = require('./model-registry');

const PROGRESS_THROTTLE_MS = 200;
const DISK_MARGIN_BYTES = 50 * 1024 * 1024;

let state = 'idle'; // idle | downloading | verifying | ready | error
let lastError = null;
let cancelRequested = false;
let running = false;
let progress = null; // { file, fileIndex, filePercent, totalPercent }
let subscribers = [];
let lastEmit = 0;

function status() {
  // Disk is the source of truth for "ready": a fresh process (or a window
  // reopened after a finished download) reports ready even though this
  // state machine is still at idle.
  if (!running && (state === 'idle' || state === 'error') && isLocalModelReady()) {
    return { state: 'ready', error: null, progress: null };
  }
  return { state, error: lastError, progress };
}

function subscribe(cb) {
  subscribers.push(cb);
  return () => { subscribers = subscribers.filter(f => f !== cb); };
}

function emit(force) {
  const now = Date.now();
  if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
  lastEmit = now;
  const snapshot = status();
  subscribers.forEach(cb => { try { cb(snapshot); } catch (_) { /* listener bugs must not kill the download */ } });
}

function setState(next, error) {
  state = next;
  lastError = error || null;
  emit(true);
}

/** Available disk space precheck; unresolvable → allow (design risk note). */
async function ensureDiskSpace() {
  const dir = resolveModelDir();
  fs.mkdirSync(dir, { recursive: true });
  try {
    const st = await fs.promises.statfs(dir);
    const free = st.bavail * Number(st.bsize);
    // subtract what is already on disk (finals + parts) so resume doesn't over-require
    let already = 0;
    for (const f of MODEL_FILES) {
      for (const p of [path.join(dir, f.name), path.join(dir, f.name + '.part')]) {
        try { already += Math.min(fs.statSync(p).size, f.size); } catch (_) { /* absent */ }
      }
    }
    const needed = Math.max(0, TOTAL_DOWNLOAD_BYTES - already) + DISK_MARGIN_BYTES;
    if (free < needed) {
      throw new Error(`磁盘空间不足：需要约 ${(needed / 1e6).toFixed(0)}MB，可用 ${(free / 1e6).toFixed(0)}MB`);
    }
  } catch (err) {
    if (err.message.includes('磁盘空间不足')) throw err;
    // statfs unavailable on this filesystem → proceed, disk-full fails via normal error path
  }
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p)
      .on('data', d => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/**
 * GET via net.request. Unlike net.fetch (Fetch-spec, forbidden headers),
 * this lets us send Accept-Encoding: identity - required because the CDN
 * gzip-serves text files, which breaks byte-exact Range resume.
 */
function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, headers });
    req.on('response', res => resolve({ req, res }));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Download one file with Range resume. Streams the response body to
 * <name>.part, verifies size + sha256, then renames to the final name.
 */
async function downloadFile(base, file, fileIndex, bytesDoneBefore) {
  const dir = resolveModelDir();
  const finalPath = path.join(dir, file.name);
  const partPath = finalPath + '.part';

  for (let attempt = 0; ; attempt++) {
    if (attempt > 2) throw new Error(`下载反复失败: ${file.name}`);

    let startByte = 0;
    try {
      startByte = fs.statSync(partPath).size;
      if (startByte >= file.size) { fs.rmSync(partPath); startByte = 0; } // stale part without final
    } catch (_) { startByte = 0; }

    const headers = { 'Accept-Encoding': 'identity' };
    if (startByte > 0) headers.Range = `bytes=${startByte}-`;

    const { req, res } = await httpGet(`${base}/${file.name}`, headers);
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      throw new Error(`下载失败 (HTTP ${res.statusCode}): ${file.name}`);
    }

    const partial = res.statusCode === 206;
    // Resume only on an uncompressed 206. The Chromium network layer ignores
    // our Accept-Encoding: identity and may gzip text assets; a byte range
    // sliced mid-gzip-stream cannot align with decoded content (and fails
    // with ERR_CONTENT_DECODING_FAILED). Fresh 200s are fine either way -
    // gzip responses are transparently decoded to the original bytes.
    if (startByte > 0 && (!partial || res.headers['content-encoding'])) {
      req.abort();
      fs.rmSync(partPath, { force: true });
      continue; // retry as a fresh download
    }
    if (startByte > 0 && !partial) startByte = 0;

    const writer = fs.createWriteStream(partPath, { flags: partial ? 'a' : 'w' });
    let received = 0;
    let streamError = null;

    await new Promise((resolve, reject) => {
      res.on('data', chunk => {
        if (cancelRequested) { req.abort(); resolve(); return; }
        received += chunk.length;
        const total = startByte + received;
        progress = {
          file: file.name,
          fileIndex,
          filePercent: Math.min(100, total / file.size * 100),
          totalPercent: Math.min(100, (bytesDoneBefore + total) / TOTAL_DOWNLOAD_BYTES * 100)
        };
        emit(false);
        // ponytail: no drain backpressure handling - SSD write vs network read never diverges enough to matter
        writer.write(chunk);
      });
      res.on('end', resolve);
      res.on('error', err => { streamError = err; resolve(); });
      writer.on('error', reject);
    });
    writer.end();
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    if (streamError) throw streamError;

    if (cancelRequested) {
      return bytesDoneBefore + startByte + received; // keep .part for resume
    }

    const total = startByte + received;
    if (total !== file.size) {
      fs.rmSync(partPath, { force: true });
      throw new Error(`下载不完整: ${file.name}（${total}/${file.size} 字节）`);
    }
    return total;
  }
}

async function verifyFile(file, fileIndex, bytesDoneBefore) {
  const dir = resolveModelDir();
  const finalPath = path.join(dir, file.name);
  const partPath = finalPath + '.part';

  setState('verifying');
  progress = { file: file.name, fileIndex, filePercent: 100, totalPercent: Math.min(100, (bytesDoneBefore + file.size) / TOTAL_DOWNLOAD_BYTES * 100) };

  const actual = await sha256File(partPath);
  if (actual !== file.sha256) {
    fs.rmSync(partPath, { force: true });
    throw new Error(`校验失败: ${file.name}（SHA-256 不匹配，文件已删除，请重试）`);
  }
  fs.renameSync(partPath, finalPath);
}

async function runDownload(source) {
  const base = DOWNLOAD_BASES[source] || DOWNLOAD_BASES[DEFAULT_MODEL_SOURCE];
  cancelRequested = false;
  running = true;
  try {
    await ensureDiskSpace();
    let bytesDone = 0;
    for (let i = 0; i < MODEL_FILES.length; i++) {
      if (cancelRequested) break;
      const file = MODEL_FILES[i];
      const finalPath = path.join(resolveModelDir(), file.name);
      if (fs.existsSync(finalPath) && fs.statSync(finalPath).size === file.size) {
        bytesDone += file.size; // downloaded & verified in a previous run
        continue;
      }
      setState('downloading');
      bytesDone = await downloadFile(base, file, i, bytesDone);
      if (cancelRequested) break;
      await verifyFile(file, i, bytesDone);
    }
    if (cancelRequested) {
      setState('idle'); // partial files kept on purpose (resume next time)
    } else if (isLocalModelReady()) {
      progress = null;
      setState('ready');
    } else {
      throw new Error('下载结束但模型仍未就绪，请重试');
    }
  } catch (err) {
    setState('error', err.message);
  } finally {
    running = false;
  }
}

function start(source) {
  if (running) return status(); // already in flight
  if (isLocalModelReady()) {
    progress = null;
    setState('ready');
    return status();
  }
  runDownload(source); // async, state machine reports outcome
  return status();
}

function cancel() {
  if (state === 'downloading' || state === 'verifying') cancelRequested = true;
  return status();
}

/**
 * Delete the downloaded model - managed files only (3 finals + .part
 * leftovers); unmanaged content in the dir (dev's fp32/test_wavs) stays.
 */
function remove() {
  if (running) return { success: false, error: '下载进行中，请先取消再删除' };
  const dir = resolveModelDir();
  for (const f of MODEL_FILES) {
    fs.rmSync(path.join(dir, f.name), { force: true });
    fs.rmSync(path.join(dir, f.name + '.part'), { force: true });
  }
  progress = null;
  lastError = null;
  state = 'idle';
  emit(true); // subscribers rebroadcast progress + recording availability
  return { success: true };
}

module.exports = { status, start, cancel, remove, subscribe };
