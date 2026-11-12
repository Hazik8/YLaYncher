'use strict';

const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { app, shell, dialog } = require('electron');
const { fetchJson, downloadFile, mapPool, exists, statSafe, sha1File, ProgressReporter } = require('./http');

const JAVA_RUNTIME_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

const JAVA_SCAN_CACHE_MS = 5 * 60 * 1000;
let javaCache = { at: 0, list: [] };

function runtimePlatform() {
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64';
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  }
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

function osName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

function getPaths(gameDir) {
  const base = gameDir || path.join(app.getPath('appData'), '.minecraft');
  return {
    gameDir: base,
    assets: path.join(base, 'assets'),
    libraries: path.join(base, 'libraries'),
    versions: path.join(base, 'versions'),
    runtime: path.join(app.getPath('userData'), 'runtime'),
    cache: path.join(app.getPath('userData'), 'cache'),
    logs: path.join(app.getPath('userData'), 'logs'),
  };
}

async function ensureGameDirs(paths) {
  await Promise.all([
    fsp.mkdir(paths.gameDir, { recursive: true }),
    fsp.mkdir(paths.assets, { recursive: true }),
    fsp.mkdir(paths.libraries, { recursive: true }),
    fsp.mkdir(paths.versions, { recursive: true }),
    fsp.mkdir(paths.runtime, { recursive: true }),
  ]);
}

function execCapture(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10000, ...options }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function parseJavaVersion(text) {
  const match = text.match(/version "([^"]+)"/);
  if (!match) return null;
  const version = match[1];
  const parts = version.split(/[._+]/);
  const major = parts[0] === '1' ? Number(parts[1]) : Number(parts[0]);
  if (!Number.isFinite(major)) return null;
  return { version, major, bits: /64-Bit/i.test(text) ? 64 : 32 };
}

async function probeJava(javaExe, source) {
  const binDir = path.dirname(javaExe);
  let javaw = path.join(binDir, process.platform === 'win32' ? 'javaw.exe' : 'java');
  if (process.platform === 'win32' && !(await exists(javaw))) javaw = javaExe;
  if (!(await exists(javaExe))) return null;
  const { stdout, stderr } = await execCapture(javaExe, ['-version']);
  const info = parseJavaVersion(`${stderr}\n${stdout}`);
  if (!info) return null;
  return {
    path: javaw,
    javaPath: javaExe,
    version: info.version,
    major: info.major,
    bits: info.bits,
    source: source || 'system',
  };
}

async function scanJavaRoot(root, depth = 2) {
  const found = [];
  async function walk(dir, level) {
    if (level < 0) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const javaName = process.platform === 'win32' ? 'java.exe' : 'java';
    const direct = entries.find((entry) => entry.isFile() && entry.name === javaName);
    if (direct) {
      found.push(path.join(dir, javaName));
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (level > 0 && (name === 'bin' || name.toLowerCase().includes('jdk') || name.toLowerCase().includes('jre') || name.toLowerCase().includes('java') || level === 2)) {
        await walk(path.join(dir, name), level - 1);
      }
    }
  }
  await walk(root, depth);
  return found;
}

async function getJavaCandidates(force = false) {
  if (!force && Date.now() - javaCache.at < JAVA_SCAN_CACHE_MS) {
    return javaCache.list;
  }

  const candidates = new Set();
  const add = (value) => {
    if (value) candidates.add(path.resolve(value));
  };

  if (process.env.JAVA_HOME) {
    add(path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  }

  const where = await execCapture(process.platform === 'win32' ? 'where.exe' : 'which', [
    process.platform === 'win32' ? 'java.exe' : 'java',
  ]);
  for (const line of where.stdout.split(/\r?\n/)) {
    if (line.trim()) add(line.trim());
  }

  const roots = [];
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || '';
    for (const vendor of [
      'Java',
      'Eclipse Adoptium',
      'AdoptOpenJDK',
      'Microsoft',
      'Zulu',
      'BellSoft',
      'Amazon Corretto',
      'Semeru',
      'Temurin',
      'JetBrains',
      'GraalVM',
      'OpenJDK',
    ]) {
      roots.push(path.join(programFiles, vendor));
      roots.push(path.join(programFilesX86, vendor));
      if (localAppData) roots.push(path.join(localAppData, 'Programs', vendor));
    }
    roots.push('C:\\Java');
    roots.push(path.join(app.getPath('userData'), 'runtime'));
    roots.push(path.join(app.getPath('appData'), '.minecraft', 'runtime'));
  } else if (process.platform === 'darwin') {
    roots.push('/Library/Java/JavaVirtualMachines');
    roots.push(path.join(os.homedir(), 'Library/Java/JavaVirtualMachines'));
    roots.push('/opt/homebrew/opt');
    roots.push('/usr/local/opt');
  } else {
    roots.push('/usr/lib/jvm');
    roots.push('/opt/java');
    roots.push(path.join(os.homedir(), '.sdkman/candidates/java'));
  }

  for (const root of roots) {
    const paths = await scanJavaRoot(root, 3);
    for (const item of paths) add(item);
  }

  const unique = [...candidates];
  const probed = [];
  for (const javaPath of unique) {
    const info = await probeJava(javaPath, 'system').catch(() => null);
    if (info) probed.push(info);
  }

  const seen = new Set();
  const list = probed
    .filter((item) => {
      const key = item.javaPath.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.major - a.major || b.version.localeCompare(a.version, undefined, { numeric: true }));

  javaCache = { at: Date.now(), list };
  return list;
}

function versionParts(version) {
  return String(version).split(/[._+-]/).map((part) => Number(part) || 0);
}

function compareJava(a, b) {
  if (a.major !== b.major) return b.major - a.major;
  const av = versionParts(a.version);
  const bv = versionParts(b.version);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const delta = (bv[i] || 0) - (av[i] || 0);
    if (delta) return delta;
  }
  return 0;
}

function requiredJavaMajor(meta) {
  if (meta?.javaVersion?.majorVersion) return meta.javaVersion.majorVersion;
  const id = String(meta?.id || '');
  const match = id.match(/^1\.(\d+)(?:\.(\d+))?/);
  if (match) {
    const minor = Number(match[1]);
    const patch = Number(match[2] || 0);
    if (minor >= 21) return 21;
    if (minor >= 18) return 17;
    if (minor === 17) return 16;
    if (minor >= 12) return 8;
  }
  return 8;
}

function isCompatible(required, candidate) {
  if (candidate.major === required) return true;
  if (required <= 8) return false;
  if (candidate.major < required) return false;
  if (required <= 16) return candidate.major <= 21;
  return true;
}

async function chooseJava(required, preferredPath) {
  if (preferredPath) {
    const info = await probeJava(preferredPath, 'manual').catch(() => null);
    if (!info) {
      throw new Error('Не удалось запустить выбранную Java. Проверьте путь в настройках.');
    }
    if (!isCompatible(required, info)) {
      throw new Error(
        `Выбранная Java ${info.major} не подходит для этой версии. Нужна Java ${required}.`,
      );
    }
    return info;
  }

  const list = await getJavaCandidates();
  const compatible = list.filter((item) => isCompatible(required, item));
  if (!compatible.length) return null;

  compatible.sort((a, b) => {
    const aExact = a.major === required ? 0 : 1;
    const bExact = b.major === required ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return compareJava(a, b);
  });
  return compatible[0];
}

let runtimeInfoCache = { at: 0, data: null };

async function getRuntimeIndex(force = false) {
  if (!force && runtimeInfoCache.data && Date.now() - runtimeInfoCache.at < 60 * 60 * 1000) {
    return runtimeInfoCache.data;
  }
  const data = await fetchJson(JAVA_RUNTIME_URL);
  runtimeInfoCache = { at: Date.now(), data };
  return data;
}

/**
 * Downloads a Mojang Java runtime matching the version metadata.
 */
async function ensureJavaRuntime(meta, { runtimeDir, onProgress, isCancelled } = {}) {
  const required = requiredJavaMajor(meta);
  const platform = runtimePlatform();
  const index = await getRuntimeIndex();
  const platformData = index[platform];
  if (!platformData) throw new Error(`Java для платформы ${platform} не найдена`);

  let component = meta.javaVersion?.component;
  let entries = component ? platformData[component] : null;

  if (!entries || !entries.length) {
    let best = null;
    for (const [name, list] of Object.entries(platformData)) {
      if (!Array.isArray(list) || !list.length) continue;
      const entry = list[0];
      const major = Number(String(entry.version?.name || '').split('.')[0]);
      if (!Number.isFinite(major)) continue;
      if (major < required) continue;
      if (!best || major < best.major) best = { name, major };
    }
    if (!best) throw new Error(`Не удалось найти Java ${required} для автоматической установки`);
    component = best.name;
    entries = platformData[component];
  }

  const entry = entries[0];
  const versionName = entry.version?.name || String(required);
  const root = path.join(runtimeDir || getPaths().runtime, component, versionName);
  const javaExe = path.join(root, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  if (await exists(javaExe)) {
    return { path: javaExe, major: required, version: versionName, source: 'mojang' };
  }

  const manifest = await fetchJson(entry.manifest.url, { isCancelled });
  const files = manifest.files || {};
  const tasks = [];
  let totalBytes = 0;
  for (const [relative, info] of Object.entries(files)) {
    if (!info || info.type !== 'file') continue;
    const raw = info.downloads?.raw;
    if (!raw) continue;
    tasks.push({ relative, raw });
    totalBytes += raw.size || 0;
  }

  const reporter = new ProgressReporter(onProgress, {
    totalBytes,
    totalFiles: tasks.length,
  });
  reporter.setStage('java', `Скачивание Java ${versionName}…`);

  await fsp.mkdir(root, { recursive: true });

  // Create directory entries first.
  for (const [relative, info] of Object.entries(files)) {
    if (info?.type === 'directory') {
      await fsp.mkdir(path.join(root, relative), { recursive: true });
    }
  }

  await mapPool(tasks, 8, async (task) => {
    if (isCancelled?.()) throw new Error('cancelled');
    const destination = path.join(root, task.relative);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    try {
      await downloadFile(task.raw.url, destination, {
        size: task.raw.size,
        sha1: task.raw.sha1,
        isCancelled,
      });
    } catch (error) {
      if (error.cancelled) throw error;
      throw new Error(`Не удалось скачать Java: ${error.message}`);
    }
    reporter.addFile(task.raw.size || 0);
  });

  if (!(await exists(javaExe))) {
    throw new Error('Java скачана, но исполняемый файл не найден. Попробуйте указать Java вручную.');
  }

  reporter.finish('Java готова');
  return { path: javaExe, major: required, version: versionName, source: 'mojang' };
}

async function getSystemInfo(settings) {
  const paths = getPaths(settings?.gameDir);
  const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
  const cpus = os.cpus();
  return {
    launcherVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    totalMemMb,
    freeMemMb: Math.round(os.freemem() / (1024 * 1024)),
    cpu: cpus[0]?.model?.trim() || 'Неизвестный процессор',
    cpuCount: cpus.length,
    hostname: os.hostname(),
    userData: app.getPath('userData'),
    defaultGameDir: path.join(app.getPath('appData'), '.minecraft'),
    gameDir: paths.gameDir,
    paths,
    java: javaCache.list,
    runtimePlatform: runtimePlatform(),
  };
}

async function pickFolder(defaultPath) {
  const result = await dialog.showOpenDialog({
    title: 'Выберите папку',
    defaultPath: defaultPath || app.getPath('home'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
}

async function pickJavaFile(defaultPath) {
  const result = await dialog.showOpenDialog({
    title: 'Выберите исполняемый файл Java',
    defaultPath: defaultPath || 'C:\\Program Files\\Java',
    properties: ['openFile'],
    filters:
      process.platform === 'win32'
        ? [{ name: 'Java', extensions: ['exe'] }]
        : [{ name: 'Все файлы', extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePaths[0];
}

async function openPath(target) {
  if (!target) return { ok: false, error: 'Путь не указан' };
  await fsp.mkdir(target, { recursive: true }).catch(() => {});
  const error = await shell.openPath(target);
  return error ? { ok: false, error } : { ok: true };
}

async function openExternal(url) {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Недопустимая ссылка' };
  await shell.openExternal(url);
  return { ok: true };
}

module.exports = {
  osName,
  runtimePlatform,
  getPaths,
  ensureGameDirs,
  getJavaCandidates,
  chooseJava,
  ensureJavaRuntime,
  requiredJavaMajor,
  getSystemInfo,
  pickFolder,
  pickJavaFile,
  openPath,
  openExternal,
  probeJava,
  sha1File,
};
