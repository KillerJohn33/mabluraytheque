import { parseEdition } from './bluray-edition.js';

// Recherche automatique de la fiche Blu-ray.com d'une édition.
// - mode code  : recherche par code-barres ; seule une fiche qui contient ce code est retenue.
// - mode title : recherche par titre parmi les éditions françaises ; la fiche doit citer l'année du film.
const SITE = 'https://www.blu-ray.com';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; MaBluraytheque/1.0)', Accept: 'text/html' };

export const config = { maxDuration: 20 };

const rateBuckets = new Map();
function allowRequest(req, limit = 30, windowMs = 60000) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const current = rateBuckets.get(ip);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

async function fetchHtml(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: HEADERS });
    if (!response.ok) return '';
    return new TextDecoder('iso-8859-1').decode(await response.arrayBuffer());
  } catch (_) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// Liens de fiches d'édition présents dans une page de résultats.
function editionLinks(html) {
  const links = new Set();
  const pattern = /href="((?:https?:\/\/www\.blu-ray\.com)?\/movies\/[A-Za-z0-9%-]+\/\d+\/?)"/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const path = match[1].replace(/^https?:\/\/www\.blu-ray\.com/i, '');
    links.add(`${SITE}${path.endsWith('/') ? path : path + '/'}`);
  }
  return [...links];
}

function searchUrl(keyword, country) {
  const params = new URLSearchParams({ quicksearch: '1', quicksearch_country: country, quicksearch_keyword: keyword, section: 'bluraymovies' });
  return `${SITE}/search/?${params}`;
}

async function loadEdition(url) {
  const html = await fetchHtml(url);
  if (!html) return null;
  const id = url.match(/\/(\d+)\/$/)?.[1] || '';
  const edition = parseEdition(html, url, id);
  return edition ? { edition, html } : null;
}

function barcodeVariants(code) {
  const digits = String(code || '').replace(/\D/g, '');
  const variants = new Set([digits]);
  if (digits.length === 13 && digits.startsWith('0')) variants.add(digits.slice(1));
  if (digits.length === 12) variants.add('0' + digits);
  return [...variants].filter(v => v.length >= 8);
}

async function searchByCode(code) {
  const variants = barcodeVariants(code);
  if (!variants.length) return null;
  const links = editionLinks(await fetchHtml(searchUrl(variants[0], 'all'))).slice(0, 4);
  const pages = await Promise.all(links.map(loadEdition));
  const found = pages.find(page => page && variants.some(v => page.html.includes(v)));
  return found ? { ...found.edition, match: 'barcode' } : null;
}

const normalize = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function searchByTitle(titles, year, wants4k) {
  for (const title of titles) {
    const links = editionLinks(await fetchHtml(searchUrl(title, 'FR')));
    if (!links.length) continue;
    // Préférer le format demandé (4K ou Blu-ray classique) d'après l'adresse de la fiche.
    const ranked = links.slice(0, 8).sort((a, b) => Number(/4k/i.test(b) === wants4k) - Number(/4k/i.test(a) === wants4k)).slice(0, 3);
    const pages = await Promise.all(ranked.map(loadEdition));
    const words = normalize(title).split(' ').filter(w => w.length > 2);
    const found = pages.find(page => {
      if (!page) return false;
      if (year && !page.html.includes(String(year))) return false;
      const pageTitle = normalize(page.edition.title);
      return !words.length || words.every(w => pageTitle.includes(w));
    });
    if (found) return { ...found.edition, match: 'title' };
  }
  return null;
}

export default async function handler(req, res) {
  if (!allowRequest(req)) { res.setHeader('Cache-Control', 'no-store'); return res.status(429).json({ error: 'Trop de requêtes. Réessayez dans une minute.' }); }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const mode = String(req.query.mode || 'code');
  try {
    let edition = null;
    if (mode === 'code') {
      const code = String(req.query.code || '').replace(/\D/g, '');
      if (!/^\d{8,14}$/.test(code)) return res.status(400).json({ error: 'Invalid barcode' });
      edition = await searchByCode(code);
    } else if (mode === 'title') {
      const titles = [req.query.title, req.query.originalTitle].map(t => String(t || '').trim().slice(0, 120)).filter(Boolean);
      const unique = [...new Set(titles)];
      if (!unique.length) return res.status(400).json({ error: 'Missing title' });
      const year = /^\d{4}$/.test(String(req.query.year || '')) ? String(req.query.year) : '';
      edition = await searchByTitle(unique, year, String(req.query.format || '') === '4k');
    } else {
      return res.status(400).json({ error: 'Invalid mode' });
    }
    if (!edition) { res.setHeader('Cache-Control', 's-maxage=21600'); return res.status(200).json({ found: false }); }
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({ found: true, ...edition });
  } catch (_) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'Blu-ray.com unavailable' });
  }
}
