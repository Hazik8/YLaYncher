'use strict';

const { fetchJson } = require('./http');

const NEWS_URL = 'https://launchercontent.mojang.com/v2/news.json';
const IMAGE_BASE = 'https://launchercontent.mojang.com';

let cache = { at: 0, data: [] };

async function getNews(force = false) {
  if (!force && cache.data.length && Date.now() - cache.at < 20 * 60 * 1000) {
    return cache.data;
  }

  try {
    const data = await fetchJson(NEWS_URL);
    const entries = (data.entries || [])
      .filter((entry) => {
        const types = entry.newsType || [];
        return types.includes('Java') || String(entry.category || '').includes('Java');
      })
      .slice(0, 8)
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        tag: entry.tag,
        category: entry.category,
        date: entry.date,
        text: entry.text,
        image: entry.playPageImage?.url ? IMAGE_BASE + entry.playPageImage.url : null,
        wideImage: entry.newsPageImage?.url ? IMAGE_BASE + entry.newsPageImage.url : null,
        link: entry.readMoreLink || 'https://www.minecraft.net/',
      }));

    cache = { at: Date.now(), data: entries };
    return entries;
  } catch {
    return cache.data;
  }
}

module.exports = { getNews };
