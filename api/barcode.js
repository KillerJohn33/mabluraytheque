const UPC_ENDPOINT = 'https://api.upcitemdb.com/prod/trial/lookup';
const BNF_ENDPOINT = 'https://catalogue.bnf.fr/api/SRU';
const GO_UPC_ENDPOINT = 'https://go-upc.com/api/v1/code/';

async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function decodeXml(value = '') {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

async function lookupUpcItemDb(code) {
  const response = await fetchWithTimeout(`${UPC_ENDPOINT}?upc=${encodeURIComponent(code)}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'MaBluraytheque/1.0' }
  });
  if (!response.ok) return null;
  const data = await response.json();
  const item = Array.isArray(data.items) ? data.items[0] : null;
  if (!item) return null;
  return {
    title: item.title || '',
    description: item.description || '',
    brand: item.brand || '',
    category: item.category || '',
    offerTitles: Array.isArray(item.offers) ? item.offers.map(offer => offer && offer.title).filter(Boolean).slice(0, 8) : [],
    source: 'UPCitemdb'
  };
}

async function lookupBnf(code) {
  const params = new URLSearchParams({
    version: '1.2',
    operation: 'searchRetrieve',
    query: `bib.ean all "${code}"`,
    recordSchema: 'dublincore',
    maximumRecords: '3'
  });
  const response = await fetchWithTimeout(`${BNF_ENDPOINT}?${params}`, {
    headers: { Accept: 'application/xml,text/xml', 'User-Agent': 'MaBluraytheque/1.0' }
  });
  if (!response.ok) return null;
  const xml = await response.text();
  const recordCount = Number((xml.match(/<srw:numberOfRecords>(\d+)<\/srw:numberOfRecords>/i) || [])[1] || 0);
  const title = decodeXml((xml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
  if (!recordCount || !title) return null;
  const publisher = decodeXml((xml.match(/<dc:publisher[^>]*>([\s\S]*?)<\/dc:publisher>/i) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
  const format = decodeXml((xml.match(/<dc:format[^>]*>([\s\S]*?)<\/dc:format>/i) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
  return { title, description: format, brand: publisher, category: 'VidÃ©o', offerTitles: [], source: 'BnF' };
}

async function lookupGoUpc(code) {
  const key = process.env.GO_UPC_API_KEY;
  if (!key) return null;
  const response = await fetchWithTimeout(`${GO_UPC_ENDPOINT}${code}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}` }
  });
  if (!response.ok) return null;
  const data = await response.json();
  const product = data?.product;
  if (!product?.name) return null;
  return {
    title: product.name,
    description: product.description || '',
    brand: product.brand || '',
    category: product.category || '',
    offerTitles: [],
    source: 'Go-UPC'
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'MÃ©thode non autorisÃ©e.' });
  const code = String(req.query.code || '').replace(/\D/g, '');
  if (!/^\d{8,14}$/.test(code)) return res.status(400).json({ error: 'Code-barres invalide.' });

  try {
    const firstProduct = promise => promise.then(product => {
      if (!product) throw new Error('Produit absent');
      return product;
    });
    let product = null;
    if (req.query.source === 'go-upc') {
      product = await lookupGoUpc(code).catch(() => null);
    } else {
      try {
        product = await Promise.any([
          firstProduct(lookupBnf(code)),
          firstProduct(lookupUpcItemDb(code))
        ]);
      } catch (_) {
        // Les deux catalogues gratuits ne connaissent pas cet EAN.
      }
      if (!product) product = await lookupGoUpc(code).catch(() => null);
    }

    if (!product) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ found: false, code });
    }
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({ found: true, code, product });
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'Catalogues produit inaccessibles.' });
  }
}
