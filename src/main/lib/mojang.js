'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const {
  CancelledError,
  readJson,
  writeJson,
  fetchJson,
  fetchText,
  downloadFile,
  mapPool,
  exists,
  statSafe,
  ProgressReporter,
} = require('./http');
const {
  getPaths,
  ensureGameDirs,
  osName,
  requiredJavaMajor,
  chooseJava,
  ensureJavaRuntime,
} = require('./system');

const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const ASSET_BASE_URL = 'https://resources.download.minecraft.net';
const FABRIC_META_URL = 'https://meta.fabricmc.net/v2';
const LIBRARY_BASE_URL = 'https://libraries.minecraft.net/';
const FORGE_MAVEN_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const FORGE_PROMOTIONS_URL =
  'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN_METADATA_URL = `${FORGE_MAVEN_URL}/maven-metadata.xml`;
const OPTIFINE_DOWNLOADS_URL = 'https://optifine.net/downloads';
const OPTIFINE_SITE_URL = 'https://optifine.net';

const metaCache = new Map();
const fabricLoaderCache = new Map();
const forgeCache = new Map();
const optifineCache = new Map();
let manifestMemory = null;

function ruleMatches(rule, features = {}) {
  if (rule.os) {
    const name = osName();
    if (rule.os.name && rule.os.name !== name) return false;
    if (rule.os.arch) {
      const arch = process.arch === 'ia32' ? 'x86' : process.arch;
      if (rule.os.arch !== arch) return false;
    }
    if (rule.os.version) {
      try {
        if (!new RegExp(rule.os.version).test(os.release())) return false;
      } catch {
        return false;
      }
    }
  }
  if (rule.features) {
    for (const [key, value] of Object.entries(rule.features)) {
      if (Boolean(features[key]) !== Boolean(value)) return false;
    }
  }
  return true;
}

function rulesAllow(rules, features = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    const matches = ruleMatches(rule, features);
    if (rule.action === 'allow' && matches) allowed = true;
    else if (rule.action === 'disallow' && matches) allowed = false;
  }
  return allowed;
}

function mavenRelativePath(name) {
  const [coords, extension = 'jar'] = name.split('@');
  const parts = coords.split(':');
  const [group, artifact, version, classifier] = parts;
  if (!group || !artifact || !version) return null;
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

function libraryArtifact(lib) {
  const artifact = lib.downloads?.artifact;
  if (artifact?.path) {
    return {
      path: artifact.path,
      // Some Forge/OptiFine profiles point at a locally installed artifact
      // without a download URL. It still belongs on the classpath.
      url: artifact.url || null,
      size: artifact.size,
      sha1: artifact.sha1,
      localOnly: !artifact.url,
    };
  }
  if (lib.name) {
    const relative = mavenRelativePath(lib.name);
    if (!relative) return null;
    // OptiFine puts its libraries in the game directory but does not add a
    // repository URL to the profile. Do not invent a Minecraft library URL.
    if (!lib.url && !lib.downloads) {
      return { path: relative, url: null, size: lib.size, sha1: lib.sha1, localOnly: true };
    }
    const base = (lib.url || LIBRARY_BASE_URL).replace(/\/?$/, '/');
    return { path: relative, url: base + relative, size: lib.size, sha1: lib.sha1 };
  }
  return null;
}

function nativeArtifact(lib) {
  const classifierTemplate = lib.natives?.[osName()];
  if (!classifierTemplate) return null;
  const arch = process.arch === 'ia32' ? '32' : '64';
  const classifier = classifierTemplate.replace('${arch}', arch);
  const fromDownloads = lib.downloads?.classifiers?.[classifier];
  if (fromDownloads?.path && fromDownloads?.url) {
    return {
      path: fromDownloads.path,
      url: fromDownloads.url,
      size: fromDownloads.size,
      sha1: fromDownloads.sha1,
    };
  }
  if (lib.name) {
    const relative = mavenRelativePath(`${lib.name}:${classifier}`);
    if (!relative) return null;
    const base = (lib.url || LIBRARY_BASE_URL).replace(/\/?$/, '/');
    return { path: relative, url: base + relative, size: null, sha1: null };
  }
  return null;
}

/**
 * Collect the libraries needed to run a version on this machine.
 */
function collectLibraries(meta, features = {}) {
  const artifacts = new Map();
  const natives = [];
  for (const lib of meta.libraries || []) {
    if (!rulesAllow(lib.rules, features)) continue;
    const artifact = libraryArtifact(lib);
    if (artifact && !artifacts.has(artifact.path)) {
      artifacts.set(artifact.path, artifact);
    }
    const native = nativeArtifact(lib);
    if (native) {
      natives.push({ ...native, exclude: lib.extract?.exclude || [] });
    }
  }
  return { artifacts: [...artifacts.values()], natives };
}

function getClasspath(meta, librariesDir) {
  const { artifacts } = collectLibraries(meta);
  return [...new Set(artifacts.map((artifact) => path.join(librariesDir, artifact.path)))];
}

async function getManifest(force = false) {
  const cacheFile = path.join(getPaths().cache, 'version_manifest.json');
  if (!force && manifestMemory && Date.now() - manifestMemory.at < 10 * 60 * 1000) {
    return manifestMemory.data;
  }

  if (!force) {
    const cached = await readJson(cacheFile, null);
    if (cached?.data && Date.now() - cached.at < 10 * 60 * 1000) {
      manifestMemory = { at: cached.at, data: cached.data };
      return cached.data;
    }
  }

  try {
    const data = await fetchJson(VERSION_MANIFEST_URL);
    manifestMemory = { at: Date.now(), data };
    await writeJson(cacheFile, { at: Date.now(), data }).catch(() => {});
    return data;
  } catch (error) {
    const cached = await readJson(cacheFile, null);
    if (cached?.data) {
      manifestMemory = { at: Date.now(), data: cached.data };
      return cached.data;
    }
    throw new Error('Нет связи с серверами Mojang. Проверьте подключение к интернету.');
  }
}

async function getVersionMeta(versionId, { force = false, gameDir } = {}) {
  const cacheKey = `${path.resolve(gameDir || getPaths().gameDir)}::${versionId}`;
  if (!force && metaCache.has(cacheKey)) return metaCache.get(cacheKey);

  const paths = getPaths(gameDir);
  const installedFile = path.join(paths.versions, versionId, `${versionId}.json`);
  if (await exists(installedFile)) {
    const local = await readJson(installedFile, null);
    if (local?.id) {
      metaCache.set(cacheKey, local);
      return local;
    }
  }

  const cacheFile = path.join(paths.cache, 'meta', `${versionId}.json`);
  if (!force) {
    const cached = await readJson(cacheFile, null);
    if (cached?.id) {
      metaCache.set(cacheKey, cached);
      return cached;
    }
  }

  const manifest = await getManifest();
  const entry = manifest.versions.find((version) => version.id === versionId);
  if (!entry) throw new Error(`Версия ${versionId} не найдена в списке Mojang`);

  try {
    const data = await fetchJson(entry.url);
    metaCache.set(cacheKey, data);
    await writeJson(cacheFile, data).catch(() => {});
    return data;
  } catch (error) {
    const cached = await readJson(cacheFile, null);
    if (cached?.id) return cached;
    throw error;
  }
}

function libraryKey(lib) {
  const name = String(lib?.name || '');
  if (!name) return '';
  return name.split('@')[0];
}

function mergeLibraries(parentLibraries, childLibraries) {
  const parent = Array.isArray(parentLibraries) ? parentLibraries : [];
  const child = Array.isArray(childLibraries) ? childLibraries : [];
  if (!child.length) return [...parent];
  const childKeys = new Set(child.map(libraryKey).filter(Boolean));
  return [
    ...parent.filter((library) => !childKeys.has(libraryKey(library))),
    ...child,
  ];
}

function mergeArguments(parentArguments, childArguments) {
  if (!parentArguments && !childArguments) return undefined;
  return {
    ...(parentArguments || {}),
    ...(childArguments || {}),
    game: [...(parentArguments?.game || []), ...(childArguments?.game || [])],
    jvm: [...(parentArguments?.jvm || []), ...(childArguments?.jvm || [])],
  };
}

function hasLogging(meta) {
  return Boolean(meta?.logging && Object.keys(meta.logging).length);
}

/**
 * Merge a version profile with the profile it inherits from. Forge and
 * OptiFine both install profiles with `inheritsFrom`, so the launcher must
 * combine the parent's assets/libraries/JVM arguments with the child's
 * loader-specific additions without writing a merged profile to disk.
 */
function mergeInheritedMeta(parent, child, versionId) {
  const merged = {
    ...parent,
    ...child,
    id: child.id || versionId,
    type: child.type || parent.type,
    mainClass: child.mainClass || parent.mainClass,
    releaseTime: child.releaseTime || parent.releaseTime,
    time: child.time || parent.time,
    libraries: mergeLibraries(parent.libraries, child.libraries),
    arguments: mergeArguments(parent.arguments, child.arguments),
    minecraftArguments: child.minecraftArguments || parent.minecraftArguments,
    downloads: { ...(parent.downloads || {}), ...(child.downloads || {}) },
    assetIndex: child.assetIndex || parent.assetIndex,
    assets: child.assets || parent.assets,
    javaVersion: child.javaVersion || parent.javaVersion,
    logging: hasLogging(child) ? { ...(parent.logging || {}), ...child.logging } : parent.logging,
    jar: child.jar || parent.jar,
    inheritsFrom: child.inheritsFrom || parent.inheritsFrom,
  };
  if (child.arguments && parent.minecraftArguments && !parent.arguments) {
    // Very old profiles use minecraftArguments; keep it available when the
    // child adds modern `arguments.game` entries.
    merged.minecraftArguments = child.minecraftArguments || parent.minecraftArguments;
  }
  return merged;
}

async function resolveVersionMeta(versionId, gameDir, { force = false, _seen } = {}) {
  const seen = _seen || new Set();
  if (seen.has(versionId)) {
    throw new Error(`Циклическая зависимость профиля ${versionId}`);
  }
  seen.add(versionId);

  const meta = await getVersionMeta(versionId, { force, gameDir });
  if (!meta.inheritsFrom) {
    return { ...meta, clientJarId: meta.jar || meta.id || versionId };
  }

  if (seen.has(meta.inheritsFrom)) {
    throw new Error(`Циклическая зависимость профиля ${versionId}`);
  }
  const parent = await resolveVersionMeta(meta.inheritsFrom, gameDir, {
    force,
    _seen: seen,
  });
  const merged = mergeInheritedMeta(parent, meta, versionId);
  merged.clientJarId = meta.jar || parent.clientJarId || parent.id;
  return merged;
}

function getClientJarPath(meta, versionId, paths) {
  const jarId = meta?.clientJarId || meta?.jar || meta?.inheritsFrom || versionId;
  return path.join(paths.versions, jarId, `${jarId}.jar`);
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function detectLoaderType(meta, versionId = '') {
  const id = String(meta?.id || versionId || '');
  const mainClass = String(meta?.mainClass || '');
  const libraries = Array.isArray(meta?.libraries) ? meta.libraries : [];
  const names = libraries.map((lib) => String(lib?.name || ''));

  if (
    meta?.fabric ||
    /^fabric-loader-/i.test(id) ||
    /fabric/i.test(mainClass) ||
    names.some((name) => /^net\.fabricmc:/i.test(name))
  ) {
    return 'fabric';
  }

  if (
    /forge/i.test(id) ||
    /forge/i.test(mainClass) ||
    names.some(
      (name) =>
        /^net\.minecraftforge:/i.test(name) ||
        /^cpw\.mods:(?:bootstraplauncher|modlauncher|securejarhandler)/i.test(name),
    ) ||
    JSON.stringify(meta?._comment_ || '').toLowerCase().includes('forge')
  ) {
    return 'forge';
  }

  if (
    /optifine/i.test(id) ||
    names.some((name) => /^optifine:/i.test(name))
  ) {
    return 'optifine';
  }

  return 'vanilla';
}

function extractForgeVersion(meta, versionId = '', gameVersion = '') {
  const id = String(meta?.id || versionId || '');
  const libraries = Array.isArray(meta?.libraries) ? meta.libraries : [];
  for (const lib of libraries) {
    const match = String(lib?.name || '').match(/^net\.minecraftforge:(?:forge|fmlloader|fmlcore):(.+)$/i);
    if (match) {
      const value = match[1].replace(/:(?:universal|client|server)$/i, '');
      if (gameVersion && value.startsWith(`${gameVersion}-`)) {
        return value.slice(gameVersion.length + 1);
      }
      return value;
    }
  }
  const suffix = gameVersion ? id.split(`${gameVersion}-`).pop() : id;
  const match = String(suffix).match(/forge-?(.+)$/i);
  if (match) return match[1].replace(/^forge-?/i, '');
  return null;
}

function extractOptiFineVersion(meta, versionId = '') {
  const id = String(meta?.id || versionId || '');
  const match = id.match(/optifine[_-](.+)$/i);
  return match ? match[1] : null;
}

function clearMetaCacheFor(versionId) {
  for (const key of [...metaCache.keys()]) {
    if (key.endsWith(`::${versionId}`)) metaCache.delete(key);
  }
}

async function ensureLauncherProfiles(gameDir) {
  const file = path.join(gameDir, 'launcher_profiles.json');
  let raw = null;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    raw = null;
  }

  if (raw != null) {
    try {
      const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (raw.charCodeAt(0) === 0xfeff) await writeJson(file, data);
      return file;
    } catch {
      // A broken BOM/format file makes the official installers fail. Keep a
      // backup so the user can recover their old launcher profiles.
      const backup = `${file}.ylayncher-backup-${Date.now()}`;
      await fsp.rename(file, backup).catch(() => {});
    }
  }

  await writeJson(file, {
    profiles: {},
    settings: {
      enableSnapshots: false,
      enableAdvanced: false,
      keepLauncherOpen: false,
      showGameLog: false,
      showMenu: false,
      soundOn: false,
    },
    version: 3,
  });
  return file;
}

function runProcess(command, args, { cwd, isCancelled, onLine, timeout = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelled = false;
    let killedForTimeout = false;
    const chunks = [];
    const errors = [];

    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      if (error) reject(error);
      else resolve({ code, stdout: chunks.join(''), stderr: errors.join('') });
    };

    const killTree = () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
    };

    const wire = (stream, sink) => {
      let pending = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk) => {
        sink.push(chunk);
        const lines = (pending + chunk).split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) onLine?.(line.trim());
        }
      });
      stream?.on('end', () => {
        if (pending.trim()) onLine?.(pending.trim());
      });
    };

    wire(child.stdout, chunks);
    wire(child.stderr, errors);

    const timer = setTimeout(() => {
      killedForTimeout = true;
      killTree();
    }, timeout);

    const cancelPoll = setInterval(() => {
      if (isCancelled?.() && !cancelled) {
        cancelled = true;
        killTree();
      }
    }, 350);

    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (cancelled) {
        finish(new CancelledError());
      } else if (killedForTimeout) {
        finish(new Error('Установщик не завершился за отведённое время'));
      } else if (code !== 0) {
        const tail = [...errors, ...chunks]
          .join('\n')
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-6)
          .join('\n');
        finish(
          new Error(
            `Установщик завершился с кодом ${code}${tail ? `\n${tail}` : ''}`,
          ),
        );
      } else {
        finish(null, code);
      }
    });
  });
}

async function listVersionIds(paths) {
  const entries = await fsp.readdir(paths.versions, { withFileTypes: true }).catch(() => []);
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
}

async function findLoaderProfile({
  paths,
  loader,
  gameVersion,
  loaderVersion,
  optifineFile,
  before,
}) {
  const ids = [...(await listVersionIds(paths))];
  const candidates = [];
  const optifineSuffix = optifineFile
    ? String(optifineFile)
        .replace(/\.jar$/i, '')
        .replace(new RegExp(`^OptiFine_${gameVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_?`, 'i'), '')
    : '';

  for (const id of ids) {
    const jsonFile = path.join(paths.versions, id, `${id}.json`);
    const stat = await statSafe(jsonFile);
    if (!stat) continue;
    const meta = await readJson(jsonFile, null);
    if (!meta?.id) continue;
    const detected = detectLoaderType(meta, id);
    if (detected !== loader) continue;
    const parent = String(meta.inheritsFrom || '');
    if (gameVersion && parent && parent !== gameVersion && !id.includes(gameVersion)) continue;
    if (!parent && gameVersion && id !== gameVersion && !id.includes(gameVersion)) continue;

    let exact = false;
    if (loader === 'forge' && loaderVersion) {
      exact = extractForgeVersion(meta, id, gameVersion) === loaderVersion;
    } else if (loader === 'optifine') {
      exact = optifineSuffix
        ? new RegExp(`optifine[_-]${optifineSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(id)
        : true;
      if (!exact && optifineFile) exact = id.toLowerCase().includes(optifineSuffix.toLowerCase());
    } else {
      exact = true;
    }

    candidates.push({
      id,
      meta,
      exact,
      isNew: before ? !before.has(id) : true,
      time: stat.mtimeMs || 0,
    });
  }

  candidates.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
    return b.time - a.time;
  });
  return candidates[0] || null;
}

async function getForgeBuilds(gameVersion, force = false) {
  const cacheKey = `forge::${gameVersion}`;
  const cached = forgeCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.data;

  const [xml, promotions] = await Promise.all([
    fetchText(FORGE_MAVEN_METADATA_URL),
    fetchJson(FORGE_PROMOTIONS_URL).catch(() => ({ promos: {} })),
  ]);
  const available = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((match) => match[1].trim())
    .filter((version) => version.startsWith(`${gameVersion}-`));
  const promos = promotions?.promos || {};
  const latest = promos[`${gameVersion}-latest`] || null;
  const recommended = promos[`${gameVersion}-recommended`] || null;

  const builds = available.map((fullVersion) => {
    const version = fullVersion.slice(gameVersion.length + 1);
    return {
      loader: 'forge',
      gameVersion,
      version,
      fullVersion,
      latest: version === latest,
      recommended: version === recommended,
      installerUrl: `${FORGE_MAVEN_URL}/${fullVersion}/forge-${fullVersion}-installer.jar`,
    };
  });

  builds.sort((a, b) => naturalCompare(b.version, a.version));
  forgeCache.set(cacheKey, { at: Date.now(), data: builds });
  return builds;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseOptiFineDownloads(html) {
  const groups = [];
  const groupPattern = /<h2>\s*Minecraft\s+([^<]+)\s*<\/h2>([\s\S]*?)(?=<h2>|$)/gi;
  for (const groupMatch of html.matchAll(groupPattern)) {
    const gameVersion = groupMatch[1].trim();
    const body = groupMatch[2];
    const builds = [];
    const rowPattern = /<tr\s+class=['"]([^'"]*downloadLine[^'"]*)['"][^>]*>([\s\S]*?)<\/tr>/gi;
    for (const rowMatch of body.matchAll(rowPattern)) {
      const classes = rowMatch[1].toLowerCase();
      const row = rowMatch[2];
      const fileMatch = row.match(/(?:\?|&)f=([^"'&>]+\.jar)/i);
      if (!fileMatch) continue;
      const fileName = decodeURIComponent(fileMatch[1]);
      const label = stripHtml(row.match(/class=['"]colFile['"][^>]*>([\s\S]*?)<\/td>/i)?.[1]);
      const date = stripHtml(row.match(/class=['"]colDate['"][^>]*>([\s\S]*?)<\/td>/i)?.[1]);
      const forge = stripHtml(row.match(/class=['"]colForge['"][^>]*>([\s\S]*?)<\/td>/i)?.[1]);
      builds.push({
        loader: 'optifine',
        gameVersion,
        fileName,
        label: label || fileName.replace(/\.jar$/i, ''),
        date,
        forge,
        preview: classes.includes('preview'),
        main: classes.includes('main'),
        old: classes.includes('more'),
        downloadUrl: `${OPTIFINE_SITE_URL}/adloadx?f=${encodeURIComponent(fileName)}`,
      });
    }
    if (builds.length) groups.push({ gameVersion, builds });
  }
  return groups;
}

async function getOptiFineBuilds(gameVersion, force = false) {
  const cacheKey = gameVersion || '*';
  const cached = optifineCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.data;

  const html = await fetchText(OPTIFINE_DOWNLOADS_URL);
  const groups = parseOptiFineDownloads(html);
  optifineCache.set('*', { at: Date.now(), data: groups });
  const target = groups.find((group) => group.gameVersion === gameVersion);
  const builds = target ? [...target.builds] : [];
  builds.sort((a, b) => {
    const rank = (build) => (build.main ? 0 : build.preview ? 1 : 2);
    return rank(a) - rank(b);
  });
  optifineCache.set(cacheKey, { at: Date.now(), data: builds });
  return builds;
}

async function resolveOptiFineDownloadUrl(fileName) {
  const pageUrl = `${OPTIFINE_SITE_URL}/adloadx?f=${encodeURIComponent(fileName)}`;
  const html = await fetchText(pageUrl);
  const match = html.match(/href=['"](?:https?:\/\/optifine\.net\/)?(downloadx\?f=[^"'&]+&x=[^"'&]+)['"]/i);
  if (!match) {
    throw new Error('Не удалось получить ссылку на скачивание OptiFine. Попробуйте позже.');
  }
  return `${OPTIFINE_SITE_URL}/${match[1].replace(/&amp;/g, '&')}`;
}

async function chooseInstallerJava(meta, paths, reporter, isCancelled) {
  const required = requiredJavaMajor(meta);
  let java = await chooseJava(required);
  if (!java) {
    reporter?.setStage('java', `Java ${required} не найдена. Скачиваем автоматически…`);
    java = await ensureJavaRuntime(meta, {
      runtimeDir: paths.runtime,
      isCancelled,
      onProgress: (progress) => reporter?.setStage('java', progress.message),
    });
  }
  return java.javaPath || java.path;
}

async function ensureOptiFineHelper(paths) {
  const source = path.join(__dirname, '..', '..', '..', 'assets', 'java', 'OptiFineRunner.class');
  const destinationDir = path.join(paths.cache, 'helpers');
  const destination = path.join(destinationDir, 'OptiFineRunner.class');
  const existing = await statSafe(destination);
  const sourceStat = await statSafe(source);
  if (existing && sourceStat && existing.size === sourceStat.size) return destinationDir;
  await fsp.mkdir(destinationDir, { recursive: true });
  try {
    await fsp.copyFile(source, destination);
  } catch {
    throw new Error('В сборке лаунчера отсутствует помощник установки OptiFine.');
  }
  return destinationDir;
}

async function installForgeBuild({
  gameVersion,
  loaderVersion,
  gameDir,
  paths,
  reporter,
  isCancelled,
  check,
}) {
  const builds = await getForgeBuilds(gameVersion);
  const chosen =
    builds.find((build) => build.version === loaderVersion) ||
    builds.find((build) => build.recommended) ||
    builds.find((build) => build.latest) ||
    builds[0];
  if (!chosen) {
    throw new Error(`Forge не поддерживает Minecraft ${gameVersion}.`);
  }
  if (loaderVersion && chosen.version !== loaderVersion) {
    throw new Error(`Версия Forge ${loaderVersion} для Minecraft ${gameVersion} не найдена.`);
  }

  reporter.setStage('loader', `Подготовка Forge ${chosen.version}…`);
  await installVersion({
    versionId: gameVersion,
    loader: 'vanilla',
    gameDir,
    onProgress: reporter.callback,
    isCancelled,
    internal: true,
  });
  check();

  await ensureLauncherProfiles(paths.gameDir);
  const installerFile = path.join(
    paths.cache,
    'installers',
    `forge-${chosen.fullVersion}-installer.jar`,
  );
  reporter.setStage('loader', 'Скачивание установщика Forge…');
  await downloadFile(chosen.installerUrl, installerFile, { isCancelled });
  check();

  const parentMeta = await getVersionMeta(gameVersion, { gameDir });
  reporter.setStage('loader', `Установка Forge ${chosen.version}…`);
  const javaPath = await chooseInstallerJava(parentMeta, paths, reporter, isCancelled);
  const before = await listVersionIds(paths);
  await runProcess(javaPath, ['-jar', installerFile, '--installClient', paths.gameDir], {
    cwd: paths.gameDir,
    isCancelled,
    onLine: (line) => {
      if (/download|install|extract|error/i.test(line)) {
        reporter.setStage('loader', `Forge: ${line.slice(0, 180)}`);
      }
    },
  });
  check();

  const found = await findLoaderProfile({
    paths,
    loader: 'forge',
    gameVersion,
    loaderVersion: chosen.version,
    before,
  });
  if (!found) {
    throw new Error(
      'Forge установился, но созданный профиль не найден. Проверьте папку versions.',
    );
  }
  return {
    profileId: found.id,
    profileMeta: found.meta,
    loaderVersion: chosen.version,
    displayName: `Forge ${chosen.version} · ${gameVersion}`,
  };
}

async function installOptiFineBuild({
  gameVersion,
  loaderVersion,
  gameDir,
  paths,
  reporter,
  isCancelled,
  check,
}) {
  const builds = await getOptiFineBuilds(gameVersion);
  const chosen =
    builds.find((build) => build.fileName === loaderVersion) ||
    builds.find((build) => build.label === loaderVersion) ||
    builds.find((build) => build.main) ||
    builds.find((build) => !build.preview && !build.old) ||
    builds[0];
  if (!chosen) {
    throw new Error(`OptiFine не поддерживает Minecraft ${gameVersion}.`);
  }

  reporter.setStage('loader', `Подготовка ${chosen.label}…`);
  await installVersion({
    versionId: gameVersion,
    loader: 'vanilla',
    gameDir,
    onProgress: reporter.callback,
    isCancelled,
    internal: true,
  });
  check();

  await ensureLauncherProfiles(paths.gameDir);
  const installerFile = path.join(paths.cache, 'installers', chosen.fileName);
  reporter.setStage('loader', 'Скачивание установщика OptiFine…');
  if (!(await exists(installerFile))) {
    const url = await resolveOptiFineDownloadUrl(chosen.fileName);
    await downloadFile(url, installerFile, { isCancelled });
  }
  check();

  const parentMeta = await getVersionMeta(gameVersion, { gameDir });
  reporter.setStage('loader', `Установка ${chosen.label}…`);
  const javaPath = await chooseInstallerJava(parentMeta, paths, reporter, isCancelled);
  const helperDir = await ensureOptiFineHelper(paths);
  const classpath = [helperDir, installerFile].join(path.delimiter);
  const before = await listVersionIds(paths);
  await runProcess(
    javaPath,
    ['-cp', classpath, 'OptiFineRunner', paths.gameDir],
    {
      cwd: paths.gameDir,
      isCancelled,
      onLine: (line) => {
        if (/install|download|error|exception/i.test(line)) {
          reporter.setStage('loader', `OptiFine: ${line.slice(0, 180)}`);
        }
      },
    },
  );
  check();

  const found = await findLoaderProfile({
    paths,
    loader: 'optifine',
    gameVersion,
    optifineFile: chosen.fileName,
    before,
  });
  if (!found) {
    throw new Error(
      'OptiFine установился, но созданный профиль не найден. Проверьте папку versions.',
    );
  }
  return {
    profileId: found.id,
    profileMeta: found.meta,
    loaderVersion: chosen.fileName,
    displayName: `${chosen.label} · ${gameVersion}`,
  };
}

async function getFabricLoaders(gameVersion) {
  if (fabricLoaderCache.has(gameVersion)) return fabricLoaderCache.get(gameVersion);
  const data = await fetchJson(
    `${FABRIC_META_URL}/versions/loader/${encodeURIComponent(gameVersion)}`,
  );
  const loaders = (Array.isArray(data) ? data : []).map((item) => ({
    version: item.loader?.version,
    stable: Boolean(item.loader?.stable),
  })).filter((item) => item.version);
  fabricLoaderCache.set(gameVersion, loaders);
  return loaders;
}

async function getFabricProfile(gameVersion, loaderVersion) {
  return fetchJson(
    `${FABRIC_META_URL}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(
      loaderVersion,
    )}/profile/json`,
  );
}

function mergeFabricMeta(parent, profile, gameVersion, loaderVersion) {
  const parentArgs = parent.arguments || {};
  const profileArgs = profile.arguments || {};
  const fabricId = profile.id || `fabric-loader-${loaderVersion}-${gameVersion}`;
  return {
    ...parent,
    id: fabricId,
    type: 'fabric',
    mainClass: profile.mainClass,
    releaseTime: profile.releaseTime || parent.releaseTime,
    time: profile.time || parent.time,
    libraries: [...(parent.libraries || []), ...(profile.libraries || [])],
    arguments: {
      game: [...(parentArgs.game || []), ...(profileArgs.game || [])],
      jvm: [...(parentArgs.jvm || []), ...(profileArgs.jvm || [])],
    },
    vanilla: {
      id: parent.id,
      type: parent.type,
      releaseTime: parent.releaseTime,
    },
    fabric: { loaderVersion, gameVersion },
  };
}

async function getFabricInfoForVersion(versionId, gameDir) {
  const raw = String(versionId || '');
  if (!raw.startsWith('fabric-loader-')) return null;

  // Fast path: a complete or partially installed Fabric build keeps the
  // parsed versions in its merged metadata.
  const paths = getPaths(gameDir);
  const local = await readJson(path.join(paths.versions, raw, `${raw}.json`), null);
  if (local?.fabric?.loaderVersion && local?.fabric?.gameVersion) {
    return {
      loaderVersion: local.fabric.loaderVersion,
      gameVersion: local.fabric.gameVersion,
    };
  }

  const rest = raw.slice('fabric-loader-'.length);
  if (!rest) return null;

  // Profile ids look like fabric-loader-<loader>-<game>. Both parts may
  // contain dots and dashes, so test every split from left to right and
  // validate the game version against the Mojang manifest when available.
  const manifest = await getManifest().catch(() => null);
  const knownGames = new Set((manifest?.versions || []).map((version) => version.id));
  const candidates = [];
  for (let index = rest.indexOf('-'); index !== -1; index = rest.indexOf('-', index + 1)) {
    candidates.push([rest.slice(0, index), rest.slice(index + 1)]);
  }
  candidates.push([rest, '']);
  if (knownGames.size) {
    const ordered = candidates.filter(([, game]) => !game || knownGames.has(game));
    candidates.length = 0;
    candidates.push(...ordered);
  }

  for (const [loaderVersion, gameVersion] of candidates) {
    if (!loaderVersion || !gameVersion) continue;
    const loaders = await getFabricLoaders(gameVersion).catch(() => []);
    if (loaders.some((item) => item.version === loaderVersion)) {
      return { loaderVersion, gameVersion };
    }
  }
  return null;
}

async function installVersion({
  versionId,
  loader = 'vanilla',
  loaderVersion,
  gameDir,
  onProgress,
  isCancelled,
  internal = false,
}) {
  const paths = getPaths(gameDir);
  await ensureGameDirs(paths);

  const reporter = new ProgressReporter(onProgress);
  const check = () => {
    if (isCancelled?.()) throw new CancelledError();
  };

  reporter.setStage('meta', 'Получение информации о версии…');
  check();

  let meta;
  let writeMeta;
  let record;

  if (loader === 'fabric') {
    reporter.setStage('meta', 'Подготовка Fabric…');
    const parent = await getVersionMeta(versionId, { gameDir });
    const loaders = await getFabricLoaders(versionId).catch(() => []);
    const chosenLoader =
      loaderVersion ||
      loaders.find((item) => item.stable)?.version ||
      loaders[0]?.version;
    if (!chosenLoader) {
      throw new Error(
        `Fabric не поддерживает версию ${versionId} или сервер Fabric недоступен.`,
      );
    }
    const profile = await getFabricProfile(versionId, chosenLoader);
    meta = mergeFabricMeta(parent, profile, versionId, chosenLoader);
    writeMeta = meta;
    record = {
      id: meta.id,
      loader: 'fabric',
      gameVersion: versionId,
      loaderVersion: chosenLoader,
      displayName: `Fabric ${chosenLoader} · ${versionId}`,
    };
  } else if (loader === 'forge') {
    const installed = await installForgeBuild({
      gameVersion: versionId,
      loaderVersion,
      gameDir,
      paths,
      reporter,
      isCancelled,
      check,
    });
    meta = await resolveVersionMeta(installed.profileId, gameDir, { force: true });
    writeMeta = installed.profileMeta;
    record = {
      id: installed.profileId,
      loader: 'forge',
      gameVersion: versionId,
      loaderVersion: installed.loaderVersion,
      displayName: installed.displayName,
    };
  } else if (loader === 'optifine') {
    const installed = await installOptiFineBuild({
      gameVersion: versionId,
      loaderVersion,
      gameDir,
      paths,
      reporter,
      isCancelled,
      check,
    });
    meta = await resolveVersionMeta(installed.profileId, gameDir, { force: true });
    writeMeta = installed.profileMeta;
    record = {
      id: installed.profileId,
      loader: 'optifine',
      gameVersion: versionId,
      loaderVersion: installed.loaderVersion,
      displayName: installed.displayName,
    };
  } else {
    writeMeta = await getVersionMeta(versionId, { gameDir });
    meta = await resolveVersionMeta(versionId, gameDir).catch(() => writeMeta);
    record = {
      id: meta.id,
      loader: 'vanilla',
      gameVersion: meta.id,
      displayName: meta.id,
    };
  }

  check();
  const versionDir = path.join(paths.versions, meta.id);
  const versionFile = path.join(versionDir, `${meta.id}.json`);
  const clientJar = getClientJarPath(meta, meta.id, paths);
  const nativesDir = path.join(versionDir, 'natives');
  const installingMarker = path.join(versionDir, '.installing');
  await fsp.mkdir(versionDir, { recursive: true });
  await fsp.mkdir(path.dirname(clientJar), { recursive: true });
  await writeJson(installingMarker, {
    startedAt: new Date().toISOString(),
    versionId: meta.id,
    loader,
  });
  await writeJson(versionFile, writeMeta || meta);

  // Discover assets.
  let assetsIndex = null;
  let assetItems = [];
  let totalAssetBytes = 0;
  const indexFile = meta.assetIndex
    ? path.join(paths.assets, 'indexes', `${meta.assetIndex.id}.json`)
    : null;

  if (meta.assetIndex?.url) {
    reporter.setStage('assets', 'Индекс ресурсов…');
    await fsp.mkdir(path.dirname(indexFile), { recursive: true });
    await downloadFile(meta.assetIndex.url, indexFile, {
      size: meta.assetIndex.size,
      sha1: meta.assetIndex.sha1,
      verifyExisting: true,
      isCancelled,
    });
    assetsIndex = await readJson(indexFile, null);
    if (assetsIndex?.objects) {
      const unique = new Map();
      for (const object of Object.values(assetsIndex.objects)) {
        if (object?.hash) unique.set(object.hash, object);
      }
      assetItems = [...unique.values()].map((object) => ({
        hash: object.hash,
        size: object.size || 0,
      }));
      totalAssetBytes = assetItems.reduce((sum, item) => sum + item.size, 0);
    }
  }
  check();

  const { artifacts, natives } = collectLibraries(meta);
  const logFile = meta.logging?.client?.file;
  const logConfigDest = logFile
    ? path.join(paths.assets, 'log_configs', logFile.id)
    : null;

  const totalBytes =
    (await exists(clientJar) ? 0 : meta.downloads?.client?.size || 0) +
    artifacts.reduce((sum, item) => sum + (item.size || 0), 0) +
    natives.reduce((sum, item) => sum + (item.size || 0), 0) +
    totalAssetBytes +
    (logFile?.size || 0);

  const totalFiles =
    1 + artifacts.length + natives.length + assetItems.length + (logFile ? 1 : 0);

  reporter.setTotals(totalBytes, totalFiles);

  // Client jar. For inherited profiles it lives in the parent version
  // directory, because Forge/OptiFine do not copy the Minecraft client.
  if (meta.downloads?.client?.url) {
    reporter.setStage('client', 'Скачивание клиента Minecraft…');
    const client = meta.downloads.client;
    await downloadFile(client.url, clientJar, {
      size: client.size,
      sha1: client.sha1,
      verifyExisting: true,
      isCancelled,
    });
    reporter.addFile(client.size || 0);
  } else if (!(await exists(clientJar))) {
    throw new Error('В данных версии отсутствует клиент Minecraft');
  }

  // Logging configuration.
  if (logFile?.url) {
    await fsp.mkdir(path.dirname(logConfigDest), { recursive: true });
    await downloadFile(logFile.url, logConfigDest, {
      size: logFile.size,
      sha1: logFile.sha1,
      isCancelled,
    });
    reporter.addFile(logFile.size || 0);
  }

  check();
  await fsp.mkdir(paths.libraries, { recursive: true });
  reporter.setStage('libraries', 'Скачивание библиотек…');
  await mapPool(artifacts, 8, async (artifact) => {
    check();
    const destination = path.join(paths.libraries, artifact.path);
    if (artifact.url) {
      await downloadFile(artifact.url, destination, {
        size: artifact.size,
        sha1: artifact.sha1,
        verifyExisting: true,
        isCancelled,
      });
    } else if (!(await exists(destination))) {
      throw new Error(
        `Не найдена локальная библиотека ${artifact.path}. Переустановите версию.`,
      );
    }
    reporter.addFile(artifact.size || 0);
  });

  const nativeDownloads = natives.map((native) => ({
    ...native,
    destination: path.join(paths.libraries, native.path),
  }));
  await mapPool(nativeDownloads, 6, async (native) => {
    check();
    if (native.url) {
      await downloadFile(native.url, native.destination, {
        size: native.size,
        sha1: native.sha1,
        isCancelled,
      });
    } else if (!(await exists(native.destination))) {
      throw new Error(
        `Не найдена локальная нативная библиотека ${native.path}. Переустановите версию.`,
      );
    }
    reporter.addFile(native.size || 0);
  });

  check();
  reporter.setStage('natives', 'Подготовка нативных библиотек…');
  await fsp.rm(nativesDir, { recursive: true, force: true });
  await fsp.mkdir(nativesDir, { recursive: true });
  for (const native of nativeDownloads) {
    try {
      extractNatives(native.destination, nativesDir, native.exclude);
    } catch (error) {
      reporter.setStage('natives', `Не удалось распаковать ${path.basename(native.destination)}`);
    }
  }

  // Assets.
  if (assetItems.length) {
    reporter.setStage('assets', 'Скачивание ресурсов игры…');
    await mapPool(assetItems, 24, async (item) => {
      check();
      const prefix = item.hash.slice(0, 2);
      const destination = path.join(paths.assets, 'objects', prefix, item.hash);
      await downloadFile(`${ASSET_BASE_URL}/${prefix}/${item.hash}`, destination, {
        size: item.size,
        isCancelled,
      });
      reporter.addFile(item.size);
    });

    if (assetsIndex?.virtual || assetsIndex?.map_to_resources) {
      reporter.setStage('assets', 'Индексация старых ресурсов…');
      const names = Object.entries(assetsIndex.objects);
      const targetRoot = assetsIndex.virtual
        ? path.join(paths.assets, 'virtual', meta.assetIndex.id)
        : path.join(paths.gameDir, 'resources');
      await mapPool(names, 16, async ([name, object]) => {
        const source = path.join(paths.assets, 'objects', object.hash.slice(0, 2), object.hash);
        const relative = name.split('/').filter(Boolean);
        if (!relative.length) return;
        const destination = path.join(targetRoot, ...relative);
        const sourceStat = await statSafe(source);
        const destinationStat = await statSafe(destination);
        if (sourceStat && destinationStat && sourceStat.size === destinationStat.size) return;
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await fsp.copyFile(source, destination);
      });
    }
  }

  check();
  const javaMajor = requiredJavaMajor(meta);
  record = {
    ...record,
    installedAt: new Date().toISOString(),
    javaMajor,
    type: meta.type,
    mainClass: meta.mainClass,
    assetIndex: meta.assetIndex?.id || null,
  };
  await writeJson(path.join(versionDir, 'installed.json'), record);
  await fsp.rm(installingMarker, { force: true }).catch(() => {});
  if (!internal) reporter.finish('Версия готова к запуску');
  return record;
}

function extractNatives(archive, destination, excludePrefixes = []) {
  const zip = new AdmZip(archive);
  const root = path.resolve(destination);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    if (!name || name.startsWith('META-INF/')) continue;
    if (excludePrefixes.some((prefix) => name.startsWith(prefix))) continue;
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }
}

async function listInstalled(gameDir) {
  const paths = getPaths(gameDir);
  const dirs = await fsp.readdir(paths.versions, { withFileTypes: true }).catch(() => []);
  const modsDir = path.join(paths.gameDir, 'mods');
  const mods = (await fsp.readdir(modsDir).catch(() => [])).filter((name) =>
    name.toLowerCase().endsWith('.jar'),
  ).length;

  const result = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const id = dir.name;
    const versionDir = path.join(paths.versions, id);
    const versionJson = path.join(versionDir, `${id}.json`);
    const marker = await readJson(path.join(versionDir, 'installed.json'), null);
    if (!(await exists(versionJson))) continue;
    // A .installing marker without a completion record means the previous
    // attempt was interrupted. Keep the files for resuming, but do not offer
    // the build for launch yet.
    if (!marker && (await exists(path.join(versionDir, '.installing')))) continue;

    const raw = await readJson(versionJson, null);
    if (!raw?.id) continue;
    const resolved = await resolveVersionMeta(id, gameDir).catch(() => raw);
    const loader = marker?.loader || detectLoaderType(raw, id);
    const inherited = Boolean(raw.inheritsFrom);
    if (!inherited && !(await exists(getClientJarPath(resolved, id, paths)))) continue;

    const stat = await statSafe(versionJson);
    const gameVersion =
      marker?.gameVersion || raw.inheritsFrom || resolved.clientJarId || resolved.id || id;
    const loaderVersion =
      marker?.loaderVersion ||
      (loader === 'forge'
        ? extractForgeVersion(raw, id, gameVersion)
        : loader === 'optifine'
          ? extractOptiFineVersion(raw, id)
          : null);
    const displayName =
      marker?.displayName ||
      (loader === 'forge'
        ? `Forge ${loaderVersion || ''} · ${gameVersion}`.replace('  ', ' ')
        : loader === 'optifine'
          ? `OptiFine ${loaderVersion || ''} · ${gameVersion}`.replace('  ', ' ')
          : loader === 'fabric'
            ? `Fabric · ${gameVersion}`
            : id);

    result.push({
      ...(marker || {}),
      id,
      loader,
      gameVersion,
      loaderVersion: loaderVersion || marker?.loaderVersion || null,
      displayName,
      type: marker?.type || raw.type || (loader === 'vanilla' ? 'release' : raw.type || 'release'),
      installedAt: marker?.installedAt || (stat ? stat.mtime.toISOString() : null),
      javaMajor: marker?.javaMajor || requiredJavaMajor(resolved),
      mods,
      inherited,
    });
  }

  return result.sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt)));
}

async function deleteVersion(versionId, gameDir) {
  if (!/^[A-Za-z0-9._+-]+$/.test(String(versionId))) {
    throw new Error('Некорректный идентификатор версии');
  }
  const paths = getPaths(gameDir);
  const target = path.join(paths.versions, versionId);
  await fsp.rm(target, { recursive: true, force: true });
  clearMetaCacheFor(versionId);
}

async function getVersionList(gameDir, force = false) {
  const manifest = await getManifest(force);
  const installed = await listInstalled(gameDir);
  return {
    latest: manifest.latest,
    versions: manifest.versions.map((version) => ({
      id: version.id,
      type: version.type,
      releaseTime: version.releaseTime,
      time: version.time,
    })),
    installed,
  };
}

async function getInstalledRecord(versionId, gameDir) {
  const installed = await listInstalled(gameDir);
  return installed.find((item) => item.id === versionId) || null;
}

async function readVersionMeta(versionId, gameDir) {
  const paths = getPaths(gameDir);
  const raw = await readJson(path.join(paths.versions, versionId, `${versionId}.json`), null);
  if (!raw) return null;
  return resolveVersionMeta(versionId, gameDir).catch(() => raw);
}

module.exports = {
  VERSION_MANIFEST_URL,
  rulesAllow,
  collectLibraries,
  getClasspath,
  getManifest,
  getVersionMeta,
  resolveVersionMeta,
  getClientJarPath,
  detectLoaderType,
  getFabricLoaders,
  getFabricProfile,
  getFabricInfoForVersion,
  getForgeBuilds,
  getOptiFineBuilds,
  installVersion,
  listInstalled,
  deleteVersion,
  getVersionList,
  getInstalledRecord,
  readVersionMeta,
  extractNatives,
  mavenRelativePath,
};
