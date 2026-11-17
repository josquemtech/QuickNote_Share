import {
  MAX_TEXT_LENGTH,
  api,
  copyToClipboard,
  createEncryptedPayload,
  formatDate,
  isCryptoAvailable,
  setButtonLoading,
  showToast
} from './common.js';

const TTL_LABELS = {
  '3600': '1 heure',
  '86400': '24 heures',
  '604800': '7 jours'
};

const form = document.getElementById('note-form');
const textarea = document.getElementById('note-content');
const charCount = document.getElementById('char-count');
const formError = document.getElementById('form-error');
const submitBtn = document.getElementById('submit-btn');
const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
const ttlInputs = [...document.querySelectorAll('input[name="ttl"]')];
const modeCards = [...document.querySelectorAll('.mode-card')];
const ttlPanel = document.getElementById('ttl-panel');
const createView = document.getElementById('create-view');
const resultView = document.getElementById('result-view');
const howSection = document.getElementById('how-section');
const resultTitle = document.getElementById('result-title');
const summaryMode = document.getElementById('summary-mode');
const summarySize = document.getElementById('summary-size');
const summaryExpiry = document.getElementById('summary-expiry');
const shareLink = document.getElementById('share-link');
const copyBtn = document.getElementById('copy-btn');
const copyLabel = copyBtn.querySelector('[data-copy-label]');
const shareBtn = document.getElementById('share-btn');
const whatsappLink = document.getElementById('whatsapp-link');
const emailLink = document.getElementById('email-link');
const smsLink = document.getElementById('sms-link');
const newNoteBtn = document.getElementById('new-note-btn');

const numberFormatter = new Intl.NumberFormat('fr-FR');
let activeResult = null;
let copyResetTimer = 0;

function updateCharCount() {
  const length = textarea.value.length;
  charCount.textContent = `${numberFormatter.format(length)} / ${numberFormatter.format(MAX_TEXT_LENGTH)}`;
}

function updateModeUI() {
  const selected = modeInputs.find((input) => input.checked)?.value || 'burn';

  modeCards.forEach((card) => {
    const input = card.querySelector('input[name="mode"]');
    card.classList.toggle('is-selected', input.checked);
  });

  ttlPanel.hidden = selected !== 'timed';
  if (selected === 'timed') {
    const selectedTtl = ttlInputs.find((input) => input.checked);
    if (!selectedTtl) ttlInputs[1].checked = true;
  }
}

function showFormError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function clearFormError() {
  formError.hidden = true;
  formError.textContent = '';
}

function getSelectedTtl() {
  return ttlInputs.find((input) => input.checked)?.value || '86400';
}

function buildShareMessage(result) {
  if (result.mode === 'burn') {
    return 'Je t’ai laissé une note privée sur QuickNote. Elle sera détruite après sa première lecture :';
  }
  const label = TTL_LABELS[result.ttl] || 'quelques instants';
  return `Je t’ai laissé une note privée sur QuickNote. Elle expirera dans ${label.toLowerCase()} :`;
}

function updateShareLinks(result) {
  const message = `${buildShareMessage(result)} ${result.link}`;
  whatsappLink.href = `https://wa.me/?text=${encodeURIComponent(message)}`;
  emailLink.href = `mailto:?subject=${encodeURIComponent('Une note privée pour vous')}&body=${encodeURIComponent(message)}`;
  smsLink.href = `sms:?&body=${encodeURIComponent(message)}`;
}

function showResult(result) {
  activeResult = result;
  createView.hidden = true;
  howSection.hidden = true;
  resultView.hidden = false;

  summaryMode.textContent =
    result.mode === 'burn' ? 'Après lecture' : TTL_LABELS[result.ttl] || 'Minuterie';
  summarySize.textContent = `${numberFormatter.format(result.characterCount)} caractère${result.characterCount > 1 ? 's' : ''}`;
  summaryExpiry.textContent = formatDate(result.expiresAt);
  shareLink.value = result.link;
  copyLabel.textContent = 'Copier';
  updateShareLinks(result);

  document.title = 'Votre lien est prêt — QuickNote';
  window.scrollTo({ top: 0, behavior: 'auto' });
  window.requestAnimationFrame(() => resultTitle.focus());
}

function resetForm() {
  form.reset();
  textarea.value = '';
  activeResult = null;
  clearFormError();
  updateCharCount();
  updateModeUI();
  resultView.hidden = true;
  createView.hidden = false;
  howSection.hidden = false;
  shareLink.value = '';
  copyLabel.textContent = 'Copier';
  document.title = 'QuickNote — Un mot. Un lien. Puis plus rien.';
  window.scrollTo({ top: 0, behavior: 'auto' });

  window.requestAnimationFrame(() => {
    textarea.focus({ preventScroll: true });
  });
}

async function handleCopy() {
  if (!activeResult) return;

  try {
    await copyToClipboard(activeResult.link);
    copyLabel.textContent = 'Copié !';
    showToast('Lien copié dans le presse-papiers.');
    window.clearTimeout(copyResetTimer);
    copyResetTimer = window.setTimeout(() => {
      copyLabel.textContent = 'Copier';
    }, 2400);
  } catch {
    showToast('Impossible de copier automatiquement. Sélectionnez le lien et copiez-le.');
    shareLink.focus();
    shareLink.select();
  }
}

async function handleShare() {
  if (!activeResult) return;

  if (navigator.share) {
    try {
      await navigator.share({
        title: 'Une note privée sur QuickNote',
        text: buildShareMessage(activeResult),
        url: activeResult.link
      });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }

  try {
    await copyToClipboard(activeResult.link);
    showToast('Lien copié. Partagez-le où vous voulez.');
  } catch {
    showToast('Sélectionnez le lien ci-dessus pour le partager.');
    shareLink.focus();
    shareLink.select();
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFormError();

  if (submitBtn.disabled) return;

  const text = textarea.value;
  if (text.trim().length === 0) {
    showFormError('Écrivez un message avant de créer le lien.');
    textarea.focus();
    return;
  }

  if (!isCryptoAvailable()) {
    showFormError(
      'Le chiffrement nécessite une connexion sécurisée. Ouvrez QuickNote en HTTPS (ou sur localhost) pour protéger votre note.'
    );
    return;
  }

  const mode = modeInputs.find((input) => input.checked)?.value || 'burn';
  const ttl = getSelectedTtl();

  setButtonLoading(submitBtn, true, 'Chiffrement en cours…');

  try {
    const encrypted = await createEncryptedPayload(text);
    const body = {
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      keyHash: encrypted.keyHash,
      mode
    };
    if (mode === 'timed') body.ttl = Number.parseInt(ttl, 10);

    const note = await api('/api/notes', { method: 'POST', body });
    showResult({
      id: note.id,
      mode: note.mode,
      ttl,
      createdAt: note.createdAt,
      expiresAt: note.expiresAt,
      link: `${window.location.origin}/n/${note.id}#${encrypted.key}`,
      characterCount: text.length
    });
  } catch (error) {
    showFormError(
      error?.message ||
        'La note n’a pas pu être créée. Vérifiez votre connexion et réessayez.'
    );
  } finally {
    setButtonLoading(submitBtn, false, '');
  }
});

textarea.addEventListener('input', () => {
  updateCharCount();
  if (!formError.hidden) clearFormError();
});

textarea.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    form.requestSubmit();
  }
});

modeInputs.forEach((input) => input.addEventListener('change', updateModeUI));
copyBtn.addEventListener('click', handleCopy);
shareBtn.addEventListener('click', handleShare);
newNoteBtn.addEventListener('click', resetForm);

shareLink.addEventListener('focus', () => shareLink.select());
shareLink.addEventListener('click', () => shareLink.select());

updateCharCount();
updateModeUI();
