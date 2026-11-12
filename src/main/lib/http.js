'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const USER_AGENT = 'YLaYncher/1.0 (Minecraft Java Launcher)';

class CancelledError extends Error {
  constructor(message = 'Операция отменена') {
    super(message);
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function statSafe(file) {
  try {
    return await fsp.stat(file);
  } catch {
    return null;
  }
}

async function exists(file) {
  return Boolean(await statSafe(file));
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function fetchWithTimeout(url, options = {}) {
  const { timeout = 30000, headers = {}, signal } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const forwardAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', forwardAbort, { once: true });
  try {
    return await fetch(url, {
      headers: { 'user-agent': USER_AGENT, ...headers },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', forwardAbort);
  }
}

/**
 * Fetch JSON with retries and a friendly error message.
 */
async function fetchJson(url, options = {}) {
  const attempts = options.retries ?? 3;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.isCancelled?.()) throw new CancelledError();
    try {
      const response = await fetchWithTimeout(url, options);
      if (!response.ok) {
        const err = new Error(`HTTP ${response.status} — ${url}`);
        err.status = response.status;
        throw err;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (error.cancelled) throw error;
      if (error.status && error.status >= 400 && error.status < 500) throw error;
      if (attempt < attempts - 1) await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`Не удалось получить данные (${lastError?.message || 'сеть недоступна'})`);
}

/**
 * Fetch a text resource (HTML, XML, plain text) with retries.
 */
async function fetchText(url, options = {}) {
  const attempts = options.retries ?? 3;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.isCancelled?.()) throw new CancelledError();
    try {
      const response = await fetchWithTimeout(url, options);
      if (!response.ok) {
        const err = new Error(`HTTP ${response.status} — ${url}`);
        err.status = response.status;
        throw err;
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (error.cancelled) throw error;
      if (error.status && error.status >= 400 && error.status < 500) throw error;
      if (attempt < attempts - 1) await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`Не удалось получить данные (${lastError?.message || 'сеть недоступна'})`);
}

async function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function sha1Buffer(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

/**
 * Downloads a file atomically, skipping files that already match size/hash.
 */
async function downloadFile(url, destination, options = {}) {
  const {
    size = null,
    sha1 = null,
    verifyExisting = false,
    retries = 3,
    timeout = 120000,
    headers = {},
    isCancelled,
    signal,
  } = options;

  const info = await statSafe(destination);
  if (info && info.isFile()) {
    if (size != null && info.size === size) {
      if (!verifyExisting) return { skipped: true, bytes: info.size };
      if (!sha1 || (await sha1File(destination)) === sha1) {
        return { skipped: true, bytes: info.size };
      }
    } else if (size == null && !verifyExisting) {
      return { skipped: true, bytes: info.size };
    }
  }

  await fsp.mkdir(path.dirname(destination), { recursive: true });
  let lastError;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (isCancelled?.()) throw new CancelledError();
    const tmp = `${destination}.${process.pid}.part`;
    try {
      const response = await fetchWithTimeout(url, { timeout, headers, signal });
      if (!response.ok) {
        const err = new Error(`HTTP ${response.status} — ${url}`);
        err.status = response.status;
        throw err;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (size != null && buffer.length !== size) {
        throw new Error(`Некорректный размер файла: ${url}`);
      }
      if (sha1 && sha1Buffer(buffer) !== sha1) {
        throw new Error(`Проверка целостности не пройдена: ${url}`);
      }
      await fsp.writeFile(tmp, buffer);
      await fsp.rename(tmp, destination);
      return { skipped: false, bytes: buffer.length };
    } catch (error) {
      lastError = error;
      await fsp.rm(tmp, { force: true }).catch(() => {});
      if (error.cancelled) throw error;
      if (error.status && error.status >= 400 && error.status < 500) throw error;
      if (attempt < retries - 1) await sleep(700 * (attempt + 1));
    }
  }

  throw new Error(`Не удалось скачать файл: ${lastError?.message || url}`);
}

/**
 * Runs an async worker over a list with a fixed concurrency.
 */
async function mapPool(items, concurrency, worker) {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    async () => {
      while (true) {
        const current = index++;
        if (current >= items.length) return;
        await worker(items[current], current);
      }
    },
  );
  await Promise.all(workers);
}

/**
 * Progress aggregator with throttled callbacks and download speed.
 */
class ProgressReporter {
  constructor(callback, { totalBytes = 0, totalFiles = 0 } = {}) {
    this.callback = callback || (() => {});
    this.totalBytes = totalBytes;
    this.totalFiles = totalFiles;
    this.doneBytes = 0;
    this.doneFiles = 0;
    this.stage = 'prepare';
    this.message = 'Подготовка…';
    this.startedAt = Date.now();
    this.lastEmit = 0;
    this.lastBytes = 0;
    this.lastSample = Date.now();
    this.speed = 0;
    this.extra = {};
    this.ended = false;
  }

  setStage(stage, message) {
    this.stage = stage;
    if (message) this.message = message;
    this.emit(true);
  }

  setTotals(totalBytes, totalFiles) {
    this.totalBytes = totalBytes;
    this.totalFiles = totalFiles;
  }

  addFile(bytes = 0) {
    this.doneFiles += 1;
    this.doneBytes += Math.max(0, bytes || 0);
    this.emit(false);
  }

  addBytes(bytes) {
    this.doneBytes += bytes;
    this.emit(false);
  }

  get percent() {
    if (this.totalBytes > 0) {
      return Math.min(100, Math.round((this.doneBytes / this.totalBytes) * 1000) / 10);
    }
    if (this.totalFiles > 0) {
      return Math.min(100, Math.round((this.doneFiles / this.totalFiles) * 1000) / 10);
    }
    return 0;
  }

  emit(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 120) return;
    this.lastEmit = now;
    const deltaBytes = this.doneBytes - this.lastBytes;
    const deltaTime = now - this.lastSample;
    if (deltaTime >= 500) {
      this.speed = Math.round((deltaBytes / deltaTime) * 1000);
      this.lastBytes = this.doneBytes;
      this.lastSample = now;
    }
    this.callback({
      stage: this.stage,
      message: this.message,
      percent: this.percent,
      doneBytes: this.doneBytes,
      totalBytes: this.totalBytes,
      doneFiles: this.doneFiles,
      totalFiles: this.totalFiles,
      speed: this.speed,
      ...this.extra,
    });
  }

  finish(message = 'Готово') {
    this.ended = true;
    this.stage = 'done';
    this.message = message;
    this.doneBytes = this.totalBytes || this.doneBytes;
    this.doneFiles = this.totalFiles || this.doneFiles;
    this.callback({
      stage: 'done',
      message,
      percent: 100,
      doneBytes: this.doneBytes,
      totalBytes: this.totalBytes,
      doneFiles: this.doneFiles,
      totalFiles: this.totalFiles,
      speed: 0,
      ...this.extra,
    });
  }
}

/**
 * Split a command line string into arguments, respecting double quotes.
 */
function splitCommandLine(input) {
  const args = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ' ' && !quoted) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

module.exports = {
  CancelledError,
  sleep,
  exists,
  statSafe,
  readJson,
  writeJson,
  fetchJson,
  fetchText,
  sha1File,
  downloadFile,
  mapPool,
  ProgressReporter,
  splitCommandLine,
};
