/**
 * Local model registry: single source of truth for the model file manifest,
 * download sources, and model dir resolution. Shared by the availability
 * check, the local engine, and the downloader - no second hardcoded path
 * (design D3).
 *
 * sha256/size values were verified byte-for-byte against the official
 * GitHub release tarball; the HF repo hosts identical files.
 */

const path = require('path');
const fs = require('fs');

const MODEL_DIR_NAME = 'sherpa-onnx-streaming-paraformer-bilingual-zh-en';
const REPO_PATH = 'csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main';

// int8 only - fp32 offers no meaningful accuracy gain for this app (A/B tested)
const MODEL_FILES = [
  { name: 'encoder.int8.onnx', size: 165462184, sha256: '81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a' },
  { name: 'decoder.int8.onnx', size: 71664561, sha256: 'f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f' },
  { name: 'tokens.txt', size: 75756, sha256: '59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6' }
];

const DOWNLOAD_BASES = {
  huggingface: `https://huggingface.co/${REPO_PATH}`,
  mirror: `https://hf-mirror.com/${REPO_PATH}`
};
const DEFAULT_MODEL_SOURCE = 'huggingface';

const TOTAL_DOWNLOAD_BYTES = MODEL_FILES.reduce((sum, f) => sum + f.size, 0);

// User-configured models root (settings.asr.modelsDir), set by main at
// startup and on change. null = form default (dev project dir / userData).
let customModelsDir = null;

/** Set (or clear with '') the user-configured models root. Takes effect immediately. */
function configureModelsDir(dir) {
  customModelsDir = dir && dir.trim() ? dir.trim() : null;
}

/**
 * Resolution precedence: test-hook env > user setting > form default.
 * dev: project <root>/models; packaged app: <userData>/models (asar is
 * read-only). In plain node (smoke tests) require('electron') resolves to
 * the binary path string, so `app` is undefined and we fall back to dev.
 */
function resolveModelsDir() {
  if (process.env.MODEL_DIR_OVERRIDE) return process.env.MODEL_DIR_OVERRIDE; // test hook
  if (customModelsDir) return customModelsDir;
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      return path.join(app.getPath('userData'), 'models');
    }
  } catch (_) { /* not under Electron */ }
  return path.join(__dirname, '..', '..', 'models');
}

function resolveModelDir() {
  return path.join(resolveModelsDir(), MODEL_DIR_NAME);
}

/** Fast readiness check: all files present with matching byte sizes. */
function isLocalModelReady() {
  const dir = resolveModelDir();
  return MODEL_FILES.every(f => {
    try {
      return fs.statSync(path.join(dir, f.name)).size === f.size;
    } catch (_) {
      return false;
    }
  });
}

module.exports = {
  MODEL_DIR_NAME,
  MODEL_FILES,
  DOWNLOAD_BASES,
  DEFAULT_MODEL_SOURCE,
  TOTAL_DOWNLOAD_BYTES,
  configureModelsDir,
  resolveModelsDir,
  resolveModelDir,
  isLocalModelReady
};
