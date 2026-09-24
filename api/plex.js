const PLEX_API = 'https://plex.tv/api/v2';
const PRODUCT = 'Ma Bluraythèque';
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function plexHeaders(clientId, extra = {}) {
  return {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': '1.0',
    'X-Plex-Client-Identifier': clientId,
    ...extra
  };
}

async function createPin(clientId) {
  const response = await fetchWithTimeout(`${PLEX_API}/pins?strong=true`, {
    method: 'POST',
    headers: plexHeaders(clientId)
  });
  if (!response.ok) throw new Error('pin_create_failed');
  const data = await response.json();
  return { id: data.id, code: data.code };
}

async function checkPin(id, clientId) {
  const response = await fetchWithTimeout(`${PLEX_API}/pins/${encodeURIComponent(id)}`, {
    headers: plexHeaders(clientId)
  });
  if (!response.ok) throw new Error('pin_check_failed');
  const data = await response.json();
  return { authToken: data.authToken || null };
}

async function listResources(token, clientId) {
  const response = await fetchWithTimeout(
    `${PLEX_API}/resources?includeHttps=1&includeRelay=1`,
    { headers: plexHeaders(clientId, { 'X-Plex-Token': token }) }
  );
  if (!response.ok) throw new Error('resources_failed');
  const data = await response.json();
  const servers = (Array.isArray(data) ? data : [])
    .filter(resource => String(resource.provides || '').split(',').includes('server'))
    .map(resource => {
      const connections = Array.isArray(resource.connections) ? resource.connections : [];
      const best = connections.find(c => !c.local && !c.relay && c.uri?.startsWith('https'))
        || connections.find(c => !c.local && c.uri?.startsWith('https'))
        || connections.find(c => c.local)
        || connections[0];
      return {
        name: resource.name || 'Serveur Plex',
        clientIdentifier: resource.clientIdentifier || '',
        owned: !!resource.owned,
        uri: best ? best.uri : '',
        connections: connections.map(c => ({ uri: c.uri, local: !!c.local, relay: !!c.relay }))
      };
    })
    .filter(server => server.uri)
    .sort((a, b) => (b.owned ? 1 : 0) - (a.owned ? 1 : 0));
  return servers;
}

function requestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length <= 4096) {
    try { return JSON.parse(req.body); } catch (_) {}
  }
  return {};
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }
  if (!allowRequest(req)) return res.status(429).json({ error: 'Trop de requêtes. Réessayez dans une minute.' });

  const body = requestBody(req);
  const action = String(body.action || '');
  const clientId = String(body.clientId || '').trim();
  if (!/^[a-z0-9._-]{8,160}$/i.test(clientId)) return res.status(400).json({ error: 'Identifiant client invalide.' });

  try {
    if (action === 'pin') {
      const pin = await createPin(clientId);
      return res.status(200).json(pin);
    }
    if (action === 'check') {
      const id = String(body.id || '').trim();
      if (!/^\d{1,20}$/.test(id)) return res.status(400).json({ error: 'Identifiant de code invalide.' });
      return res.status(200).json(await checkPin(id, clientId));
    }
    if (action === 'resources') {
      const token = String(body.token || '').trim();
      if (!token || token.length > 512) return res.status(400).json({ error: 'Jeton Plex invalide.' });
      return res.status(200).json(await listResources(token, clientId));
    }
    return res.status(400).json({ error: 'Action inconnue.' });
  } catch (_) {
    return res.status(502).json({ error: 'Service Plex indisponible.' });
  }
}
