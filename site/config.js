/*
 * Настройки сайта.
 *
 * При публикации через GitHub Actions файл перезаписывается автоматически:
 * repo и siteUrl берутся из текущего репозитория. Вручную менять нужно только
 * при размещении на Cloudflare Pages / Netlify / обычном хостинге.
 */
window.YL_CONFIG = {
  repo: 'YOUR_GITHUB_LOGIN/YLaYncher',
  repoUrl: 'https://github.com/YOUR_GITHUB_LOGIN/YLaYncher',
  siteUrl: 'https://YOUR_GITHUB_LOGIN.github.io/YLaYncher/',
  fallbackVersion: 'v1.0.0',
  releaseFeed: 'releases.json',
};
