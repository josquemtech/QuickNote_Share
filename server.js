import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : join(__dirname, 'data');
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';

const ONE_HOUR = 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * ONE_HOUR;
const MAX_BODY_BYTES = 160 * 1024;
const MAX_CIPHERTEXT_BYTES = 100 * 1024;
const ALLOWED_TTLS = new Set([ONE_HOUR / 1000, 24 * 60 * 60, SEVEN_DAYS / 1000]);

mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, 'quicknote.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA secure_delete = ON;

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('burn', 'timed')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notes_expires_at ON notes(expires_at);
`);

const insertNote = db.prepare(`
  INSERT INTO notes (id, ciphertext, iv, key_hash, mode, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const findNoteForStatus = db.prepare(`
  SELECT mode, created_at, expires_at FROM notes WHERE id = ?
`);
const findNoteForReveal = db.prepare(`
  SELECT ciphertext, iv, key_hash, mode, created_at, expires_at FROM notes WHERE id = ?
`);
const noteExists = db.prepare('SELECT 1 AS found FROM notes WHERE id = ?');
const deleteNote = db.prepare('DELETE FROM notes WHERE id = ?');
const deleteExpiredNotes = db.prepare('DELETE FROM notes WHERE expires_at <= ?');

function cleanupExpiredNotes() {
  try {
    deleteExpiredNotes.run(Date.now());
  } catch (error) {
    console.error('Nettoyage impossible :', error);
  }
}

cleanupExpiredNotes();
const cleanupTimer = setInterval(cleanupExpiredNotes, 5 * 60 * 1000);
cleanupTimer.unref();

const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const ID_PATTERN = /^[A-Za-z0-9]{6,16}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function createNoteId(length = 8) {
  let id = '';
  for (let index = 0; index < length; index += 1) {
    id += ID_ALPHABET[randomBytes(1)[0] % ID_ALPHABET.length];
  }
  return id;
}

function generateAvailableId() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = createNoteId();
    if (!noteExists.get(id)) return id;
  }
  throw new Error("Impossible de générer un identifiant de note unique.");
}

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  consume(key) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = (this.hits.get(key) || []).filter((time) => time > cutoff);

    if (timestamps.length >= this.limit) {
      const retryAfter = Math.max(1, Math.ceil((timestamps[0] + this.windowMs - now) / 1000));
      this.hits.set(key, timestamps);
      return retryAfter;
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);

    if (this.hits.size > 5_000) {
      for (const [entryKey, entryTimes] of this.hits) {
        if (entryTimes.every((time) => time <= cutoff)) this.hits.delete(entryKey);
      }
    }

    return 0;
  }
}

const createLimiter = new RateLimiter(30, ONE_HOUR);
const revealLimiter = new RateLimiter(120, 10 * 60 * 1000);
const statusLimiter = new RateLimiter(240, 10 * 60 * 1000);

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/common.js', ['common.js', 'text/javascript; charset=utf-8']],
  ['/create.js', ['create.js', 'text/javascript; charset=utf-8']],
  ['/note.js', ['note.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/robots.txt', ['robots.txt', 'text/plain; charset=utf-8']],
  ['/404.html', ['404.html', 'text/html; charset=utf-8']]
]);

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'"
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
}

function sendApiError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const payload = {
    error: {
      code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR',
      message:
        error instanceof HttpError
          ? error.message
          : 'Une erreur interne est survenue. Réessayez dans un instant.'
    }
  };

  sendJson(res, status, payload, error instanceof HttpError ? error.headers : {});
}

function serveFile(res, filename, contentType, extraHeaders = {}, status = 200) {
  try {
    const file = readFileSync(join(PUBLIC_DIR, filename));
    send(res, status, file, {
      'Content-Type': contentType,
      ...extraHeaders
    });
  } catch (error) {
    console.error(`Fichier introuvable : ${filename}`, error);
    send(res, 500, 'Erreur serveur');
  }
}

function getClientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress || 'inconnu';
}

function enforceRateLimit(limiter, req) {
  const retryAfter = limiter.consume(getClientIp(req));
  if (retryAfter > 0) {
    throw new HttpError(
      429,
      'TOO_MANY_REQUESTS',
      `Trop de demandes. Réessayez dans ${retryAfter} secondes.`,
      { 'Retry-After': String(retryAfter) }
    );
  }
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.toLowerCase().startsWith('application/json')) {
      rejectBody(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Le format JSON est requis.'));
      req.resume();
      return;
    }

    let size = 0;
    let tooLarge = false;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) {
        rejectBody(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'La note envoyée est trop volumineuse.'));
        return;
      }

      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Invalid payload');
        }
        resolveBody(parsed);
      } catch {
        rejectBody(new HttpError(400, 'INVALID_JSON', 'La requête est invalide.'));
      }
    });

    req.on('error', () => {
      rejectBody(new HttpError(400, 'REQUEST_ERROR', 'La requête a été interrompue.'));
    });
  });
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url');
}

function validateEncryptedPayload(body) {
  const { ciphertext, iv, keyHash, mode, ttl } = body;

  if (
    typeof ciphertext !== 'string' ||
    ciphertext.length < 16 ||
    ciphertext.length > Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3) + 4 ||
    !BASE64URL_PATTERN.test(ciphertext)
  ) {
    throw new HttpError(400, 'INVALID_CIPHERTEXT', 'Le contenu chiffré est invalide.');
  }

  if (typeof iv !== 'string' || !BASE64URL_PATTERN.test(iv) || decodeBase64Url(iv).length !== 12) {
    throw new HttpError(400, 'INVALID_IV', "Le vecteur d'initialisation est invalide.");
  }

  if (
    typeof keyHash !== 'string' ||
    !BASE64URL_PATTERN.test(keyHash) ||
    decodeBase64Url(keyHash).length !== 32
  ) {
    throw new HttpError(400, 'INVALID_KEY_HASH', 'La clé de chiffrement est invalide.');
  }

  const ciphertextBytes = decodeBase64Url(ciphertext);
  if (ciphertextBytes.length < 17 || ciphertextBytes.length > MAX_CIPHERTEXT_BYTES) {
    throw new HttpError(400, 'INVALID_CIPHERTEXT', 'Le contenu chiffré est invalide.');
  }

  if (mode !== 'burn' && mode !== 'timed') {
    throw new HttpError(400, 'INVALID_MODE', 'La durée de vie choisie est invalide.');
  }

  let ttlSeconds = 24 * 60 * 60;
  if (mode === 'timed') {
    if (!ALLOWED_TTLS.has(ttl)) {
      throw new HttpError(400, 'INVALID_TTL', "La durée d'expiration choisie est invalide.");
    }
    ttlSeconds = ttl;
  }

  return {
    ciphertext,
    iv,
    keyHash,
    mode,
    ttlSeconds
  };
}

function parseNoteRoute(pathname, method) {
  const match = pathname.match(/^\/api\/notes\/([A-Za-z0-9]{6,16})(\/reveal)?$/);
  if (!match) return null;
  if (!ID_PATTERN.test(match[1])) return null;
  return {
    id: match[1],
    action: match[2] ? 'reveal' : 'status',
    method
  };
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, service: 'quicknote', time: new Date().toISOString() });
    return true;
  }

  if (pathname === '/api/notes') {
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Méthode non autorisée.' }
      }, { Allow: 'POST' });
      return true;
    }

    try {
      enforceRateLimit(createLimiter, req);
      const body = await readJsonBody(req);
      const payload = validateEncryptedPayload(body);
      const now = Date.now();
      const expiresAt =
        payload.mode === 'burn' ? now + SEVEN_DAYS : now + payload.ttlSeconds * 1000;
      const id = generateAvailableId();

      insertNote.run(
        id,
        payload.ciphertext,
        payload.iv,
        payload.keyHash,
        payload.mode,
        now,
        expiresAt
      );

      sendJson(res, 201, {
        id,
        mode: payload.mode,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAt).toISOString()
      });
    } catch (error) {
      sendApiError(res, error);
    }
    return true;
  }

  const noteRoute = parseNoteRoute(pathname, req.method);
  if (!noteRoute) return false;

  const { id, action, method } = noteRoute;

  if (action === 'status') {
    if (method !== 'GET') {
      sendJson(res, 405, {
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Méthode non autorisée.' }
      }, { Allow: 'GET' });
      return true;
    }

    try {
      enforceRateLimit(statusLimiter, req);
      const note = findNoteForStatus.get(id);
      if (!note) {
        throw new HttpError(404, 'NOTE_NOT_FOUND', "Cette note n'existe pas ou a déjà été supprimée.");
      }
      if (note.expires_at <= Date.now()) {
        deleteNote.run(id);
        throw new HttpError(410, 'NOTE_EXPIRED', 'Cette note a expiré.');
      }

      sendJson(res, 200, {
        mode: note.mode,
        createdAt: new Date(note.created_at).toISOString(),
        expiresAt: new Date(note.expires_at).toISOString()
      });
    } catch (error) {
      sendApiError(res, error);
    }
    return true;
  }

  if (method !== 'POST') {
    sendJson(res, 405, {
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Méthode non autorisée.' }
    }, { Allow: 'POST' });
    return true;
  }

  try {
    enforceRateLimit(revealLimiter, req);
    const body = await readJsonBody(req);
    const providedKeyHash = body.keyHash;

    if (
      typeof providedKeyHash !== 'string' ||
      !BASE64URL_PATTERN.test(providedKeyHash) ||
      decodeBase64Url(providedKeyHash).length !== 32
    ) {
      throw new HttpError(400, 'INVALID_KEY_HASH', 'La clé de déchiffrement est invalide.');
    }

    const note = findNoteForReveal.get(id);
    if (!note) {
      throw new HttpError(404, 'NOTE_NOT_FOUND', "Cette note n'existe pas ou a déjà été supprimée.");
    }
    if (note.expires_at <= Date.now()) {
      deleteNote.run(id);
      throw new HttpError(410, 'NOTE_EXPIRED', 'Cette note a expiré.');
    }

    const expectedHash = decodeBase64Url(note.key_hash);
    const actualHash = decodeBase64Url(providedKeyHash);
    if (!timingSafeEqual(expectedHash, actualHash)) {
      throw new HttpError(
        403,
        'INVALID_KEY',
        "La clé de déchiffrement ne correspond pas. La note n'a pas été détruite."
      );
    }

    if (note.mode === 'burn') {
      deleteNote.run(id);
    }

    sendJson(res, 200, {
      ciphertext: note.ciphertext,
      iv: note.iv,
      mode: note.mode,
      createdAt: new Date(note.created_at).toISOString(),
      expiresAt: new Date(note.expires_at).toISOString()
    });
  } catch (error) {
    sendApiError(res, error);
  }

  return true;
}

function handleRequest(req, res) {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    send(res, 400, 'Requête invalide');
    return;
  }

  if (pathname.startsWith('/api/')) {
    Promise.resolve(handleApi(req, res, pathname)).then((handled) => {
      if (!handled) {
        sendJson(res, 404, {
          error: { code: 'NOT_FOUND', message: 'Ressource introuvable.' }
        });
      }
    }).catch((error) => {
      console.error(error);
      if (!res.headersSent) sendApiError(res, error);
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Méthode non autorisée', { Allow: 'GET, HEAD' });
    return;
  }

  if (pathname === '/' || STATIC_FILES.has(pathname)) {
    const entry = STATIC_FILES.get(pathname) || STATIC_FILES.get('/');
    serveFile(res, entry[0], entry[1]);
    return;
  }

  if (pathname.startsWith('/n/')) {
    const id = pathname.slice(3);
    if (!ID_PATTERN.test(id)) {
      serveFile(res, '404.html', 'text/html; charset=utf-8', { 'X-Robots-Tag': 'noindex' }, 404);
      return;
    }
    serveFile(res, 'note.html', 'text/html; charset=utf-8', {
      'X-Robots-Tag': 'noindex, nofollow, noarchive'
    });
    return;
  }

  serveFile(res, '404.html', 'text/html; charset=utf-8', { 'X-Robots-Tag': 'noindex' }, 404);
}

const server = createServer(handleRequest);
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  QuickNote Share');
  console.log(`  → http://localhost:${PORT}`);
  console.log('');
  console.log('  Les notes sont chiffrées dans le navigateur.');
  console.log('  Le serveur ne reçoit jamais le contenu en clair.');
  console.log('');
});

function shutdown(signal) {
  console.log(`\nArrêt (${signal})…`);
  clearInterval(cleanupTimer);
  server.close(() => {
    try {
      db.close();
    } finally {
      process.exit(0);
    }
  });
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
