const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const AAD = textEncoder.encode('quicknote:v1');
const MAX_TEXT_LENGTH = 20_000;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export class CryptoUnavailableError extends Error {
  constructor() {
    super(
      "Le chiffrement nécessite une connexion sécurisée (HTTPS ou localhost). Utilisez HTTPS pour protéger vos notes."
    );
    this.name = 'CryptoUnavailableError';
  }
}

export function isCryptoAvailable() {
  return window.isSecureContext && Boolean(globalThis.crypto?.subtle);
}

function toBase64Url(bytes) {
  const bytesArray = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytesArray.length; index += chunkSize) {
    binary += String.fromCharCode(...bytesArray.subarray(index, index + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Encodage invalide.');
  }
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function importEncryptionKey(rawKey, usages) {
  if (rawKey.length !== 32) {
    throw new Error('Clé de chiffrement invalide.');
  }
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, usages);
}

export async function createEncryptedPayload(text) {
  if (!isCryptoAvailable()) throw new CryptoUnavailableError();
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Écrivez un message avant de créer le lien.');
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`Votre message ne peut pas dépasser ${MAX_TEXT_LENGTH.toLocaleString('fr-FR')} caractères.`);
  }

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt'
  ]);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const keyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', rawKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: AAD },
    key,
    textEncoder.encode(text)
  );

  return {
    ciphertext: toBase64Url(encrypted),
    iv: toBase64Url(iv),
    key: toBase64Url(rawKey),
    keyHash: toBase64Url(keyHash)
  };
}

export async function hashEncryptionKey(keyValue) {
  if (!isCryptoAvailable()) throw new CryptoUnavailableError();
  const rawKey = fromBase64Url(keyValue);
  if (rawKey.length !== 32) throw new Error('Clé de déchiffrement invalide.');
  const digest = await crypto.subtle.digest('SHA-256', rawKey);
  return toBase64Url(new Uint8Array(digest));
}

export async function decryptPayload({ ciphertext, iv }, keyValue) {
  if (!isCryptoAvailable()) throw new CryptoUnavailableError();

  const rawKey = fromBase64Url(keyValue);
  const key = await importEncryptionKey(rawKey, ['decrypt']);
  const ivBytes = fromBase64Url(iv);
  const ciphertextBytes = fromBase64Url(ciphertext);

  if (ivBytes.length !== 12) throw new Error('Données chiffrées invalides.');

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes, additionalData: AAD },
      key,
      ciphertextBytes
    );
    return textDecoder.decode(decrypted);
  } catch {
    throw new Error(
      "Impossible de déchiffrer cette note. Le lien est peut-être incomplet ou a été modifié."
    );
  }
}

export function getKeyFromHash() {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return '';
  return hash.startsWith('k=') ? hash.slice(2) : hash;
}

export function getNoteIdFromPath() {
  const match = window.location.pathname.match(/^\/n\/([A-Za-z0-9]{6,16})$/);
  return match ? match[1] : '';
}

export function formatDate(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

export function formatShortRemaining(isoDate) {
  const date = new Date(isoDate);
  const milliseconds = date.getTime() - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 'expirée';

  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.ceil(hours / 24);
  return `${days} jours`;
}

export async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', "Impossible de joindre le serveur. Vérifiez votre connexion.");
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The status code below still gives us a useful fallback.
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error?.code || 'REQUEST_FAILED',
      payload?.error?.message || 'La demande n’a pas pu aboutir.'
    );
  }

  return payload;
}

export async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Some browsers expose the API but still require a stricter permission.
    }
  }

  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', '');
  helper.className = 'clipboard-helper';
  document.body.appendChild(helper);
  helper.select();
  const copied = document.execCommand('copy');
  helper.remove();

  if (!copied) throw new Error('Copie impossible.');
}

export function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    toast.classList.remove('is-visible');
  }, 2800);
}

export function setButtonLoading(button, isLoading, loadingLabel) {
  const label = button.querySelector('[data-button-label]');
  if (!label) return;

  if (isLoading) {
    button.dataset.originalLabel = label.textContent;
    button.classList.add('is-loading');
    button.disabled = true;
    label.textContent = loadingLabel;
  } else {
    button.classList.remove('is-loading');
    button.disabled = false;
    if (button.dataset.originalLabel) {
      label.textContent = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
  }
}

export { MAX_TEXT_LENGTH };
