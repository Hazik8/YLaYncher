'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

function sealAuth(auth) {
  if (!auth || typeof auth !== 'object') return null;
  const json = JSON.stringify(auth);
  try {
    if (safeStorage?.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(json).toString('base64')}`;
    }
  } catch {
    // Fall back to plain base64 if the OS key store is unavailable.
  }
  return `raw:${Buffer.from(json, 'utf8').toString('base64')}`;
}

function unsealAuth(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  const text = String(value);
  const split = text.indexOf(':');
  if (split < 0) return null;
  const kind = text.slice(0, split);
  const payload = text.slice(split + 1);
  try {
    if (kind === 'enc') {
      if (!safeStorage?.isEncryptionAvailable()) return null;
      return JSON.parse(safeStorage.decryptString(Buffer.from(payload, 'base64')));
    }
    if (kind === 'raw') {
      return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    }
  } catch {
    return null;
  }
  return null;
}

function defaultGameDir() {
  return path.join(app.getPath('appData'), '.minecraft');
}

function createDefaults() {
  return {
    version: 1,
    settings: {
      memoryMax: 4096,
      memoryMin: 512,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      fullscreen: false,
      javaPath: '',
      gameDir: defaultGameDir(),
      jvmArgs: '',
      closeOnLaunch: false,
      showConsole: true,
      selectedVersion: 'latest-release',
    },
    accounts: [],
    selectedAccountId: null,
    stats: {
      totalSeconds: 0,
      lastPlayed: null,
      lastVersion: null,
      byVersion: {},
    },
  };
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.data = createDefaults();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const defaults = createDefaults();
      this.data = {
        ...defaults,
        ...parsed,
        settings: { ...defaults.settings, ...(parsed.settings || {}) },
        stats: { ...defaults.stats, ...(parsed.stats || {}) },
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      };
    } catch {
      this.data = createDefaults();
      this.save();
    }

    // Pick the latest release on first run so the home screen feels alive.
    if (!this.data.settings.selectedVersion) {
      this.data.settings.selectedVersion = 'latest-release';
    }
    if (!this.data.selectedAccountId && this.data.accounts.length > 0) {
      this.data.selectedAccountId = this.data.accounts[0].id;
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('[store] save failed:', error);
    }
  }

  get() {
    return this.data;
  }

  publicAccount(account) {
    if (!account) return null;
    const { auth, ...visible } = account;
    return {
      ...visible,
      hasMicrosoftAuth: Boolean(auth) && account.type === 'microsoft',
    };
  }

  publicConfig() {
    return {
      ...this.data,
      accounts: this.data.accounts.map((account) => this.publicAccount(account)),
    };
  }

  getSettings() {
    return this.data.settings;
  }

  patchSettings(patch) {
    const allowed = [
      'memoryMax',
      'memoryMin',
      'width',
      'height',
      'fullscreen',
      'javaPath',
      'gameDir',
      'jvmArgs',
      'closeOnLaunch',
      'showConsole',
      'selectedVersion',
    ];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        this.data.settings[key] = patch[key];
      }
    }
    this.save();
    return this.data.settings;
  }

  gameDir() {
    return this.data.settings.gameDir || defaultGameDir();
  }

  getAccount(id = this.data.selectedAccountId) {
    return this.data.accounts.find((account) => account.id === id) || null;
  }

  getSelectedAccount() {
    return this.getAccount(this.data.selectedAccountId);
  }

  selectAccount(id) {
    if (!this.getAccount(id)) throw new Error('Аккаунт не найден');
    this.data.selectedAccountId = id;
    this.save();
    return this.data.accounts;
  }

  addAccount(name) {
    const clean = String(name || '').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(clean)) {
      throw new Error('Ник должен содержать от 3 до 16 символов: A–Z, 0–9 и _');
    }
    if (this.data.accounts.some((a) => a.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error('Аккаунт с таким ником уже добавлен');
    }
    const id = crypto.randomUUID();
    const uuid = offlineUuid(clean);
    const account = {
      id,
      name: clean,
      uuid,
      type: 'offline',
      createdAt: new Date().toISOString(),
    };
    this.data.accounts.push(account);
    this.data.selectedAccountId = id;
    this.save();
    return account;
  }

  addMicrosoftAccount(profile, auth) {
    const name = String(profile?.name || '').trim();
    const uuid = String(profile?.id || '').trim();
    if (!name || !uuid) throw new Error('Microsoft не вернул профиль Minecraft');
    if (!auth) throw new Error('Microsoft не вернул токены входа');

    let account = this.data.accounts.find(
      (item) => item.type === 'microsoft' && item.uuid.toLowerCase() === uuid.toLowerCase(),
    );
    if (account) {
      account.name = name;
      account.uuid = uuid;
      account.auth = sealAuth(auth);
      account.updatedAt = new Date().toISOString();
    } else {
      account = {
        id: crypto.randomUUID(),
        name,
        uuid,
        type: 'microsoft',
        auth: sealAuth(auth),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.data.accounts.push(account);
    }

    this.data.selectedAccountId = account.id;
    this.save();
    return account;
  }

  getAccountAuth(accountOrId) {
    const account =
      typeof accountOrId === 'string' ? this.getAccount(accountOrId) : accountOrId || this.getSelectedAccount();
    return unsealAuth(account?.auth);
  }

  setAccountAuth(id, auth) {
    const account = this.getAccount(id);
    if (!account) throw new Error('Аккаунт не найден');
    account.auth = sealAuth(auth);
    account.updatedAt = new Date().toISOString();
    this.save();
    return account;
  }

  updateMicrosoftProfile(id, profile) {
    const account = this.getAccount(id);
    if (!account) throw new Error('Аккаунт не найден');
    if (profile?.name) account.name = String(profile.name);
    if (profile?.id) account.uuid = String(profile.id);
    account.updatedAt = new Date().toISOString();
    this.save();
    return account;
  }

  removeAccount(id) {
    this.data.accounts = this.data.accounts.filter((account) => account.id !== id);
    if (this.data.selectedAccountId === id) {
      this.data.selectedAccountId = this.data.accounts[0]?.id || null;
    }
    this.save();
    return this.data.accounts;
  }

  addPlaytime(versionId, seconds) {
    const value = Math.max(0, Math.round(seconds));
    if (!value) return;
    this.data.stats.totalSeconds += value;
    this.data.stats.lastPlayed = new Date().toISOString();
    this.data.stats.lastVersion = versionId;
    const prev = this.data.stats.byVersion[versionId] || { seconds: 0, lastPlayed: null };
    this.data.stats.byVersion[versionId] = {
      seconds: prev.seconds + value,
      lastPlayed: new Date().toISOString(),
    };
    this.save();
  }
}

/**
 * Deterministic offline UUID, compatible with the vanilla "OfflinePlayer" scheme.
 */
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = { Store, defaultGameDir, offlineUuid };
