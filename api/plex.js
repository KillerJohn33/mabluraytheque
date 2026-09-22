const PLEX_API = 'https://plex.tv/api/v2';
const PRODUCT = 'Ma Bluraythèque';

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

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée.' });
  const action = String(req.query.action || '');
  const clientId = String(req.query.clientId || '').trim();
  if (!clientId) return res.status(400).json({ error: 'Identifiant client manquant.' });

  try {
    if (action === 'pin') {
      const pin = await createPin(clientId);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(pin);
    }
    if (action === 'check') {
      const id = String(req.query.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Identifiant de code manquant.' });
      const result = await checkPin(id, clientId);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(result);
    }
    if (action === 'resources') {
      const token = String(req.query.token || '').trim();
      if (!token) return res.status(400).json({ error: 'Jeton Plex manquant.' });
      const servers = await listResources(token, clientId);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(servers);
    }
    return res.status(400).json({ error: 'Action inconnue.' });
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'Service Plex indisponible.' });
  }
}
