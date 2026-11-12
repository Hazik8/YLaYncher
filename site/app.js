/* ============================================================
   Y LaYncher — landing page logic
   Релизы берутся из GitHub Releases:
   1) сначала статический releases.json (его обновляет GitHub Actions);
   2) если файла нет — напрямую из GitHub API.
   ============================================================ */

(function () {
  'use strict';

  const cfg = window.YL_CONFIG || {};

  function detectRepoFromLocation() {
    const host = location.hostname.toLowerCase();
    if (!host.endsWith('.github.io')) return '';
    const owner = host.slice(0, -'.github.io'.length);
    const segments = location.pathname.split('/').filter(Boolean);
    if (!segments.length) return `${owner}/${owner}.github.io`;
    return `${owner}/${segments[0]}`;
  }

  let repo = String(cfg.repo || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.includes('YOUR_GITHUB_LOGIN')) {
    repo = detectRepoFromLocation() || repo;
  }
  const isConfigured = /^[\w.-]+\/[\w.-]+$/.test(repo) && !repo.includes('YOUR_GITHUB_LOGIN');
  const configuredRepoUrl = String(cfg.repoUrl || '');
  const repoUrl = isConfigured
    ? (configuredRepoUrl && !configuredRepoUrl.includes('YOUR_GITHUB_LOGIN')
      ? configuredRepoUrl
      : `https://github.com/${repo}`).replace(/\/$/, '')
    : '';
  const releasesUrl = repoUrl ? `${repoUrl}/releases` : '';
  const apiUrl = isConfigured ? `https://api.github.com/repos/${repo}/releases?per_page=30` : '';
  const feedUrl = cfg.releaseFeed || 'releases.json';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  let releases = [];

  /* ---------------- helpers ---------------- */

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(value) {
    const url = String(value || '');
    return /^https?:\/\//i.test(url) ? escapeHtml(url) : '#';
  }

  function formatBytes(bytes) {
    const size = Number(bytes) || 0;
    if (!size) return 'размер неизвестен';
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} КБ`;
    const mb = size / (1024 * 1024);
    return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1).replace('.', ',')} МБ`;
  }

  function formatDate(value, short) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'дата неизвестна';
    try {
      return new Intl.DateTimeFormat('ru-RU', short
        ? { day: '2-digit', month: 'short', year: 'numeric' }
        : { day: 'numeric', month: 'long', year: 'numeric' }
      ).format(date);
    } catch {
      return date.toLocaleDateString('ru-RU');
    }
  }

  function plural(number, one, few, many) {
    const n = Math.abs(Number(number) || 0) % 100;
    const n1 = n % 10;
    if (n > 10 && n < 20) return many;
    if (n1 > 1 && n1 < 5) return few;
    if (n1 === 1) return one;
    return many;
  }

  function detectPlatform(name) {
    const n = String(name || '').toLowerCase();
    if (/\.(exe|msi)$/.test(n) || /win(dows)?|setup/.test(n) && /\.(exe|msi|zip)$/.test(n)) return 'windows';
    if (/\.(dmg|pkg)$/.test(n) || /mac|darwin|osx/.test(n)) return 'macos';
    if (/\.(appimage|deb|rpm)$/.test(n) || /linux/.test(n)) return 'linux';
    return 'other';
  }

  function platformLabel(platform) {
    return {
      windows: 'Windows',
      macos: 'macOS',
      linux: 'Linux',
      other: 'Архив',
    }[platform] || 'Файл';
  }

  function downloadLabel(platform) {
    if (platform === 'windows') return 'Скачать для Windows';
    if (platform === 'macos') return 'Скачать для macOS';
    if (platform === 'linux') return 'Скачать для Linux';
    return 'Скачать архив';
  }

  function platformIcon(platform) {
    return {
      windows: 'i-windows',
      macos: 'i-apple',
      linux: 'i-linux',
    }[platform] || 'i-download';
  }

  function isInstaller(name) {
    const n = String(name || '').toLowerCase();
    if (!n || /\.(blockmap|yml|yaml|json|txt|sha256|sig|asc)$/.test(n)) return false;
    return /\.(exe|msi|dmg|pkg|appimage|deb|rpm|zip|7z|tar\.gz)$/.test(n);
  }

  function normalizeAsset(raw) {
    const name = String(raw.name || '');
    if (!isInstaller(name)) return null;
    const url = raw.browser_download_url || raw.url;
    if (!url) return null;
    const platform = raw.platform || detectPlatform(name);
    return {
      name,
      url,
      size: Number(raw.size) || 0,
      downloads: Number(raw.downloads != null ? raw.downloads : raw.download_count) || 0,
      platform,
    };
  }

  function normalizeRelease(raw) {
    if (!raw || raw.draft) return null;
    const assets = (Array.isArray(raw.assets) ? raw.assets : [])
      .map(normalizeAsset)
      .filter(Boolean);
    const tag = raw.tag || raw.tag_name || '';
    if (!tag) return null;
    return {
      tag,
      name: raw.name || tag,
      url: raw.html_url || raw.url || '',
      publishedAt: raw.publishedAt || raw.published_at || raw.created_at || '',
      prerelease: Boolean(raw.prerelease),
      body: String(raw.body || ''),
      assets,
      downloads: assets.reduce((sum, asset) => sum + asset.downloads, 0),
    };
  }

  function summaryFromBody(body) {
    let text = String(body || '');
    if (!text.trim()) return '';
    text = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/^[-*+]\s+/gm, '• ')
      .replace(/^(что нового|изменения|changelog|what'?s new)[:\s-]*/i, '')
      .replace(/[*_~`>]/g, '')
      .replace(/\r/g, '')
      .replace(/\n{2,}/g, ' ')
      .replace(/\n/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (text.length <= 240) return text;
    const cut = text.slice(0, 240);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 180)).trim()}…`;
  }

  function primaryAsset(release) {
    if (!release || !release.assets.length) return null;
    return (
      release.assets.find((asset) => asset.platform === 'windows' && /setup|install/i.test(asset.name)) ||
      release.assets.find((asset) => asset.platform === 'windows') ||
      release.assets[0]
    );
  }

  function latestRelease() {
    return releases.find((release) => !release.prerelease) || releases[0] || null;
  }

  function setRepoLinks() {
    $$('[data-repo-link]').forEach((link) => {
      if (repoUrl) {
        link.href = repoUrl;
        link.target = '_blank';
        link.rel = 'noopener';
      } else {
        link.href = '#download';
        link.removeAttribute('target');
        link.removeAttribute('rel');
      }
    });

    $$('[data-releases-link]').forEach((link) => {
      if (releasesUrl) {
        link.href = releasesUrl;
        link.target = '_blank';
        link.rel = 'noopener';
      } else {
        link.href = '#download';
        link.removeAttribute('target');
        link.removeAttribute('rel');
      }
    });
  }

  /* ---------------- hero ---------------- */

  function renderHero() {
    const latest = latestRelease();
    const asset = primaryAsset(latest);
    const versionEl = $('#hero-version');
    const sizeEl = $('#hero-size');
    const dateEl = $('#hero-date');
    const metaEl = $('#hero-download-meta');
    const heroBtn = $('#hero-download');
    const ctaBtn = $('#cta-download');

    if (versionEl) versionEl.textContent = latest ? latest.tag : cfg.fallbackVersion || 'v1.0.0';
    if (dateEl) dateEl.textContent = latest ? `обновлено ${formatDate(latest.publishedAt)}` : 'обновлено недавно';

    if (asset) {
      if (sizeEl) sizeEl.textContent = `${platformLabel(asset.platform)} · ${formatBytes(asset.size)}`;
      if (metaEl) metaEl.textContent = `${asset.name} · ${formatBytes(asset.size)}`;
      [heroBtn, ctaBtn].forEach((button) => {
        if (!button) return;
        button.href = asset.url;
        button.removeAttribute('target');
        button.removeAttribute('rel');
        button.setAttribute('download', asset.name);
      });
      const label = heroBtn && $('strong', heroBtn);
      if (label) label.textContent = downloadLabel(asset.platform);
      const ctaLabel = ctaBtn && $('strong', ctaBtn);
      if (ctaLabel) ctaLabel.textContent = 'Скачать Y LaYncher';
    } else {
      if (sizeEl) sizeEl.textContent = 'Windows · .exe';
      if (metaEl) metaEl.textContent = latest ? 'Открыть релиз' : 'Последний релиз';
      [heroBtn, ctaBtn].forEach((button) => {
        if (!button) return;
        button.href = releasesUrl || '#download';
        button.removeAttribute('download');
        if (releasesUrl) {
          button.target = '_blank';
          button.rel = 'noopener';
        }
      });
    }
  }

  /* ---------------- releases ---------------- */

  function skeletonMarkup() {
    return `
      <div class="latest-skeleton">
        <span class="sk sk-line-sm"></span>
        <span class="sk sk-line-lg"></span>
        <span class="sk sk-line"></span>
        <span class="sk sk-btn"></span>
      </div>`;
  }

  function setupMarkup() {
    return `
      <div class="latest-empty">
        <span class="empty-icon"><svg><use href="#i-github"/></svg></span>
        <h3>Подключите репозиторий</h3>
        <p>Укажите владельца и название репозитория в <code>site/config.js</code> — или опубликуйте сайт через GitHub Actions: конфигурация подставится автоматически.</p>
        <a class="btn btn-primary" href="https://github.com/new" target="_blank" rel="noopener">
          <svg><use href="#i-github"/></svg> Создать репозиторий
        </a>
      </div>`;
  }

  function emptyMarkup() {
    return `
      <div class="latest-empty">
        <span class="empty-icon"><svg><use href="#i-download"/></svg></span>
        <h3>Релизов пока нет</h3>
        <p>Соберите установщик командой <code>npm run dist</code> и прикрепите файл к релизу на GitHub — он появится здесь автоматически.</p>
        ${releasesUrl
          ? `<a class="btn btn-ghost" href="${safeUrl(releasesUrl)}" target="_blank" rel="noopener"><svg><use href="#i-github"/></svg> Открыть GitHub Releases</a>`
          : ''}
      </div>`;
  }

  function assetButton(asset) {
    return `
      <a class="asset-btn" href="${safeUrl(asset.url)}" target="_blank" rel="noopener" title="${escapeHtml(asset.name)}">
        <svg><use href="#${platformIcon(asset.platform)}"/></svg>
        ${escapeHtml(platformLabel(asset.platform))} · ${escapeHtml(formatBytes(asset.size))}
      </a>`;
  }

  function renderLatest() {
    const card = $('#latest-release');
    if (!card) return;
    card.setAttribute('aria-busy', 'false');

    const latest = latestRelease();
    if (!latest) {
      card.innerHTML = isConfigured ? emptyMarkup() : setupMarkup();
      return;
    }

    const asset = primaryAsset(latest);
    const summary = summaryFromBody(latest.body) ||
      'Свежая сборка Y LaYncher: установка версий, модлоадеры, аккаунт Microsoft и аккуратный интерфейс.';
    const otherAssets = latest.assets.filter((item) => item !== asset).slice(0, 4);
    const platforms = Array.from(new Set(latest.assets.map((item) => platformLabel(item.platform)))).join(' · ');
    const downloads = latest.downloads || latest.assets.reduce((sum, item) => sum + item.downloads, 0);

    card.innerHTML = `
      <div class="latest-inner">
        <div class="latest-main">
          <div class="latest-top">
            <span class="latest-tag${latest.prerelease ? ' pre' : ''}">${latest.prerelease ? 'Пробный релиз' : 'Последний релиз'}</span>
            <span class="latest-date">${escapeHtml(formatDate(latest.publishedAt))}</span>
          </div>
          <h3>Y LaYncher <span>${escapeHtml(latest.tag)}</span></h3>
          <p class="latest-summary">${escapeHtml(summary)}</p>
          <div class="latest-stats">
            <span><svg><use href="#i-download"/></svg> <b>${downloads.toLocaleString('ru-RU')}</b>&nbsp;${plural(downloads, 'скачивание', 'скачивания', 'скачиваний')}</span>
            <span><svg><use href="#i-cube"/></svg> <b>${latest.assets.length}</b>&nbsp;${plural(latest.assets.length, 'файл', 'файла', 'файлов')}</span>
            ${platforms ? `<span><svg><use href="#i-windows"/></svg> ${escapeHtml(platforms)}</span>` : ''}
          </div>
        </div>
        <div class="latest-actions">
          ${asset
            ? `<a class="btn btn-primary btn-lg" href="${safeUrl(asset.url)}" download="${escapeHtml(asset.name)}">
                 <svg><use href="#i-download"/></svg>
                 <span class="btn-stack">
                   <strong>${escapeHtml(downloadLabel(asset.platform))}</strong>
                   <small>${escapeHtml(asset.name)} · ${escapeHtml(formatBytes(asset.size))}</small>
                 </span>
               </a>`
            : `<a class="btn btn-ghost btn-lg" href="${safeUrl(latest.url)}" target="_blank" rel="noopener">
                 <svg><use href="#i-external"/></svg> Открыть релиз
               </a>`}
          ${latest.url ? `<a class="link-btn" href="${safeUrl(latest.url)}" target="_blank" rel="noopener">Страница релиза <svg><use href="#i-external"/></svg></a>` : ''}
          ${otherAssets.length ? `<div class="asset-row">${otherAssets.map(assetButton).join('')}</div>` : ''}
        </div>
      </div>`;
  }

  function renderReleaseList() {
    const list = $('#releases-list');
    if (!list) return;

    if (!releases.length) {
      list.innerHTML = `<div class="release-empty">${isConfigured
        ? 'Здесь появятся релизы, опубликованные в GitHub.'
        : 'Подключите GitHub-репозиторий, чтобы показывать релизы.'}</div>`;
      return;
    }

    const latest = latestRelease();
    list.innerHTML = releases.map((release) => {
      const isLatest = latest && release.tag === latest.tag;
      const badges = [
        isLatest ? '<span class="release-badge">latest</span>' : '',
        release.prerelease ? '<span class="release-badge pre">pre</span>' : '',
      ].join('');
      const assets = release.assets.slice(0, 3).map((asset) => `
        <a class="asset-btn" href="${safeUrl(asset.url)}" target="_blank" rel="noopener" title="${escapeHtml(asset.name)}">
          <svg><use href="#${platformIcon(asset.platform)}"/></svg>
          ${escapeHtml(platformLabel(asset.platform))}
        </a>`).join('');
      const releaseLink = release.url
        ? `<a class="asset-btn" href="${safeUrl(release.url)}" target="_blank" rel="noopener" title="Страница релиза на GitHub">
             <svg><use href="#i-external"/></svg> Релиз
           </a>`
        : '';
      return `
        <article class="release-item${isLatest ? ' is-latest' : ''}">
          <span class="release-dot" aria-hidden="true"></span>
          <div class="release-info">
            <span class="release-version">${escapeHtml(release.tag)}</span>
            ${badges}
            <span class="release-date" title="${escapeHtml(formatDate(release.publishedAt))}">${escapeHtml(formatDate(release.publishedAt, true))}</span>
          </div>
          <div class="release-assets">
            ${assets}
            ${releaseLink}
          </div>
        </article>`;
    }).join('');
  }

  function renderAll() {
    renderHero();
    renderLatest();
    renderReleaseList();
  }

  function setLoading() {
    const card = $('#latest-release');
    const list = $('#releases-list');
    if (card) {
      card.setAttribute('aria-busy', 'true');
      card.innerHTML = skeletonMarkup();
    }
    if (list) list.innerHTML = '<div class="release-loading">Загружаем релизы из GitHub…</div>';
  }

  /* ---------------- data loading ---------------- */

  async function loadLocalFeed(force) {
    try {
      const url = force ? `${feedUrl}?t=${Date.now()}` : feedUrl;
      const response = await fetch(url, { cache: force ? 'no-store' : 'default' });
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data.releases) ? data.releases.map(normalizeRelease).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  async function loadFromApi() {
    if (!apiUrl) return [];
    try {
      const response = await fetch(apiUrl, {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
      });
      if (!response.ok) {
        console.warn(`[Y LaYncher] GitHub API ответил ${response.status}`);
        return [];
      }
      const data = await response.json();
      return Array.isArray(data) ? data.map(normalizeRelease).filter(Boolean) : [];
    } catch (error) {
      console.warn('[Y LaYncher] Не удалось загрузить релизы из GitHub API:', error);
      return [];
    }
  }

  function sortReleases(items) {
    return items.sort((a, b) => {
      const dateA = new Date(a.publishedAt).getTime() || 0;
      const dateB = new Date(b.publishedAt).getTime() || 0;
      return dateB - dateA;
    });
  }

  async function loadReleases(force) {
    if (force) setLoading();

    let items = [];

    // Кнопка «Обновить» сначала спрашивает GitHub API, чтобы показать
    // релиз, который появился после последней сборки сайта.
    if (force && isConfigured) items = await loadFromApi();

    if (!items.length) items = await loadLocalFeed(force);

    if (!items.length && isConfigured && !force) items = await loadFromApi();

    releases = sortReleases(items);
    renderAll();
  }

  /* ---------------- UI behaviour ---------------- */

  function initHeader() {
    const header = $('.site-header');
    const onScroll = () => {
      if (header) header.classList.toggle('scrolled', window.scrollY > 8);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    const menuButton = $('#menu-btn');
    const nav = $('#nav');
    if (menuButton && nav) {
      const setOpen = (open) => {
        menuButton.setAttribute('aria-expanded', String(open));
        menuButton.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
        nav.classList.toggle('open', open);
      };
      menuButton.addEventListener('click', () => {
        setOpen(menuButton.getAttribute('aria-expanded') !== 'true');
      });
      nav.addEventListener('click', (event) => {
        if (event.target.closest('a')) setOpen(false);
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setOpen(false);
      });
      window.addEventListener('resize', () => {
        if (window.innerWidth > 940) setOpen(false);
      });
    }
  }

  function initReveal() {
    const targets = $$('.section-head, .feature-card, .step-card, .requirements, .faq, .latest-card, .cta-card');
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      targets.forEach((element) => element.classList.add('visible'));
      return;
    }
    targets.forEach((element) => element.classList.add('reveal'));
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    targets.forEach((element) => observer.observe(element));

    // Страховка: контент не должен остаться невидимым, если IntersectionObserver
    // не сработал (старый браузер, встроенный просмотрщик, печать страницы).
    window.setTimeout(() => {
      targets.forEach((element) => element.classList.add('visible'));
    }, 2200);
  }

  function init() {
    setRepoLinks();
    initHeader();
    initReveal();

    const year = $('#year');
    if (year) year.textContent = String(new Date().getFullYear());

    const refresh = $('#releases-refresh');
    if (refresh) {
      refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        try {
          await loadReleases(true);
        } finally {
          refresh.disabled = false;
        }
      });
    }

    loadReleases(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
