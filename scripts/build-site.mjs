#!/usr/bin/env node
/*
 * Собирает данные для сайта:
 *  - site/releases.json — релизы GitHub в компактном виде;
 *  - site/config.js — репозиторий и адрес сайта.
 *
 * Запускается в GitHub Actions и локально:
 *   node scripts/build-site.mjs
 *   node scripts/build-site.mjs --repo=owner/name
 *
 * Без GITHUB_TOKEN работает, но GitHub API может ограничить частоту запросов.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = path.join(root, 'site');
const feedFile = path.join(siteDir, 'releases.json');
const configFile = path.join(siteDir, 'config.js');

const repoArg = process.argv.find((arg) => arg.startsWith('--repo='))?.slice('--repo='.length);
const repo = String(repoArg || process.env.GITHUB_REPOSITORY || '').trim();
const hasRepo = /^[\w.-]+\/[\w.-]+$/.test(repo);
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

function deriveSiteUrl(repository) {
  const [owner, name] = repository.split('/');
  if (!owner || !name) return '';
  if (name.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
    return `https://${owner.toLowerCase()}.github.io/`;
  }
  return `https://${owner.toLowerCase()}.github.io/${name}/`;
}

function isInstaller(name) {
  const n = String(name || '').toLowerCase();
  if (!n || /\.(blockmap|yml|yaml|json|txt|sha256|sig|asc)$/.test(n)) return false;
  return /\.(exe|msi|dmg|pkg|appimage|deb|rpm|zip|7z|tar\.gz)$/.test(n);
}

function detectPlatform(name) {
  const n = String(name || '').toLowerCase();
  if (/\.(exe|msi)$/.test(n)) return 'windows';
  if (/\.(dmg|pkg)$/.test(n)) return 'macos';
  if (/\.(appimage|deb|rpm)$/.test(n)) return 'linux';
  if (/win(dows)?|setup/.test(n) && /\.zip$/.test(n)) return 'windows';
  if (/mac|darwin|osx/.test(n) && /\.zip$/.test(n)) return 'macos';
  if (/linux/.test(n) && /\.zip$/.test(n)) return 'linux';
  return 'other';
}

function normalizeRelease(raw) {
  if (!raw || raw.draft) return null;
  const assets = (Array.isArray(raw.assets) ? raw.assets : [])
    .filter((asset) => isInstaller(asset.name))
    .map((asset) => ({
      name: String(asset.name || ''),
      url: asset.browser_download_url,
      size: Number(asset.size) || 0,
      downloads: Number(asset.download_count) || 0,
      platform: detectPlatform(asset.name),
    }))
    .filter((asset) => /^https?:\/\//i.test(asset.url || ''));

  const tag = String(raw.tag_name || raw.tag || '').trim();
  if (!tag) return null;

  return {
    tag,
    name: String(raw.name || tag),
    url: String(raw.html_url || raw.url || ''),
    publishedAt: raw.published_at || raw.publishedAt || raw.created_at || '',
    prerelease: Boolean(raw.prerelease),
    body: String(raw.body || '').slice(0, 8000),
    assets,
    downloads: assets.reduce((sum, asset) => sum + asset.downloads, 0),
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readPackageVersion() {
  const pkg = await readJson(path.join(root, 'package.json'));
  return pkg?.version ? `v${pkg.version}` : 'v1.0.0';
}

async function fetchReleases() {
  if (!hasRepo) {
    console.warn('[site] Репозиторий не указан. Оставляю текущий releases.json без изменений.');
    return null;
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'y-layncher-site-builder',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `https://api.github.com/repos/${repo}/releases?per_page=30`;
  console.log(`[site] Загружаю релизы: ${repo}`);

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`GitHub API ответил ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Неожиданный ответ GitHub API');
    return data
      .map(normalizeRelease)
      .filter(Boolean)
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  } catch (error) {
    console.warn(`[site] Не удалось обновить релизы: ${error.message}`);
    return null;
  }
}

async function writeFeed(releases) {
  const previous = await readJson(feedFile);
  const feed = {
    generatedAt: new Date().toISOString(),
    repo: hasRepo ? repo : previous?.repo || '',
    releases,
  };
  await fs.writeFile(feedFile, `${JSON.stringify(feed, null, 2)}\n`, 'utf8');
  console.log(`[site] releases.json: ${releases.length} релиз(ов)`);
}

async function writeConfig() {
  if (!hasRepo) {
    console.log('[site] config.js не изменён: репозиторий не указан.');
    return;
  }
  const siteUrl = String(process.env.YL_SITE_URL || deriveSiteUrl(repo)).replace(/\/?$/, '/');
  const fallbackVersion = await readPackageVersion();
  const content = `/*
 * Файл сгенерирован scripts/build-site.mjs.
 * Не редактируйте вручную при публикации через GitHub Actions.
 */
window.YL_CONFIG = ${JSON.stringify({
    repo,
    repoUrl: `https://github.com/${repo}`,
    siteUrl,
    fallbackVersion,
    releaseFeed: 'releases.json',
  }, null, 2)};
`;
  await fs.writeFile(configFile, content, 'utf8');
  console.log(`[site] config.js: ${repo} → ${siteUrl}`);
}

async function main() {
  await fs.mkdir(siteDir, { recursive: true });

  const fetched = await fetchReleases();
  if (fetched) {
    await writeFeed(fetched);
  } else {
    const existing = await readJson(feedFile);
    if (!existing || !Array.isArray(existing.releases)) {
      await writeFeed([]);
    } else {
      console.log('[site] Оставляю существующий releases.json.');
    }
  }

  await writeConfig();
}

main().catch((error) => {
  console.error('[site] Ошибка сборки:', error);
  process.exitCode = 1;
});
