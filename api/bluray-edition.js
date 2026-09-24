const SITE = 'https://www.blu-ray.com';

const rateBuckets = new Map();

function allowRequest(req, limit = 45, windowMs = 60000) {
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

function decode(value = '') {
  return value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&euro;/gi, '€').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

function section(html, name, next) {
  const start = html.search(new RegExp(`<span class="subheading">${name}<\\/span>`, 'i'));
  if (start < 0) return '';
  const rest = html.slice(start);
  const end = rest.search(new RegExp(`<span class="subheading">${next}<\\/span>`, 'i'));
  return end < 0 ? '' : rest.slice(0, end);
}

function lines(html) {
  return html.replace(/<br\s*\/?\s*>/gi, '\n').split('\n').map(decode).filter(Boolean);
}

function parseEdition(html, url, id) {
  const title = decode((html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) || [])[1]
    || (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
  const cover = (html.match(/<meta\s+property="og:image"\s+content="(https:\/\/images\.static-bluray\.com\/movies\/covers\/[^"?]+)"/i) || [])[1] || '';
  const video = lines(section(html, 'Video', 'Audio')).filter(v => !/^Video$/i.test(v));
  const audioSection = section(html, 'Audio', 'Subtitles');
  const shortAudio = (audioSection.match(/<div\s+id="shortaudio"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
  const audio = [...new Set(lines(shortAudio))];
  const subsSection = section(html, 'Subtitles', 'Discs');
  const shortSubs = (subsSection.match(/<div\s+id="shortsubs"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
  const subtitles = decode(shortSubs).split(/,\s*/).filter(Boolean);
  const packaging = lines(section(html, 'Packaging', 'Playback')).find(v => !/^Packaging$/i.test(v)) || '';
  const codec = video.find(v => /^Codec:/i.test(v))?.replace(/^Codec:\s*/i, '') || '';
  if (!title || (!video.length && !audio.length && !subtitles.length)) return null;
  return { id, url, title, image: cover, videoCodec: codec, video, audioTracks: audio, subtitles, packaging, source: SITE };
}

export default async function handler(req, res) {
  if (!allowRequest(req)) { res.setHeader('Cache-Control', 'no-store'); return res.status(429).json({ error: 'Trop de requêtes. Réessayez dans une minute.' }); }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  let target;
  try {
    target = new URL(String(req.query.url || ''));
    if (target.origin !== SITE || !/^\/movies\/[a-z0-9-]+\/\d+\/?$/i.test(target.pathname)) throw new Error('Invalid URL');
  } catch (_) { return res.status(400).json({ error: 'Invalid Blu-ray.com edition URL' }); }
  const id = target.pathname.match(/\/(\d+)\/?$/)[1];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(target.toString(), { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MaBluraytheque/1.0)', 'Accept': 'text/html' } });
    if (!response.ok) return res.status(502).json({ error: `Blu-ray.com HTTP ${response.status}` });
    const html = new TextDecoder('iso-8859-1').decode(await response.arrayBuffer());
    const edition = parseEdition(html, target.toString(), id);
    if (!edition) return res.status(404).json({ error: 'Edition details unavailable' });
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json(edition);
  } catch (_) { return res.status(502).json({ error: 'Blu-ray.com unavailable' }); }
  finally { clearTimeout(timer); }
}

export { parseEdition };

