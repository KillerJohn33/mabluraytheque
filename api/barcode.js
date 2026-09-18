const UPC_ENDPOINT = 'https://api.upcitemdb.com/prod/trial/lookup';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  if (req.method !== 'GET') return res.status(405).json({ error: 'MÃ©thode non autorisÃ©e.' });

  const code = String(req.query.code || '').replace(/\D/g, '');
  if (!/^\d{8,14}$/.test(code)) return res.status(400).json({ error: 'Code-barres invalide.' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${UPC_ENDPOINT}?upc=${encodeURIComponent(code)}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'MaBluraytheque/1.0' },
      signal: controller.signal
    });
    if (!response.ok) return res.status(502).json({ error: `Catalogue produit indisponible (${response.status}).` });

    const data = await response.json();
    const item = Array.isArray(data.items) ? data.items[0] : null;
    if (!item) return res.status(200).json({ found: false, code });

    const offerTitles = Array.isArray(item.offers)
      ? item.offers.map(offer => offer && offer.title).filter(Boolean).slice(0, 8)
      : [];
    return res.status(200).json({
      found: true,
      code,
      product: {
        title: item.title || '',
        description: item.description || '',
        brand: item.brand || '',
        category: item.category || '',
        offerTitles
      }
    });
  } catch (error) {
    const message = error && error.name === 'AbortError' ? 'Le catalogue produit a mis trop de temps Ã  rÃ©pondre.' : 'Catalogue produit inaccessible.';
    return res.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
}
