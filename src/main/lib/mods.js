'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');
const { fetchJson, downloadFile, statSafe } = require('./http');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const CURSEFORGE_API = 'https://api.curseforge.com/v1';
const CURSEFORGE_GAME_ID = 432; // Minecraft
const CURSEFORGE_CLASS_MODS = 6;
const CURSEFORGE_CDN = 'https://mediafilez.forgecdn.net/files';

const LOADERS = {
  fabric: { modrinth: 'fabric', curseforge: 4, label: 'Fabric' },
  forge: { modrinth: 'forge', curseforge: 1, label: 'Forge' },
  neoforge: { modrinth: 'neoforge', curseforge: 6, label: 'NeoForge' },
  quilt: { modrinth: 'quilt', curseforge: 5, label: 'Quilt' },
};

const MODRINTH_SORTS = {
  relevance: 'relevance',
  downloads: 'downloads',
  follows: 'follows',
  newest: 'newest',
  updated: 'updated',
};

const CURSEFORGE_SORTS = {
  relevance: 2,
  downloads: 6,
  newest: 3,
  updated: 3,
};

function normalizeLoader(loader) {
  const key = String(loader || '').trim().toLowerCase();
  return LOADERS[key] ? key : '';
}

function modsDirOf(gameDir) {
  return path.join(gameDir, 'mods');
}

function friendlyError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

/* --------------------------------------------------------------- Modrinth */

async function searchModrinth({ query = '', gameVersion = '', loader = '', offset = 0, limit = 20, sort = 'relevance' } = {}) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const facets = [['project_type:mod']];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  const loaderKey = normalizeLoader(loader);
  if (loaderKey) facets.push([`categories:${LOADERS[loaderKey].modrinth}`]);

  const params = new URLSearchParams({
    limit: String(safeLimit),
    offset: String(safeOffset),
    query: String(query || '').trim(),
    index: MODRINTH_SORTS[sort] || MODRINTH_SORTS.relevance,
    facets: JSON.stringify(facets),
  });

  const data = await fetchJson(`${MODRINTH_API}/search?${params.toString()}`);
  const hits = Array.isArray(data?.hits) ? data.hits : [];
  return {
    source: 'modrinth',
    total: Number(data?.total_hits || hits.length),
    offset: safeOffset,
    limit: safeLimit,
    mods: hits.map((hit) => ({
      source: 'modrinth',
      id: String(hit.project_id || hit.slug || ''),
      slug: String(hit.slug || ''),
      title: String(hit.title || hit.slug || 'Без названия'),
      author: String(hit.author || ''),
      description: String(hit.description || ''),
      icon: String(hit.icon_url || ''),
      downloads: Number(hit.downloads || 0),
      follows: Number(hit.follows || 0),
      categories: Array.isArray(hit.display_categories)
        ? hit.display_categories
        : Array.isArray(hit.categories)
          ? hit.categories
          : [],
      versions: Array.isArray(hit.versions) ? hit.versions : [],
      url: hit.slug ? `https://modrinth.com/mod/${hit.slug}` : 'https://modrinth.com/mods',
      installable: true,
    })),
  };
}

async function installModrinthMod({ projectId, gameVersion = '', loader = '', gameDir, isCancelled } = {}) {
  if (!projectId) throw friendlyError('Не выбран мод для установки', 'MOD_NOT_SELECTED');
  const params = new URLSearchParams();
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
  const loaderKey = normalizeLoader(loader);
  if (loaderKey) params.set('loaders', JSON.stringify([LOADERS[loaderKey].modrinth]));

  const versions = await fetchJson(
    `${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?${params.toString()}`,
    { isCancelled },
  );
  if (!Array.isArray(versions) || !versions.length) {
    throw friendlyError(
      `У мода нет версии для Minecraft ${gameVersion || '—'}${loaderKey ? ` · ${LOADERS[loaderKey].label}` : ''}.`,
      'NO_COMPATIBLE_VERSION',
    );
  }

  const version = versions.find((item) => item.version_type === 'release') || versions[0];
  const file =
    (Array.isArray(version.files) ? version.files : []).find((item) => item.primary) ||
    (Array.isArray(version.files) ? version.files[0] : null);
  if (!file) throw friendlyError('У выбранной версии мода нет файла для скачивания', 'NO_FILE');

  const modsDir = modsDirOf(gameDir);
  await fsp.mkdir(modsDir, { recursive: true });
  const destination = path.join(modsDir, path.basename(file.filename));
  const result = await downloadFile(file.url, destination, {
    size: file.size,
    sha1: file.hashes?.sha1,
    verifyExisting: true,
    isCancelled,
  });

  return {
    source: 'modrinth',
    file: file.filename,
    version: version.version_number || '',
    displayName: version.name || file.filename,
    bytes: result.bytes,
    skipped: Boolean(result.skipped),
    path: destination,
  };
}

/* -------------------------------------------------------------- CurseForge */

function curseForgeHeaders(apiKey) {
  return { 'x-api-key': String(apiKey || '').trim(), Accept: 'application/json' };
}

function curseForgeFileUrl(file) {
  if (file?.downloadUrl) return file.downloadUrl;
  const id = Number(file?.id);
  if (!Number.isFinite(id) || !file?.fileName) return '';
  return `${CURSEFORGE_CDN}/${Math.floor(id / 1000)}/${id % 1000}/${encodeURIComponent(file.fileName)}`;
}

async function searchCurseForge({
  query = '',
  gameVersion = '',
  loader = '',
  apiKey = '',
  offset = 0,
  limit = 20,
  sort = 'relevance',
} = {}) {
  if (!apiKey) {
    throw friendlyError(
      'Для CurseForge нужен бесплатный API-ключ. Получите его в консоли CurseForge и вставьте в лаунчер.',
      'CURSEFORGE_KEY_REQUIRED',
    );
  }

  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const params = new URLSearchParams({
    gameId: String(CURSEFORGE_GAME_ID),
    classId: String(CURSEFORGE_CLASS_MODS),
    index: String(safeOffset),
    pageSize: String(safeLimit),
    sortField: String(CURSEFORGE_SORTS[sort] || CURSEFORGE_SORTS.relevance),
    sortOrder: 'desc',
  });
  if (query) params.set('searchFilter', String(query).trim());
  if (gameVersion) params.set('gameVersion', String(gameVersion));
  const loaderKey = normalizeLoader(loader);
  if (loaderKey) params.set('modLoaderType', String(LOADERS[loaderKey].curseforge));

  let data;
  try {
    data = await fetchJson(`${CURSEFORGE_API}/mods/search?${params.toString()}`, {
      headers: curseForgeHeaders(apiKey),
    });
  } catch (error) {
    if (error?.status === 403 || error?.status === 401) {
      throw friendlyError('CurseForge отклонил API-ключ. Проверьте его в консоли CurseForge.', 'CURSEFORGE_KEY_INVALID');
    }
    throw error;
  }

  const mods = Array.isArray(data?.data) ? data.data : [];
  return {
    source: 'curseforge',
    total: Number(data?.pagination?.totalCount || mods.length),
    offset: safeOffset,
    limit: safeLimit,
    mods: mods.map((mod) => ({
      source: 'curseforge',
      id: String(mod.id || ''),
      slug: String(mod.slug || ''),
      title: String(mod.name || mod.slug || 'Без названия'),
      author: String(mod.authors?.[0]?.name || ''),
      description: String(mod.summary || ''),
      icon: String(mod.logo?.thumbnailUrl || mod.logo?.url || ''),
      downloads: Number(mod.downloadCount || 0),
      follows: Number(mod.thumbsUpCount || 0),
      categories: (Array.isArray(mod.categories) ? mod.categories : []).map((item) => item.name).filter(Boolean),
      versions: (Array.isArray(mod.latestFilesIndexes) ? mod.latestFilesIndexes : [])
        .map((item) => item.gameVersion)
        .filter(Boolean),
      url: mod.links?.websiteUrl || (mod.slug ? `https://www.curseforge.com/minecraft/mc-mods/${mod.slug}` : ''),
      installable: mod.allowModDistribution !== false,
    })),
  };
}

async function installCurseForgeMod({ projectId, gameVersion = '', loader = '', apiKey = '', gameDir, isCancelled } = {}) {
  if (!apiKey) {
    throw friendlyError('Для установки из CurseForge нужен API-ключ.', 'CURSEFORGE_KEY_REQUIRED');
  }
  if (!projectId) throw friendlyError('Не выбран мод для установки', 'MOD_NOT_SELECTED');

  const params = new URLSearchParams({ pageSize: '50' });
  if (gameVersion) params.set('gameVersion', String(gameVersion));
  const loaderKey = normalizeLoader(loader);
  if (loaderKey) params.set('modLoaderType', String(LOADERS[loaderKey].curseforge));

  let data;
  try {
    data = await fetchJson(`${CURSEFORGE_API}/mods/${encodeURIComponent(projectId)}/files?${params.toString()}`, {
      headers: curseForgeHeaders(apiKey),
      isCancelled,
    });
  } catch (error) {
    if (error?.status === 403 || error?.status === 401) {
      throw friendlyError('CurseForge отклонил API-ключ. Проверьте его в консоли CurseForge.', 'CURSEFORGE_KEY_INVALID');
    }
    throw error;
  }

  const files = (Array.isArray(data?.data) ? data.data : []).filter((file) => file?.fileName);
  if (!files.length) {
    throw friendlyError(
      `У мода нет файла для Minecraft ${gameVersion || '—'}${loaderKey ? ` · ${LOADERS[loaderKey].label}` : ''}.`,
      'NO_COMPATIBLE_VERSION',
    );
  }

  const release = files.filter((file) => file.releaseType === 1);
  const pool = release.length ? release : files;
  pool.sort((a, b) => new Date(b.fileDate || 0).getTime() - new Date(a.fileDate || 0).getTime());
  const file = pool[0];
  const url = curseForgeFileUrl(file);
  if (!url) throw friendlyError('CurseForge не выдал ссылку на файл мода', 'NO_FILE');

  const sha1 = (Array.isArray(file.hashes) ? file.hashes : []).find((hash) => hash.algo === 1)?.value;
  const modsDir = modsDirOf(gameDir);
  await fsp.mkdir(modsDir, { recursive: true });
  const destination = path.join(modsDir, path.basename(file.fileName));
  const result = await downloadFile(url, destination, {
    size: Number(file.fileLength) || null,
    sha1,
    verifyExisting: true,
    isCancelled,
  });

  return {
    source: 'curseforge',
    file: file.fileName,
    version: file.displayName || '',
    displayName: file.displayName || file.fileName,
    bytes: result.bytes,
    skipped: Boolean(result.skipped),
    path: destination,
  };
}

/* ----------------------------------------------------------- installed mods */

function readJarMeta(file) {
  try {
    const zip = new AdmZip(file);
    const fabricEntry = zip.getEntry('fabric.mod.json');
    if (fabricEntry) {
      const data = JSON.parse(zip.readAsText(fabricEntry));
      return {
        name: String(data.name || data.id || ''),
        version: String(data.version || ''),
        loader: 'fabric',
      };
    }
    const quiltEntry = zip.getEntry('quilt.mod.json');
    if (quiltEntry) {
      const data = JSON.parse(zip.readAsText(quiltEntry));
      return {
        name: String(data.quilt_loader?.metadata?.name || data.quilt_loader?.id || ''),
        version: String(data.quilt_loader?.version || ''),
        loader: 'quilt',
      };
    }
    const tomlEntry = zip.getEntry('META-INF/mods.toml') || zip.getEntry('META-INF/neoforge.mods.toml');
    if (tomlEntry) {
      const text = zip.readAsText(tomlEntry);
      const name = /displayName\s*=\s*"([^"]+)"/.exec(text)?.[1] || /modId\s*=\s*"([^"]+)"/.exec(text)?.[1] || '';
      const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(text)?.[1] || '';
      return { name, version, loader: tomlEntry.entryName.includes('neoforge') ? 'neoforge' : 'forge' };
    }
    const mcmodEntry = zip.getEntry('mcmod.info');
    if (mcmodEntry) {
      const text = zip.readAsText(mcmodEntry);
      const data = JSON.parse(text);
      const first = Array.isArray(data) ? data[0] : data?.modList?.[0];
      if (first) return { name: String(first.name || first.modid || ''), version: String(first.version || ''), loader: 'forge' };
    }
  } catch {
    // Broken or obfuscated jar — filename is enough.
  }
  return { name: '', version: '', loader: '' };
}

async function listInstalledMods(gameDir) {
  const modsDir = modsDirOf(gameDir);
  await fsp.mkdir(modsDir, { recursive: true });
  let entries = [];
  try {
    entries = await fsp.readdir(modsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const result = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const isEnabled = /\.jar$/i.test(entry.name);
    const isDisabled = /\.jar\.disabled$/i.test(entry.name);
    if (!isEnabled && !isDisabled) continue;

    const full = path.join(modsDir, entry.name);
    const info = await statSafe(full);
    const baseName = isDisabled ? entry.name.replace(/\.disabled$/i, '') : entry.name;
    const meta = readJarMeta(full);
    result.push({
      fileName: entry.name,
      baseName,
      enabled: isEnabled,
      size: info?.size || 0,
      modifiedAt: info?.mtime ? info.mtime.toISOString() : '',
      name: meta.name || baseName.replace(/\.jar$/i, ''),
      version: meta.version || '',
      loader: meta.loader || '',
    });
  }

  result.sort((a, b) => a.baseName.localeCompare(b.baseName, 'ru'));
  return result;
}

function assertPlainFileName(fileName) {
  const value = String(fileName || '');
  if (!value || value !== path.basename(value) || value.includes('..')) {
    throw friendlyError('Некорректное имя файла мода', 'BAD_FILE_NAME');
  }
  if (!/\.jar(\.disabled)?$/i.test(value)) {
    throw friendlyError('Это не файл мода (.jar)', 'BAD_FILE_NAME');
  }
  return value;
}

async function deleteInstalledMod(gameDir, fileName) {
  const safe = assertPlainFileName(fileName);
  const full = path.join(modsDirOf(gameDir), safe);
  await fsp.rm(full, { force: true });
  return listInstalledMods(gameDir);
}

async function setModEnabled(gameDir, fileName, enabled) {
  const safe = assertPlainFileName(fileName);
  const modsDir = modsDirOf(gameDir);
  const full = path.join(modsDir, safe);
  const isDisabled = /\.disabled$/i.test(safe);
  const base = isDisabled ? safe.replace(/\.disabled$/i, '') : safe;

  if (enabled === isDisabled) {
    const target = path.join(modsDir, enabled ? base : `${base}.disabled`);
    try {
      await fsp.rename(full, target);
    } catch (error) {
      if (error?.code === 'ENOENT') throw friendlyError('Файл мода не найден — обновите список', 'MOD_NOT_FOUND');
      throw error;
    }
  }
  return listInstalledMods(gameDir);
}

module.exports = {
  LOADERS,
  modsDirOf,
  searchModrinth,
  installModrinthMod,
  searchCurseForge,
  installCurseForgeMod,
  listInstalledMods,
  deleteInstalledMod,
  setModEnabled,
  readJarMeta,
};
