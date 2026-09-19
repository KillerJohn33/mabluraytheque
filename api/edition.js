const UPC = 'https://api.upcitemdb.com/prod/trial/lookup';
const BNF = 'https://catalogue.bnf.fr/api/SRU';
const COVER = 'https://openapi.bnf.fr/couverture/image/image/recupererImage';

async function timedFetch(url, ms = 4500) {
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), ms);
 try { return await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'MaBluraytheque/1.0' } }); }
 finally { clearTimeout(timer); }
}
function decodeXml(value = '') {
 return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
function field(xml, name) {
 return decodeXml((xml.match(new RegExp(`<dc:${name}[^>]*>([\\s\\S]*?)<\\/dc:${name}>`, 'i')) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
}
async function fromBnf(code) {
 const params = new URLSearchParams({ version: '1.2', operation: 'searchRetrieve', query: `bib.ean all "${code}"`, recordSchema: 'dublincore', maximumRecords: '1' });
 const response = await timedFetch(`${BNF}?${params}`);
 if (!response.ok) return null;
 const xml = await response.text();
 if (!Number((xml.match(/<srw:numberOfRecords>(\d+)<\/srw:numberOfRecords>/i) || [])[1] || 0)) return null;
 return { title: field(xml, 'title'), publisher: field(xml, 'publisher'), description: field(xml, 'format'), source: 'BnF' };
}
async function fromUpc(code) {
 const response = await timedFetch(`${UPC}?upc=${code}`);
 if (!response.ok) return null;
 const data = await response.json();
 const item = Array.isArray(data.items) ? data.items[0] : null;
 if (!item) return null;
 return { title: item.title || '', publisher: item.brand || '', description: item.description || '', images: Array.isArray(item.images) ? item.images.filter(url => /^https:\/\//i.test(url)).slice(0, 5) : [], source: 'UPCitemdb' };
}
async function bnfCover(code) {
 const url = `${COVER}?EAN=${code}&couverture=1&taille=originale&largeur=500&hauteur=500`;
 try {
  const response = await timedFetch(url, 3500);
  if (response.ok && /^image\//i.test(response.headers.get('content-type') || '')) return url;
 } catch (_) {}
 return '';
}
export default async function handler(req, res) {
 if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
 const code = String(req.query.code || '').replace(/\D/g, '');
 if (!/^\d{8,14}$/.test(code)) return res.status(400).json({ error: 'Invalid barcode' });
 const [bnfResult, upcResult] = await Promise.allSettled([fromBnf(code), fromUpc(code)]);
 const bnf = bnfResult.status === 'fulfilled' ? bnfResult.value : null;
 const upc = upcResult.status === 'fulfilled' ? upcResult.value : null;
 if (!bnf && !upc) { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json({ found: false, code }); }
 const image = upc?.images?.[0] || (bnf ? await bnfCover(code) : '');
 res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
 return res.status(200).json({ found: true, code, title: bnf?.title || upc?.title || '', publisher: bnf?.publisher || upc?.publisher || '', description: bnf?.description || upc?.description || '', image, source: [bnf?.source, upc?.source].filter(Boolean).join(' + ') });
}
