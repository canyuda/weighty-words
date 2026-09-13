/**
 * Media file feeder — file-based audio input source for a training session.
 *
 * Decodes an audio file or an mp4 video's audio track to 16kHz mono PCM
 * (renderer-side; the main process and the feed-audio contract stay
 * untouched), then feeds slices into the session at 1x real-time pace with
 * wall-clock drift correction. No playback graph is built: nothing is
 * audible. Pure helpers are unit tested; UMD double export follows the
 * lexicon-editor-state precedent.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.mediaFileFeeder = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 4096 samples @16kHz = 256ms per chunk — mirrors the mic ScriptProcessor size
  const SLICE_SAMPLES = 4096;
  const SAMPLE_RATE = 16000;
  const SLICE_MS = (SLICE_SAMPLES / SAMPLE_RATE) * 1000;
  // User-confirmed material bounds; duration is only knowable after decode
  const MAX_DURATION_SECONDS = 600; // 10 minutes
  const MAX_FILE_BYTES = 500 * 1024 * 1024;

  function noop() {}

  /** mm:ss clock text for the progress display */
  function formatClock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(s / 60).toString().padStart(2, '0');
    const seconds = (s % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  /** Pre-decode file size guard (fail fast before reading the file) */
  function validateFileSize(bytes) {
    if (bytes > MAX_FILE_BYTES) {
      return { ok: false, code: 'too_large', message: '文件超过 500MB 体积上限，请压缩或裁剪后再导入' };
    }
    return { ok: true };
  }

  /** Post-decode duration guard */
  function validateDuration(seconds) {
    if (seconds > MAX_DURATION_SECONDS) {
      return { ok: false, code: 'too_long', message: `音频时长超过 ${MAX_DURATION_SECONDS / 60} 分钟上限，请裁剪后再导入` };
    }
    return { ok: true };
  }

  /** Web Audio Float32 -> Int16 PCM for the unified ASR engine contract */
  function floatToInt16(floats) {
    const int16 = new Int16Array(floats.length);
    for (let i = 0; i < floats.length; i++) {
      const s = Math.max(-1, Math.min(1, floats[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }

  /** Chromium decode failures are cryptic; map to one plain-Chinese message */
  function mapDecodeError() {
    return '无法读取音频轨：文件可能没有音轨或编码不受支持（支持常见音频格式与 mp4 视频）';
  }

  /**
   * Decode an ArrayBuffer to 16kHz mono Float32 samples. decodeAudioData on
   * an OfflineAudioContext (inherited from BaseAudioContext) decodes and
   * resamples to 16kHz in one shot without a real audio-device context; a
   * second offline render downmixes to mono. mp4 containers work because
   * Chromium's decodeAudioData shares the <video> media stack and picks the
   * first audio track. The source node MUST be start(0)ed — an unstarted
   * BufferSource renders 198s of pure silence, the exact bug this once was.
   * Never throws: failures resolve to {ok:false, message}.
   */
  async function decodeToMono16k(arrayBuffer, ctors) {
    try {
      const OfflineCtor = (ctors && ctors.OfflineAudioContext) || self.OfflineAudioContext;
      const decodeCtx = new OfflineCtor(1, 1, SAMPLE_RATE);
      const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
      // Video-only files decode to an empty buffer instead of rejecting
      if (!decoded.length) {
        return { ok: false, code: 'empty', message: '文件中没有可用的音频轨（可能为无声视频）' };
      }
      const frames = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
      const offline = new OfflineCtor(1, frames, SAMPLE_RATE);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start(0);
      const rendered = await offline.startRendering();
      const samples = rendered.getChannelData(0);
      if (!samples.length) {
        return { ok: false, code: 'empty', message: '音频内容为空，无法播放' };
      }
      return { ok: true, samples, sampleRate: SAMPLE_RATE, duration: samples.length / SAMPLE_RATE };
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[media] decodeToMono16k failed:', err && (err.message || err));
      return { ok: false, code: 'decode_failed', message: mapDecodeError(err) };
    }
  }

  /**
   * Real-time paced feeder over decoded PCM. Slices into SLICE_SAMPLES
   * chunks handed to feedChunk as Int16 on a wall-clock-aligned schedule.
   * While paused it keeps sending silence frames so cloud sessions stay
   * alive (same D7 semantics as the mic path); resume continues from the
   * sample pointer with paused wall time excluded. timer/now are injectable
   * for deterministic tests.
   */
  function createFileFeeder(options) {
    const {
      samples,
      sampleRate = SAMPLE_RATE,
      feedChunk,
      onProgress = noop,
      onEnded = noop,
      setTimeoutFn = setTimeout,
      clearTimeoutFn = clearTimeout,
      nowFn = () => Date.now()
    } = options;

    const totalSamples = samples.length;
    let pos = 0;          // sample pointer into the file
    let started = false;
    let stopped = false;
    let paused = false;
    let timerId = null;
    let playStart = 0;    // wall clock when playback started (pauses excluded)
    let pausedMs = 0;     // accumulated paused wall time
    let pauseStartedAt = 0;

    function scheduleNext() {
      // Align the next chunk to the file clock (due position minus elapsed
      // play time). Cap at one chunk so pause/foreground transitions react
      // fast; when behind (e.g. background throttling) fire immediately —
      // data is never dropped, only delivered late.
      const dueMs = (pos / sampleRate) * 1000;
      const elapsedMs = nowFn() - playStart - pausedMs;
      const delay = Math.max(0, Math.min(dueMs - elapsedMs, SLICE_MS));
      timerId = setTimeoutFn(tick, delay);
    }

    function tick() {
      timerId = null;
      if (stopped) return;
      if (paused) {
        feedChunk(new Int16Array(SLICE_SAMPLES)); // keep-alive silence
        timerId = setTimeoutFn(tick, SLICE_MS);
        return;
      }
      if (pos >= totalSamples) {
        stopped = true;
        onEnded();
        return;
      }
      const end = Math.min(pos + SLICE_SAMPLES, totalSamples);
      feedChunk(floatToInt16(samples.subarray(pos, end)));
      pos = end;
      onProgress(pos / sampleRate, totalSamples / sampleRate);
      if (pos >= totalSamples) {
        stopped = true;
        onEnded();
        return;
      }
      scheduleNext();
    }

    return {
      start() {
        if (started || stopped) return;
        started = true;
        playStart = nowFn();
        timerId = setTimeoutFn(tick, 0);
      },
      pause() {
        if (paused || stopped || !started) return;
        paused = true;
        pauseStartedAt = nowFn();
      },
      resume() {
        if (!paused || stopped) return;
        pausedMs += nowFn() - pauseStartedAt;
        paused = false;
        // Drop the pending silence keep-alive tick and re-align to the file clock
        if (timerId !== null) {
          clearTimeoutFn(timerId);
          timerId = null;
        }
        scheduleNext();
      },
      stop() {
        stopped = true;
        if (timerId !== null) {
          clearTimeoutFn(timerId);
          timerId = null;
        }
      },
      get playedSeconds() { return pos / sampleRate; },
      get isPaused() { return paused; },
      get isStopped() { return stopped; }
    };
  }

  /**
   * Audible audition output, parallel to the feeder (design decision 9): the
   * feeding clock stays timer-driven and untouched; this player just plays
   * the same decoded samples out loud. The source re-anchors to the
   * feeder's playhead on every start/resume (getOffsetSeconds), so clock
   * drift between Date.now (feeding) and the sound card never accumulates
   * across pauses. Pause = stop the source (immediate silence); stop =
   * close the context. Default context uses the device rate — the 16kHz
   * buffer is resampled on output, avoiding Windows hardware-rate quirks
   * with non-default contexts. AudioContextCtor is injectable for tests.
   */
  function createAuditionPlayer(options) {
    const {
      samples,
      sampleRate = SAMPLE_RATE,
      getOffsetSeconds = () => 0,
      // The class itself (construct with new). Lazy default: node tests never
      // touch it, renderer resolves window.AudioContext. An arrow default
      // would explode on `new` — arrows have no [[Construct]].
      AudioContextCtor = typeof self !== 'undefined' ? self.AudioContext : undefined
    } = options;

    let ctx = null;
    let src = null;
    let dead = false; // terminal: stop() is final for this player

    function startSource(offsetSeconds) {
      src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, samples.length, sampleRate);
      src.buffer.copyToChannel(samples, 0);
      src.connect(ctx.destination);
      src.start(0, Math.max(0, offsetSeconds || 0));
    }

    function stopSource() {
      if (!src) return;
      try { src.stop(); } catch (_) { /* already stopped */ }
      src = null;
    }

    return {
      start() {
        if (ctx || dead) return;
        ctx = new AudioContextCtor();
        startSource(getOffsetSeconds());
      },
      pause() { stopSource(); },
      resume() {
        if (!ctx || src || dead) return;
        startSource(getOffsetSeconds()); // re-anchor to the feeder playhead
      },
      stop() {
        stopSource();
        if (ctx) { ctx.close(); ctx = null; }
        dead = true;
      }
    };
  }

  return {
    SLICE_SAMPLES,
    SAMPLE_RATE,
    MAX_DURATION_SECONDS,
    MAX_FILE_BYTES,
    formatClock,
    validateFileSize,
    validateDuration,
    floatToInt16,
    mapDecodeError,
    decodeToMono16k,
    createFileFeeder,
    createAuditionPlayer
  };
});
