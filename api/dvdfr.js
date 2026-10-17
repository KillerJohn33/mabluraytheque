// Recherche d'une édition sur DVDFr.com (base française des DVD, Blu-ray et 4K).
// - mode code  : recherche par code-barres ; seule la fiche portant ce code est retenue.
// - mode title : recherche par titre ; première édition du format demandé dont le titre et l'année concordent.
// La fonction s'exécute à Paris (voir vercel.json) : DVDFr refuse les requêtes venant des États-Unis.
const SITE = 'https://www.dvdfr.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
};

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

async function fetchHtml(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: HEADERS });
    if (response.status === 403 || response.status === 429) throw new Error(`DVDFr HTTP ${response.status}`);
    if (!response.ok) return '';
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function decode(value = '') {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&euro;/gi, '€')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

const normalize = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// « 4K Ultra HD », « Blu-ray », « DVD »… vers les formats de l'application.
function appFormat(support = '') {
  if (/4k|uhd/i.test(support)) return '4K UHD';
  if (/blu[ -]?ray/i.test(support)) return 'Blu-ray 1080p';
  if (/dvd/i.test(support)) return 'DVD';
  return '';
}

// Valeur d'une ligne « libellé / info » du bloc « Détails produits ».
function info(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<p class="libelle">\\s*${escaped}\\s*</p>\\s*<p class="info">([\\s\\S]*?)</p>`, 'i'));
  return match ? decode(match[1]) : '';
}

function parseProduct(source, url) {
  // Espaces normalisés : le HTML servi contient des doubles espaces dans certaines balises.
  const html = String(source).replace(/\s+/g, ' ').replace(/ >/g, '>');
  const ean = (html.match(/"isbn"\s*:\s*"(\d{8,14})"/) || [])[1] || info(html, 'EAN').replace(/\D/g, '');
  const h1 = (html.match(/<h1 class="titre[^"]*">([\s\S]*?)<\/h1>/i) || [])[1] || '';
  const year = (h1.match(/<span class="commentLangue">\s*\((\d{4})\)\s*<\/span>/i) || [])[1] || '';
  const title = decode(h1.replace(/<span class="commentLangue">[\s\S]*?<\/span>/i, ''));
  const image = (html.match(/<meta property="og:image" content="(https:\/\/images\.epagine\.fr\/[^"?]+)"/i) || [])[1] || '';
  const backImage = image && html.includes(image.replace(/_1\.jpg$/i, '_2.jpg')) ? image.replace(/_1\.jpg$/i, '_2.jpg') : '';
  const support = info(html, 'Support principal');
  const supportLine = decode((html.match(/<li class="hidden-xs">\s*([^<]*(?:4K|Blu-ray|DVD)[^<]*)<\/li>/i) || [])[1] || '');
  const blocks = [...html.matchAll(/<div class="text-truncate-2 text-short-content">([\s\S]*?)<\/div>/gi)].map(m => decode(m[1]));
  const subtitlesBlock = blocks.find(b => /^Sous-titres\s*:/i.test(b)) || '';
  const audioBlock = blocks.find(b => /dolby|dts|pcm|mono|st[ée]r[ée]o|mpeg|aac/i.test(b) && !/^Sous-titres/i.test(b)) || '';
  const videoLine = decode((html.match(/<span>Couleurs?[\s\S]{0,40}?<\/span>([\s\S]{0,400}?)<\/div>/i) || [])[0] || '');
  const codec = (videoLine.match(/\b(HEVC|AVC|MPEG-?2|VC-?1|H\.?26[45])\b/i) || [])[1] || '';
  const duration = Number((html.match(/Durée\s*:\s*(\d{1,3})\s*mn/i) || [])[1] || 0);
  const discs = Number(info(html, 'Nombre de disques').replace(/\D/g, '')) || 0;
  if (!title || !ean) return null;
  return {
    url,
    ean,
    title,
    year,
    image,
    backImage,
    publisher: info(html, 'Éditeur'),
    releaseDate: info(html, 'Date de parution'),
    support: supportLine || support,
    format: appFormat(support || supportLine),
    discs,
    zone: info(html, 'Zone'),
    duration,
    videoCodec: codec.toUpperCase(),
    audioTracks: audioBlock ? audioBlock.split(/,\s*/).map(v => v.trim()).filter(Boolean) : [],
    subtitles: subtitlesBlock ? subtitlesBlock.replace(/^Sous-titres\s*:\s*/i, '').split(/,\s*/).map(v => v.trim()).filter(Boolean) : [],
    steelbook: /steelbook/i.test(`${title} ${supportLine} ${(html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || ''}`),
    source: SITE
  };
}

function searchUrl(keywords) {
  const params = new URLSearchParams({ base: 'dvd', mots_recherche: keywords, form_recherche_avancee: 'ok' });
  return `${SITE}/listeliv.php?${params}`;
}

const PRODUCT_LINK = '(?:https:\\/\\/www\\.dvdfr\\.com)?(\\/dvd\\/(\\d{8,14})-[a-z0-9-]+\\/)';

// Lignes « autres éditions » (format seulement), présentes dans la page rendue
// ou renvoyées par detail_autres_editions_liste.php.
function parseOtherEditions(html, title, year) {
  const pattern = new RegExp(`otherEdition-line" href="${PRODUCT_LINK}"[^>]*>[\\s\\S]*?<div class="pull-left">\\s*([^<]*?)\\s*&nbsp;-&nbsp;`, 'gi');
  return [...String(html).replace(/\s+/g, ' ').replace(/ >/g, '>').matchAll(pattern)].map(m => ({ path: m[1], ean: m[2], title, year, support: decode(m[3]) }));
}

// Éditions d'une page de résultats : chaque résultat principal (titre, année, format)
// suivi de ses « autres éditions » quand la page les contient déjà.
function parseResults(html) {
  const flat = html.replace(/\s+/g, ' ').replace(/ >/g, '>');
  const start = flat.indexOf('id="liste_livres"');
  if (start < 0) return [];
  const body = flat.slice(start);
  const editions = [];
  const parts = body.split(/<h2 class="livre_titre">/).slice(1);
  for (const part of parts) {
    const head = part.match(new RegExp(`<a href="${PRODUCT_LINK}"[^>]*>([\\s\\S]*?)<\\/a>`, 'i'));
    if (!head) continue;
    const label = decode(head[3]);
    const year = (label.match(/\((\d{4})\)\s*$/) || [])[1] || '';
    const title = label.replace(/\s*\(\d{4}\)\s*$/, '');
    const mainFormat = decode((part.match(/<span class="item_format">([\s\S]*?)<\/span>/i) || [])[1] || '');
    editions.push({ path: head[1], ean: head[2], title, year, support: mainFormat });
    editions.push(...parseOtherEditions(part, title, year));
  }
  const seen = new Set();
  return editions.filter(e => !seen.has(e.ean) && seen.add(e.ean));
}

function barcodeVariants(code) {
  const digits = String(code || '').replace(/\D/g, '');
  const variants = new Set([digits]);
  if (digits.length === 13 && digits.startsWith('0')) variants.add(digits.slice(1));
  if (digits.length === 12) variants.add('0' + digits);
  return [...variants].filter(v => v.length >= 8);
}

async function loadProduct(path) {
  const url = `${SITE}${path}`;
  const html = await fetchHtml(url);
  return html ? parseProduct(html, url) : null;
}

async function searchByCode(code) {
  const variants = barcodeVariants(code);
  for (const variant of variants) {
    const results = parseResults(await fetchHtml(searchUrl(variant)));
    const hit = results.find(e => variants.includes(e.ean));
    if (!hit) continue;
    const product = await loadProduct(hit.path);
    if (product && variants.includes(product.ean)) return { ...product, match: 'barcode' };
  }
  return null;
}

// Autres éditions des résultats principaux, chargées à part par DVDFr (comme le fait la page en JavaScript).
async function loadOtherEditions(mains) {
  if (!mains.length) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(`${SITE}/detail_autres_editions_liste.php`, {
      method: 'POST',
      signal: controller.signal,
      headers: { ...HEADERS, Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: `${SITE}/listeliv.php` },
      body: JSON.stringify({ data: { gencodsAutresEditions: mains.map(m => m.ean), typeProduitAutresEditions: mains.map(() => '3'), showAutreEdit: true } })
    });
    if (!response.ok) return [];
    const json = await response.json();
    return mains.flatMap(m => parseOtherEditions(json?.[m.ean]?.contentAutresEdits || '', m.title, m.year));
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function searchByTitle(titles, year, format) {
  const wanted = format === '4k' ? '4K UHD' : (format === 'dvd' ? 'DVD' : 'Blu-ray 1080p');
  for (const title of titles) {
    const words = normalize(title).split(' ').filter(w => w.length > 2);
    // L'année doit concorder (les coffrets multi-films n'en ont pas) ; le titre exact passe en premier.
    // L'année doit concorder (les coffrets multi-films n'en ont pas). Si des éditions portent
    // exactement ce titre, les doubles programmes et titres approchants sont écartés.
    const exact = normalize(title);
    const matching = parseResults(await fetchHtml(searchUrl(title))).filter(e => {
      if (year && (!e.year || Math.abs(Number(e.year) - Number(year)) > 1)) return false;
      const name = normalize(e.title);
      return !words.length || words.every(w => name.includes(w));
    });
    const exactOnly = matching.filter(e => normalize(e.title) === exact);
    const results = exactOnly.length ? exactOnly : matching;
    let hit = results.find(e => appFormat(e.support) === wanted);
    if (!hit) hit = (await loadOtherEditions(results.slice(0, 4))).find(e => appFormat(e.support) === wanted);
    if (!hit) continue;
    const product = await loadProduct(hit.path);
    if (product) return { ...product, match: 'title' };
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
      const titles = [...new Set([req.query.title, req.query.originalTitle].map(t => String(t || '').trim().slice(0, 120)).filter(Boolean))];
      if (!titles.length) return res.status(400).json({ error: 'Missing title' });
      const year = /^\d{4}$/.test(String(req.query.year || '')) ? String(req.query.year) : '';
      edition = await searchByTitle(titles, year, String(req.query.format || ''));
    } else {
      return res.status(400).json({ error: 'Invalid mode' });
    }
    if (!edition) { res.setHeader('Cache-Control', 's-maxage=21600'); return res.status(200).json({ found: false }); }
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({ found: true, ...edition });
  } catch (_) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'DVDFr unavailable' });
  }
}

export { parseProduct, parseResults };
