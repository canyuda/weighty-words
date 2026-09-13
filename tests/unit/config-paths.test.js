import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getConfigDir,
  getSettingsPath,
  getRulesPath,
  getWordsPath,
  atomicWriteFileSync,
  ensureConfigDir
} from '../../lib/config-paths.js';

let tmpDir;
let savedHook;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-config-'));
  savedHook = process.env.EXPRESSION_TRAINER_CONFIG_DIR;
  process.env.EXPRESSION_TRAINER_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (savedHook === undefined) delete process.env.EXPRESSION_TRAINER_CONFIG_DIR;
  else process.env.EXPRESSION_TRAINER_CONFIG_DIR = savedHook;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('config-paths: 路径解析', () => {
  it('优先读 EXPRESSION_TRAINER_CONFIG_DIR 测试钩子', () => {
    expect(getConfigDir()).toBe(tmpDir);
    expect(getSettingsPath()).toBe(path.join(tmpDir, 'settings.json'));
    expect(getRulesPath()).toBe(path.join(tmpDir, 'rules.json'));
    expect(getWordsPath()).toBe(path.join(tmpDir, 'words.json'));
  });

  it('无钩子时回退 ~/.weighty-words', () => {
    delete process.env.EXPRESSION_TRAINER_CONFIG_DIR;
    const expected = path.join(os.homedir(), '.weighty-words');
    expect(getConfigDir()).toBe(expected);
    expect(getWordsPath()).toBe(path.join(expected, 'words.json'));
  });
});

describe('config-paths: 原子写', () => {
  it('写入后不留临时文件', () => {
    const p = path.join(tmpDir, 'a.json');
    atomicWriteFileSync(p, '{"x":1}');
    expect(fs.readFileSync(p, 'utf-8')).toBe('{"x":1}');
    expect(fs.readdirSync(tmpDir)).toEqual(['a.json']);
  });
});

describe('config-paths: ensureConfigDir 首启引导', () => {
  it('缺失文件按默认创建，已有文件绝不覆盖（手改保护）', () => {
    const handEdited = { marker: 'user-data' };
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(handEdited));
    const defaults = {
      'settings.json': { fresh: true },
      'rules.json': { goals: '' },
      'words.json': { fillers: [] }
    };
    const created = ensureConfigDir({ defaults });
    expect(created.sort()).toEqual(['rules.json', 'words.json']);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf-8'))).toEqual(handEdited);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'rules.json'), 'utf-8'))).toEqual({ goals: '' });
  });

  it('目录不存在时递归创建', () => {
    const nested = path.join(tmpDir, 'deep', 'dir');
    process.env.EXPRESSION_TRAINER_CONFIG_DIR = nested;
    ensureConfigDir({ defaults: { 'rules.json': {} } });
    expect(fs.existsSync(path.join(nested, 'rules.json'))).toBe(true);
  });

  it('POSIX 上目录与新建文件为仅当前用户权限', () => {
    if (process.platform === 'win32') return; // Windows 无 POSIX 权限位
    ensureConfigDir({ defaults: { 'settings.json': {} } });
    const dirMode = fs.statSync(tmpDir).mode & 0o777;
    const fileMode = fs.statSync(path.join(tmpDir, 'settings.json')).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it('未提供默认值的文件不创建', () => {
    const created = ensureConfigDir({ defaults: { 'settings.json': {} } });
    expect(created).toEqual(['settings.json']);
    expect(fs.existsSync(path.join(tmpDir, 'words.json'))).toBe(false);
  });
});
