/**
 * One-off e2e verification for homedir-config-storage + analysis v2 (not part
 * of the suite): first-run file creation under an isolated config dir,
 * settings v2 shape, plaintext at-rest keys (analyzer entries + ASR slots),
 * the mask/reveal/clear protocol (entry-id paired), the eye-toggle UI on an
 * ASR key field, rules.json persistence, and the full-file lexicon round
 * trip. Real ~/.weighty-words must stay untouched (isolated via
 * EXPRESSION_TRAINER_CONFIG_DIR, same tmp as USER_DATA).
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'et-homedir-verify-'));
const SETTINGS_FILE = path.join(TMP, 'settings.json');
const RULES_FILE = path.join(TMP, 'rules.json');
const WORDS_FILE = path.join(TMP, 'words.json');
const REAL_DIR = path.join(os.homedir(), '.weighty-words');
const REAL_MTIME = fs.existsSync(REAL_DIR) ? fs.statSync(REAL_DIR).mtimeMs : null;

const NEW_KEY = 'unit-e2e-key-1234567890';
const ASR_KEY = 'unit-asr-key-9876543210';

async function findMainWindow(app) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if ((await w.title()) === '言之有物') return w;
      } catch (_) { /* ignore */ }
    }
    await sleep(200);
  }
  throw new Error('timeout: main window');
}

(async () => {
  let app;
  try {
    app = await _electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        EXPRESSION_TRAINER_AUTOMATION: '1',
        EXPRESSION_TRAINER_USER_DATA: TMP,
        EXPRESSION_TRAINER_CONFIG_DIR: TMP
      }
    });
    const win = await findMainWindow(app);
    await win.waitForLoadState('domcontentloaded');
    await sleep(600);

    // 1. first-run bootstrap: three files created in the isolated config dir
    for (const f of ['settings.json', 'rules.json', 'words.json']) {
      assert.ok(fs.existsSync(path.join(TMP, f)), `created ${f} on first run`);
    }
    const settings0 = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    assert.strictEqual(settings0.version, 2, 'settings.json v2');
    assert.ok(Array.isArray(settings0.analysis.entries) && settings0.analysis.entries.length === 0, 'empty analysis entries');
    const words0 = JSON.parse(fs.readFileSync(WORDS_FILE, 'utf-8'));
    assert.ok(Array.isArray(words0.fillers) && words0.fillers.length > 10, 'words.json filled from factory baseline');
    assert.ok(words0._meta && words0._meta.schemaVersion === 1, 'words.json _meta envelope present');
    const rules0 = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
    assert.ok(typeof rules0.goals === 'string' && typeof rules0.customWords === 'string', 'rules.json default structure');
    console.log('[verify] first-run bootstrap OK (fillers =', words0.fillers.length + ')');

    // 2. analyzer entry: save a fresh key via the entry IPC, disk shows it raw
    const saved = await win.evaluate((k) => window.api.saveAnalyzerEntry({
      provider: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
      apiKey: k, protocol: 'openai-chat', models: ['deepseek-chat'], primaryModel: 'deepseek-chat'
    }), NEW_KEY);
    assert.ok(saved.success, 'save-analyzer-entry accepted');
    await sleep(200);
    let onDisk = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    assert.strictEqual(onDisk.analysis.entries[0].apiKey, NEW_KEY, 'key stored in PLAINTEXT on disk');
    assert.ok(!JSON.stringify(onDisk).includes('enc:v1'), 'no encryption envelope on disk');
    assert.strictEqual(onDisk.analysis.activeId, onDisk.analysis.entries[0].id, 'first entry auto-active');

    // 3. renderer sees only the partial mask; reveal returns full plaintext by entry id
    const entryId = onDisk.analysis.entries[0].id;
    const masked = await win.evaluate(() => window.api.getSettings());
    assert.strictEqual(masked.analysis.entries[0].apiKey, 'unit-' + '•'.repeat(8) + '67890', 'mask = first5 + 8 dots + last5');
    assert.ok(!JSON.stringify(masked).includes(NEW_KEY), 'full key never sent to renderer unprompted');
    const revealed = await win.evaluate((id) => window.api.revealSecret(['analysis', 'entries', id, 'apiKey']), entryId);
    assert.strictEqual(revealed.value, NEW_KEY, 'reveal-secret returns stored plaintext');
    const rejected = await win.evaluate(() => window.api.revealSecret(['analysis', 'entries', 'an-evil', 'apiKey']));
    assert.strictEqual(rejected.value, '', 'unknown entry id fails closed');

    // 3.5 UI eye toggle (ASR dashscope field): mask echo → reveal → edit → toggle back → mask restored
    await win.evaluate((k) => window.api.saveSettings({ asr: { dashscope: { apiKey: k } } }), ASR_KEY);
    await sleep(200);
    await win.evaluate(() => window.api.openSettings());
    await sleep(500);
    await win.evaluate(() => window.__settingsPage.loadSettings()); // 页面输入框重拉掩码回显
    await sleep(300);
    const asrMaskedForm = ASR_KEY.slice(0, 5) + '•'.repeat(8) + ASR_KEY.slice(-5);
    const eyeState = await win.evaluate(async ({ maskForm, fullKey }) => {
      const input = document.getElementById('asr-apikey');
      const eye = input.closest('.secret-row').querySelector('.secret-eye');
      const confirms = [];
      window.appConfirm = (msg) => { confirms.push(msg); return Promise.resolve(true); }; // stub: 确认丢弃
      const before = { disabled: eye.disabled, value: input.value };
      eye.click();
      await new Promise((r) => setTimeout(r, 300));
      const revealedState = { disabled: eye.disabled, value: input.value };
      input.value = 'unit-edited-during-reveal';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const edited = { disabled: eye.disabled };
      eye.click();
      await new Promise((r) => setTimeout(r, 300));
      const restored = { disabled: eye.disabled, value: input.value, confirmShown: confirms.length > 0 };
      return { before, revealedState, edited, restored };
    }, { maskForm: asrMaskedForm, fullKey: ASR_KEY });
    assert.strictEqual(eyeState.before.disabled, false, 'eye enabled on saved-key mask echo');
    assert.strictEqual(eyeState.before.value, asrMaskedForm, 'input shows partial mask');
    assert.strictEqual(eyeState.revealedState.disabled, false, 'eye STAYS clickable in plaintext state');
    assert.strictEqual(eyeState.revealedState.value, ASR_KEY, 'reveal shows full plaintext');
    assert.strictEqual(eyeState.edited.disabled, false, 'eye still clickable after editing plaintext');
    assert.strictEqual(eyeState.restored.confirmShown, true, 'toggle-back with edits asks for confirmation');
    assert.strictEqual(eyeState.restored.value, asrMaskedForm, 'toggle-back restores the mask, not blank');
    console.log('[verify] eye toggle UI OK (ASR field)');

    // 4. merge protocol: masked round-trip keeps (entry edit), '' clears (ASR slot)
    const roundTrip = await win.evaluate(({ id, maskForm }) => window.api.saveAnalyzerEntry({
      id, provider: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
      apiKey: maskForm, protocol: 'openai-chat', models: ['deepseek-chat'], primaryModel: 'deepseek-chat'
    }), { id: entryId, maskForm: 'unit-' + '•'.repeat(8) + '67890' });
    assert.ok(roundTrip.success, 'masked entry round-trip accepted');
    await sleep(150);
    assert.strictEqual(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')).analysis.entries[0].apiKey, NEW_KEY, 'masked round-trip keeps stored key');
    await win.evaluate(() => window.api.saveSettings({ asr: { dashscope: { apiKey: '' } } })); // 清除 ASR Key
    await sleep(150);
    assert.strictEqual(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')).asr.dashscope.apiKey, '', "'' clears the stored key");
    console.log('[verify] mask / reveal / clear protocol OK');

    // 5. rules.json persistence via existing IPC
    await win.evaluate(() => window.api.saveRules({ goals: 'e2e目标', customRules: '', styleRef: '', customWords: '' }));
    await sleep(150);
    assert.strictEqual(JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8')).goals, 'e2e目标', 'rules persisted to rules.json');
    console.log('[verify] rules.json persistence OK');

    // 6. lexicon full-file: editor save writes words.json; invalid import rejected
    const badImport = await win.evaluate(async () => {
      return window.api.saveLexiconWords({ fillers: 'oops', hedges: [], vague: {}, emotions: {} });
    });
    assert.strictEqual(badImport.success, false, 'missing/invalid table rejected wholesale');
    const goodWords = JSON.parse(fs.readFileSync(WORDS_FILE, 'utf-8'));
    goodWords.fillers.push('验证口头禅');
    const goodSave = await win.evaluate((w) => window.api.saveLexiconWords(w), goodWords);
    assert.ok(goodSave.success, 'full-file save accepted');
    await sleep(150);
    assert.ok(JSON.parse(fs.readFileSync(WORDS_FILE, 'utf-8')).fillers.includes('验证口头禅'), 'words.json updated on disk');
    console.log('[verify] lexicon full-file model OK');

    // 7. isolation: real ~/.weighty-words untouched by the automation run
    const realMtimeNow = fs.existsSync(REAL_DIR) ? fs.statSync(REAL_DIR).mtimeMs : null;
    assert.strictEqual(REAL_MTIME, realMtimeNow, 'real ~/.weighty-words untouched');

    await app.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log('verify-homedir-storage: PASS');
    process.exit(0);
  } catch (err) {
    console.error('verify-homedir-storage: FAIL —', err.message);
    if (app) { try { await app.close(); } catch (_) {} }
    process.exit(1);
  }
})();
