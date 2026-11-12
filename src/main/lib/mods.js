'use strict';

const path = require('path');
const { fetchJson, downloadFile } = require('./http');

const MODRINCH_API = 'https://api.modrinth.com/v2';

async function searchModrinth({ query, gameVersion, loader, limit = 20 }) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const params = new URLSearchParams({
    limit: String(safeLimit),
    query: String(query || ''),
  });
  const facets = [];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (facets.length) params.set('facets', JSON.stringify(facets));

  const data = await fetchJson(`${MODRINCH_API}/search?${params.toString()}`);
  const hits = Array.isArray(data?.hits) ? data.hits : [];
  const mods = hits.map((hit) => ({
    projectId: String(hit.projectId || hit.slug || ''),
    slug: String(hit.slug || ''),
    title: String(hit.title || hit.name || hit.slug || ''),
    author: String(hit.author || hit.user || hit?.authors?.[0]?.name || ''),
    downloads: Number(hit.downloads || 0),
    description: String(hit.description || ''),
    versions: Array.isArray(hit.versions) ? hit.versions : [],
    loaders: Array.isArray(hit.loaders) ? hit.loaders : [],
    url: String(hit.url || ''),
  }));

  const filtered = loader ? mods.filter((mod) => !mod.loaders.length || mod.loaders.includes(loader)) : mods;
  return { mods: filtered, total: Number(data?.total || mods.length) };
}

async function installModrinthMod({ projectId, gameVersion, loader, modsDir, isCancelled }) {
  const data = await fetchJson(`${MODRINCH_API}/project/${encodeURIComponent(projectId)}/versions`);
  const versions = Array.isArray(data) ? data : [];
  const wantedLoader = String(loader || '');
  const wantedVersion = String(gameVersion || '');
  const version =
    versions.find((item) => {
      const itemLoaders = Array.isArray(item.loaders) ? item.loaders : [];
      const loaderOk = !wantedLoader || itemLoaders.includes(wantedLoader);
      const versionNumber = String(item.version_number || '');
      const versionOk = !wantedVersion || versionNumber === wantedVersion || versionNumber.startsWith(wantedVersion);
      return loaderOk && versionOk;
    }) || versions[0];

  const file = version?.files?.[0];
  if (!file) throw new Error('Для этого мода нет подходящей версии для установки.');

  const destination = path.join(modsDir, file.filename);
  const result = await downloadFile(file.url, destination, {
    size: file.size,
    sha1: file.hashes?.sha1,
    verifyExisting: true,
    isCancelled,
  });

  return { ok: true, projectId, file: file.filename, version: version?.version_number, ...result };
}

module.exports = { searchModrinth, installModrinthMod };
