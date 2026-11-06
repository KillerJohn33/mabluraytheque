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
  if (response.status === 401) throw new Error('plex_http_401');
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

function orderedConnections(server) {
  const connections = Array.isArray(server?.connections) ? server.connections : [];
  return [...connections]
    .filter(connection => /^https:\/\//i.test(String(connection.uri || '')))
    .sort((a, b) => {
      const score = connection => (!connection.local && !connection.relay ? 0 : connection.relay ? 1 : 2);
      return score(a) - score(b);
    });
}

async function fetchPlexJson(base, path, token, clientId) {
  const response = await fetchWithTimeout(`${String(base).replace(/\/$/, '')}${path}`, {
    headers: plexHeaders(clientId, { 'X-Plex-Token': token })
  }, 12000);
  if (!response.ok) throw new Error(`plex_http_${response.status}`);
  return response.json();
}

function plexLibraryItem(metadata, section) {
  const tmdbGuid = (Array.isArray(metadata.Guid) ? metadata.Guid : []).find(g => String(g?.id || '').startsWith('tmdb://'));
  const media = Array.isArray(metadata.Media) ? metadata.Media[0] : null;
  const part = media && Array.isArray(media.Part) ? media.Part[0] : null;
  return {
    ratingKey: String(metadata.ratingKey || ''),
    title: metadata.title || 'Sans titre',
    year: metadata.year || null,
    type: section.type,
    sectionTitle: section.title || '',
    tmdbId: tmdbGuid ? String(tmdbGuid.id).replace('tmdb://', '') : '',
    thumbPath: metadata.thumb || '',
    duration: metadata.duration ? Math.round(metadata.duration / 60000) : 0,
    resolution: media?.videoResolution || '',
    videoCodec: media?.videoCodec || '',
    audioCodec: media?.audioCodec || '',
    audioChannels: media?.audioChannels || null,
    container: media?.container || part?.container || '',
    fileSize: part?.size || null,
    addedAt: metadata.addedAt ? metadata.addedAt * 1000 : Date.now()
  };
}

// Trouve une adresse joignable du serveur (toutes les connexions HTTPS sont essayées, locale exclue côté Vercel).
async function resolveServer(token, clientId, serverClientIdentifier) {
  const servers = await listResources(token, clientId);
  const server = servers.find(item => item.clientIdentifier === serverClientIdentifier)
    || servers.find(item => item.owned)
    || servers[0];
  if (!server) throw new Error('no_server');
  const connections = orderedConnections(server);
  if (!connections.length && /^https:\/\//i.test(server.uri || '')) connections.push({ uri: server.uri });
  for (const connection of connections) {
    try {
      const data = await fetchPlexJson(connection.uri, '/library/sections', token, clientId);
      return { server, base: String(connection.uri).replace(/\/$/, ''), sectionsData: data };
    } catch (_) {}
  }
  throw new Error('server_unreachable');
}

async function listSections(token, clientId, serverClientIdentifier) {
  const { server, base, sectionsData } = await resolveServer(token, clientId, serverClientIdentifier);
  const sections = (sectionsData?.MediaContainer?.Directory || [])
    .filter(section => section.type === 'movie' || section.type === 'show')
    .map(section => ({ key: String(section.key), title: section.title || '', type: section.type }));
  return { serverName: server.name || 'Serveur Plex', serverClientIdentifier: server.clientIdentifier || '', serverUri: base, sections };
}

// Une page d'une section (lecture découpée : aucune requête trop longue, même pour une grosse bibliothèque).
async function readSectionPage(token, clientId, base, section, start, size) {
  const path = `/library/sections/${encodeURIComponent(section.key)}/all?includeGuids=1&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`;
  const data = await fetchPlexJson(base, path, token, clientId);
  const container = data?.MediaContainer || {};
  const items = (container.Metadata || []).map(metadata => plexLibraryItem(metadata, section)).filter(item => item.ratingKey);
  const total = Number(container.totalSize ?? container.size ?? items.length) || 0;
  return { items, total, start, size };
}

async function readLibrary(token, clientId, serverClientIdentifier) {
  const servers = await listResources(token, clientId);
  const server = servers.find(item => item.clientIdentifier === serverClientIdentifier)
    || servers.find(item => item.owned)
    || servers[0];
  if (!server) throw new Error('no_server');

  const connections = orderedConnections(server);
  if (!connections.length && /^https:\/\//i.test(server.uri || '')) connections.push({ uri: server.uri });
  let base = '';
  let sectionsData = null;
  for (const connection of connections) {
    try {
      sectionsData = await fetchPlexJson(connection.uri, '/library/sections', token, clientId);
      base = String(connection.uri).replace(/\/$/, '');
      break;
    } catch (_) {}
  }
  if (!sectionsData || !base) throw new Error('server_unreachable');

  const sections = (sectionsData?.MediaContainer?.Directory || [])
    .filter(section => section.type === 'movie' || section.type === 'show');
  const results = await Promise.all(sections.map(async section => {
    try {
      const data = await fetchPlexJson(base, `/library/sections/${encodeURIComponent(section.key)}/all?includeGuids=1`, token, clientId);
      return (data?.MediaContainer?.Metadata || []).map(metadata => plexLibraryItem(metadata, section));
    } catch (_) {
      return [];
    }
  }));
  return {
    serverName: server.name || 'Serveur Plex',
    serverUri: base,
    items: results.flat().filter(item => item.ratingKey)
  };
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
    if (action === 'sections') {
      const token = String(body.token || '').trim();
      const serverClientIdentifier = String(body.serverClientIdentifier || '').trim();
      if (!token || token.length > 512) return res.status(400).json({ error: 'Jeton Plex invalide.' });
      return res.status(200).json(await listSections(token, clientId, serverClientIdentifier.slice(0, 256)));
    }
    if (action === 'page') {
      const token = String(body.token || '').trim();
      const base = String(body.serverUri || '').trim().replace(/\/$/, '');
      const key = String(body.sectionKey || '').trim();
      const start = Math.max(0, parseInt(body.start, 10) || 0);
      const size = Math.min(300, Math.max(1, parseInt(body.size, 10) || 200));
      if (!token || token.length > 512) return res.status(400).json({ error: 'Jeton Plex invalide.' });
      if (!/^https:\/\/[a-z0-9.-]+\.plex\.direct(:\d+)?$/i.test(base) && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base)) return res.status(400).json({ error: 'Adresse du serveur invalide.' });
      if (!/^\d{1,10}$/.test(key)) return res.status(400).json({ error: 'Bibliothèque invalide.' });
      const section = { key, title: String(body.sectionTitle || '').slice(0, 120), type: body.sectionType === 'show' ? 'show' : 'movie' };
      return res.status(200).json(await readSectionPage(token, clientId, base, section, start, size));
    }
    if (action === 'library') {
      const token = String(body.token || '').trim();
      const serverClientIdentifier = String(body.serverClientIdentifier || '').trim();
      if (!token || token.length > 512) return res.status(400).json({ error: 'Jeton Plex invalide.' });
      if (serverClientIdentifier.length > 256) return res.status(400).json({ error: 'Serveur Plex invalide.' });
      return res.status(200).json(await readLibrary(token, clientId, serverClientIdentifier));
    }
    return res.status(400).json({ error: 'Action inconnue.' });
  } catch (error) {
    const messages = {
      no_server: 'Aucun serveur Plex trouvé sur ce compte.',
      server_unreachable: 'Le serveur Plex est injoignable depuis Internet. Vérifiez que Plex est allumé et que l’« Accès à distance » est activé dans ses réglages.'
    };
    const msg = String(error?.message || '');
    if (/^plex_http_401/.test(msg)) return res.status(401).json({ error: 'Connexion Plex expirée : reconnectez votre compte.' });
    return res.status(502).json({ error: messages[msg] || 'Service Plex indisponible.' });
  }
}
