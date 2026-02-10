const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { createClient } = require('redis');

const app = express();
const port = Number(process.env.PORT || 3000);
const defaultTtlSec = Number(process.env.MAP_SESSION_TTL_SEC || 180);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.text({ type: ['text/plain', 'text/*'], limit: '5mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

const memorySessions = new Map();
const memoryCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memorySessions.entries()) {
    if (!entry || entry.expiresAt <= now) {
      memorySessions.delete(key);
    }
  }
}, 30_000);

if (typeof memoryCleanupTimer.unref === 'function') {
  memoryCleanupTimer.unref();
}

let redisClient = null;
let redisGetDelSupported = true;

function sanitizeString(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
}

function normalizeUser(value) {
  return sanitizeString(value).toLowerCase();
}

function clampTtl(value) {
  if (!Number.isFinite(value)) {
    return defaultTtlSec;
  }

  if (value < 30) return 30;
  if (value > 900) return 900;
  return Math.floor(value);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function parseJsonSafe(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function parseDrivers(rawDrivers) {
  if (rawDrivers === undefined || rawDrivers === null || rawDrivers === '') {
    return [];
  }

  if (Array.isArray(rawDrivers)) {
    return rawDrivers;
  }

  if (typeof rawDrivers === 'string') {
    const decoded = safeDecodeURIComponent(rawDrivers);
    const parsed = parseJsonSafe(decoded);

    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (parsed && typeof parsed === 'object') {
      return [parsed];
    }

    return [];
  }

  if (typeof rawDrivers === 'object') {
    return [rawDrivers];
  }

  return [];
}

function parseBoolean(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

function normalizeBody(rawBody) {
  if (typeof rawBody !== 'string') {
    return rawBody || {};
  }

  const trimmed = rawBody.trim();
  if (!trimmed) {
    return {};
  }

  const parsed = parseJsonSafe(trimmed);
  if (parsed !== null) {
    return parsed;
  }

  return { data: trimmed };
}

function normalizePayload(body) {
  if (Array.isArray(body)) {
    return {
      token: '',
      drivers: body,
      slika: undefined,
      ime: undefined,
      lokacija: undefined
    };
  }

  const driversSource = body.drivers !== undefined ? body.drivers : body.data;

  return {
    token: sanitizeString(body.token),
    drivers: parseDrivers(driversSource),
    slika: parseBoolean(body.slika),
    ime: parseBoolean(body.ime),
    lokacija: parseBoolean(body.lokacija)
  };
}

function mapSessionKey(input) {
  if (input.user) {
    return `user:${input.user}`;
  }

  return `tripId:${input.tripId}`;
}

function mapRedisKey(sessionKey) {
  return `map-session:${sessionKey}`;
}

function setMemorySession(sessionKey, payload, ttlSec) {
  memorySessions.set(sessionKey, {
    payload,
    expiresAt: Date.now() + ttlSec * 1000
  });
}

function takeMemorySession(sessionKey) {
  const entry = memorySessions.get(sessionKey);
  if (!entry) {
    return null;
  }

  memorySessions.delete(sessionKey);

  if (entry.expiresAt <= Date.now()) {
    return null;
  }

  return entry.payload;
}

async function setSession(sessionKey, payload, ttlSec) {
  if (redisClient && redisClient.isOpen) {
    await redisClient.setEx(mapRedisKey(sessionKey), ttlSec, JSON.stringify(payload));
    return;
  }

  setMemorySession(sessionKey, payload, ttlSec);
}

async function takeSession(sessionKey) {
  if (!(redisClient && redisClient.isOpen)) {
    return takeMemorySession(sessionKey);
  }

  const redisKey = mapRedisKey(sessionKey);

  if (redisGetDelSupported) {
    try {
      const raw = await redisClient.sendCommand(['GETDEL', redisKey]);
      if (!raw) {
        return null;
      }

      return parseJsonSafe(raw);
    } catch (error) {
      const message = String(error && error.message ? error.message : error).toLowerCase();
      if (message.includes('unknown command') || message.includes('wrong number of arguments')) {
        redisGetDelSupported = false;
      } else {
        throw error;
      }
    }
  }

  const raw = await redisClient.get(redisKey);
  if (!raw) {
    return null;
  }

  await redisClient.del(redisKey);
  return parseJsonSafe(raw);
}

function buildMapUrl(req, input) {
  const host = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

  if (input.user) {
    return `${host}/mapa/?user=${encodeURIComponent(input.user)}`;
  }

  return `${host}/mapa/?tripId=${encodeURIComponent(input.tripId)}`;
}

app.post('/map-session', async (req, res) => {
  try {
    const body = normalizeBody(req.body);
    const user = normalizeUser(body.user || req.query.user);
    const explicitTripId = sanitizeString(body.tripId || req.query.tripId);
    const tripId = explicitTripId || crypto.randomUUID();

    if (!user && !tripId) {
      return res.status(400).json({ error: 'Missing user or tripId.' });
    }

    const sessionInput = user ? { user } : { tripId };
    const payload = normalizePayload({
      ...body,
      token: body.token !== undefined ? body.token : req.query.token,
      slika: body.slika !== undefined ? body.slika : req.query.slika,
      ime: body.ime !== undefined ? body.ime : req.query.ime,
      lokacija: body.lokacija !== undefined ? body.lokacija : req.query.lokacija,
      data: body.data !== undefined ? body.data : req.query.data
    });

    if (!payload.drivers.length) {
      return res.status(400).json({ error: 'Missing drivers payload.' });
    }

    const ttlSec = clampTtl(Number(body.ttlSec || req.query.ttlSec || defaultTtlSec));

    await setSession(mapSessionKey(sessionInput), {
      token: payload.token,
      drivers: payload.drivers,
      slika: payload.slika,
      ime: payload.ime,
      lokacija: payload.lokacija,
      createdAt: new Date().toISOString()
    }, ttlSec);

    return res.json({
      ok: true,
      user: user || null,
      tripId,
      ttlSec,
      mapUrl: buildMapUrl(req, sessionInput)
    });
  } catch (error) {
    console.error('POST /map-session failed', error);
    return res.status(500).json({ error: 'Failed to store map session.' });
  }
});

app.get('/map-session', async (req, res) => {
  try {
    const user = normalizeUser(req.query.user);
    const tripId = sanitizeString(req.query.tripId);

    if (!user && !tripId) {
      return res.status(400).json({ error: 'Missing user or tripId query parameter.' });
    }

    const sessionInput = user ? { user } : { tripId };
    const payload = await takeSession(mapSessionKey(sessionInput));

    if (!payload) {
      return res.status(404).json({ error: 'Session not found or already consumed.' });
    }

    return res.json(payload);
  } catch (error) {
    console.error('GET /map-session failed', error);
    return res.status(500).json({ error: 'Failed to read map session.' });
  }
});

app.get('/map-session/:tripId', async (req, res) => {
  try {
    const tripId = sanitizeString(req.params.tripId);
    if (!tripId) {
      return res.status(400).json({ error: 'Missing tripId.' });
    }

    const payload = await takeSession(mapSessionKey({ tripId }));
    if (!payload) {
      return res.status(404).json({ error: 'Session not found or already consumed.' });
    }

    return res.json(payload);
  } catch (error) {
    console.error('GET /map-session/:tripId failed', error);
    return res.status(500).json({ error: 'Failed to read map session.' });
  }
});

app.get(['/mapa', '/mapa/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'mapa.html'));
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/', (_req, res) => {
  res.json({
    service: 'tego-trans-map-session',
    endpoints: {
      postSession: 'POST /map-session',
      getSession: 'GET /map-session?user=... or ?tripId=...',
      mapPage: 'GET /mapa/?user=... or ?tripId=...'
    }
  });
});

async function initRedis() {
  if (!process.env.REDIS_URL) {
    console.log('REDIS_URL is not set; using in-memory session store.');
    return;
  }

  const client = createClient({ url: process.env.REDIS_URL });
  client.on('error', (error) => {
    console.error('Redis error:', error.message || error);
  });

  try {
    await client.connect();
    redisClient = client;
    console.log('Redis connected.');
  } catch (error) {
    redisClient = null;
    console.error('Redis connect failed, fallback to in-memory store:', error.message || error);
  }
}

(async () => {
  await initRedis();

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
})();
