import {
  api,
  decryptPayload,
  formatDate,
  formatShortRemaining,
  getKeyFromHash,
  getNoteIdFromPath,
  hashEncryptionKey,
  isCryptoAvailable,
  setButtonLoading
} from './common.js';

const READ_SECONDS = 60;

const loadingState = document.getElementById('loading-state');
const introState = document.getElementById('intro-state');
const contentState = document.getElementById('content-state');
const closedState = document.getElementById('closed-state');
const errorState = document.getElementById('error-state');
const introExpiry = document.getElementById('intro-expiry');
const revealBtn = document.getElementById('reveal-btn');
const noteContent = document.getElementById('note-content');
const contentModeLabel = document.getElementById('content-mode-label');
const contentExpiry = document.getElementById('content-expiry');
const burnFooter = document.getElementById('burn-footer');
const timedFooter = document.getElementById('timed-footer');
const timedExpiryText = document.getElementById('timed-expiry-text');
const countdown = document.getElementById('countdown');
const readProgress = document.getElementById('read-progress');
const destroyBtn = document.getElementById('destroy-btn');
const closedTitle = document.getElementById('closed-title');
const closedMessage = document.getElementById('closed-message');
const errorTitle = document.getElementById('error-title');
const errorMessage = document.getElementById('error-message');
const retryBtn = document.getElementById('retry-btn');

const noteId = getNoteIdFromPath();
const noteKey = getKeyFromHash();

let noteMeta = null;
let burnInterval = 0;
let expiryTimer = 0;
let timedRefreshInterval = 0;
let contentClosed = false;
let contentRevealed = false;
let burnStartedAt = 0;

function showOnly(element) {
  [loadingState, introState, contentState, closedState, errorState].forEach((state) => {
    state.hidden = state !== element;
  });
}

function clearReadingTimers() {
  window.clearInterval(burnInterval);
  window.clearTimeout(expiryTimer);
  window.clearInterval(timedRefreshInterval);
  burnInterval = 0;
  expiryTimer = 0;
  timedRefreshInterval = 0;
}

function stripKeyFromUrl() {
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname);
  }
}

function showError(title, message, { retry = false } = {}) {
  clearReadingTimers();
  errorTitle.textContent = title;
  errorMessage.textContent = message;
  retryBtn.hidden = !retry;
  showOnly(errorState);
  document.title = 'Lien indisponible — QuickNote';
  window.scrollTo({ top: 0, behavior: 'auto' });
  window.requestAnimationFrame(() => errorTitle.focus());
}

function showClosed(reason = 'burn') {
  if (contentClosed) return;
  contentClosed = true;
  clearReadingTimers();

  if (reason === 'expired') {
    closedTitle.textContent = 'Cette note a expiré.';
    closedMessage.textContent =
      'Le délai de lecture est terminé. Le message a été supprimé et ne peut plus être consulté.';
  } else {
    closedTitle.textContent = 'Ce message a été détruit.';
    closedMessage.textContent =
      'Il a été retiré du serveur dès sa révélation et vient de disparaître de cet écran.';
  }

  noteContent.textContent = '';
  stripKeyFromUrl();
  showOnly(closedState);
  document.title = 'Note détruite — QuickNote';
  window.scrollTo({ top: 0, behavior: 'auto' });
  window.requestAnimationFrame(() => closedTitle.focus());
}

function destroyContent() {
  clearReadingTimers();
  contentState.classList.add('is-closing');
  const paper = contentState.querySelector('.note-paper');
  paper?.classList.add('is-fading');

  window.setTimeout(() => {
    paper?.classList.remove('is-fading');
    contentState.classList.remove('is-closing');
    showClosed('burn');
  }, 430);
}

function updateCountdown(remainingSeconds) {
  const seconds = Math.max(0, Math.ceil(remainingSeconds));
  const minutesPart = Math.floor(seconds / 60);
  const secondsPart = seconds % 60;
  countdown.textContent = `${String(minutesPart).padStart(2, '0')}:${String(secondsPart).padStart(2, '0')}`;
  readProgress.value = Math.max(0, Math.min(READ_SECONDS, remainingSeconds));
}

function startBurnTimer() {
  const startedAt = performance.now();
  burnStartedAt = startedAt;
  readProgress.max = READ_SECONDS;
  updateCountdown(READ_SECONDS);
  burnInterval = window.setInterval(() => {
    const elapsed = (performance.now() - burnStartedAt) / 1000;
    const remaining = READ_SECONDS - elapsed;
    updateCountdown(remaining);
    if (remaining <= 0) {
      clearReadingTimers();
      destroyContent();
    }
  }, 250);
}

function updateTimedExpiryText(expiresAt) {
  if (contentClosed) return;
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) {
    showClosed('expired');
    return;
  }
  timedExpiryText.textContent = `Cette note expirera le ${formatDate(expiresAt)} (dans ${formatShortRemaining(expiresAt)}).`;
}

function scheduleTimedExpiry(expiresAt) {
  window.clearTimeout(expiryTimer);
  window.clearInterval(timedRefreshInterval);

  updateTimedExpiryText(expiresAt);
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) {
    showClosed('expired');
    return;
  }

  expiryTimer = window.setTimeout(
    () => showClosed('expired'),
    Math.min(remaining + 250, 2_147_000_000)
  );
  timedRefreshInterval = window.setInterval(() => updateTimedExpiryText(expiresAt), 30_000);
}

function displayContent(payload, plaintext) {
  const isBurn = payload.mode === 'burn';
  noteMeta = payload;

  noteContent.textContent = plaintext;
  contentModeLabel.textContent = isBurn ? 'Lecture unique' : 'Note à durée limitée';
  contentExpiry.textContent = isBurn
    ? 'Supprimée du serveur'
    : `Expire le ${formatDate(payload.expiresAt)}`;

  burnFooter.hidden = !isBurn;
  timedFooter.hidden = isBurn;
  contentClosed = false;
  contentRevealed = true;
  showOnly(contentState);
  document.title = 'Votre note — QuickNote';
  window.scrollTo({ top: 0, behavior: 'auto' });

  if (isBurn) {
    stripKeyFromUrl();
    startBurnTimer();
  } else {
    scheduleTimedExpiry(payload.expiresAt);
  }

  window.requestAnimationFrame(() => noteContent.focus());
}

function mapApiError(error, fallbackTitle = 'Impossible d’ouvrir la note.') {
  const status = error?.status;

  if (status === 404) {
    return {
      title: 'Cette note est introuvable.',
      message:
        'Le lien est incorrect ou la note a déjà été lue et détruite. Demandez un nouveau lien à son expéditeur.',
      retry: false
    };
  }
  if (status === 410) {
    return {
      title: 'Cette note a expiré.',
      message:
        'Le délai de lecture est terminé. Le message a été supprimé et ne peut plus être consulté.',
      retry: false
    };
  }
  if (status === 403) {
    return {
      title: 'Clé de déchiffrement incorrecte.',
      message:
        'Le lien est incomplet ou a été modifié. La note n’a pas été détruite : utilisez le lien original.',
      retry: false
    };
  }
  if (status === 429) {
    return {
      title: 'Trop de tentatives.',
      message: 'Patientez quelques secondes avant de réessayer.',
      retry: true
    };
  }
  if (status === 0) {
    return {
      title: 'Connexion impossible.',
      message:
        'Le serveur QuickNote est injoignable. Vérifiez votre connexion, puis réessayez.',
      retry: true
    };
  }

  return {
    title: fallbackTitle,
    message: error?.message || 'Une erreur inattendue est survenue. Réessayez dans un instant.',
    retry: true
  };
}

async function revealNote({ fromButton = false } = {}) {
  if (!noteMeta) return;

  if (fromButton) setButtonLoading(revealBtn, true, 'Déchiffrement…');

  let keyHash;
  try {
    keyHash = await hashEncryptionKey(noteKey);
  } catch {
    if (fromButton) setButtonLoading(revealBtn, false, '');
    showError(
      'Lien incomplet.',
      'La clé de déchiffrement est invalide. Demandez le lien original à son expéditeur.',
      { retry: false }
    );
    return;
  }

  let payloadReceived = false;

  try {
    const payload = await api(`/api/notes/${noteId}/reveal`, {
      method: 'POST',
      body: { keyHash }
    });
    payloadReceived = true;
    const plaintext = await decryptPayload(payload, noteKey);
    displayContent(payload, plaintext);
  } catch (error) {
    if (payloadReceived && noteMeta?.mode === 'burn') {
      showError(
        'Déchiffrement impossible.',
        'La note a été consommée du serveur, mais son contenu n’a pas pu être déchiffré. Le lien a peut-être été altéré.',
        { retry: false }
      );
    } else {
      const mapped = mapApiError(error);
      showError(mapped.title, mapped.message, { retry: mapped.retry });
    }
  } finally {
    if (fromButton) setButtonLoading(revealBtn, false, '');
  }
}

async function initialize() {
  if (!noteId) {
    showError(
      'Lien invalide.',
      'Cette adresse ne contient pas d’identifiant de note valide. Vérifiez que le lien est complet.',
      { retry: false }
    );
    return;
  }

  if (!noteKey) {
    showError(
      'Lien incomplet.',
      'La clé de déchiffrement est absente. Le lien a probablement été tronqué : demandez le lien complet à son expéditeur.',
      { retry: false }
    );
    return;
  }

  if (!isCryptoAvailable()) {
    showError(
      'Navigateur non sécurisé.',
      'Le déchiffrement nécessite une connexion HTTPS (ou localhost). Ouvrez ce lien dans un contexte sécurisé.',
      { retry: false }
    );
    return;
  }

  showOnly(loadingState);

  try {
    const status = await api(`/api/notes/${noteId}`);
    noteMeta = status;

    if (status.mode === 'timed') {
      await revealNote();
      return;
    }

    introExpiry.textContent = `Si elle n’est pas lue, elle expirera le ${formatDate(status.expiresAt)}.`;
    showOnly(introState);
    document.title = 'Une note vous attend — QuickNote';
  } catch (error) {
    const mapped = mapApiError(error);
    showError(mapped.title, mapped.message, { retry: mapped.retry });
  }
}

revealBtn.addEventListener('click', () => revealNote({ fromButton: true }));
destroyBtn.addEventListener('click', destroyContent);
retryBtn.addEventListener('click', () => window.location.reload());

window.addEventListener('pagehide', () => {
  clearReadingTimers();
  if (noteMeta?.mode === 'burn' && contentRevealed && !contentClosed) {
    noteContent.textContent = '';
  }
});

window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;

  if (noteMeta?.mode === 'burn' && contentRevealed && !contentClosed) {
    showClosed('burn');
    return;
  }

  if (noteMeta?.mode === 'timed' && !contentClosed) {
    const remaining = new Date(noteMeta.expiresAt).getTime() - Date.now();
    if (remaining <= 0) showClosed('expired');
    else scheduleTimedExpiry(noteMeta.expiresAt);
  }
});

initialize();
