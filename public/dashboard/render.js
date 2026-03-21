import { DATABASE_ACTION_LABELS, PLACEHOLDER_ARTWORK, STOP_DAEMON_LABEL } from './constants.js';
import { elements } from './dom.js';
import { renderInsights } from './insights.js';
import { createTitleMarquee } from './marquee.js';
import { applyPlaybackVisualState } from './playback-visual-state.js';
import { syncTasteTextareaHeight } from './taste-textarea.js';
import { buildArtworkUrl, createAmbientThemeManager } from './theme.js';
import { toggleHiddenAttribute } from './toggle-hidden-attribute.js';

const ambientTheme = createAmbientThemeManager();
const titleMarquee = createTitleMarquee(elements);

let lastArtwork = '';
let lastTitle = '';
let lastArtist = '';
const PLACEHOLDER_ARTWORK_URL = new URL(PLACEHOLDER_ARTWORK, window.location.href).href;

applyPlaybackVisualState(document.documentElement, false, false);

function formatPlaybackTime(seconds) {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function setArtworkSource(image, source) {
  image.dataset.fallbackSource = source ?? '';
  image.dataset.fallbackTried = 'false';
  image.src = source ? buildArtworkUrl(source) : PLACEHOLDER_ARTWORK;
}

function renderQueueCurrent(title, artist) {
  elements.queueCurrentTitle.textContent = title;
  elements.queueCurrentArtist.textContent = artist;
}

function renderPlaybackProgress(position, duration) {
  const safePosition = Math.max(0, Math.round(position));
  const safeDuration = Math.max(safePosition, Math.round(duration));
  const progress = safeDuration > 0 ? Math.min(100, (safePosition / safeDuration) * 100) : 0;

  elements.durationFill.style.width = `${progress}%`;
  elements.elapsed.textContent = formatPlaybackTime(safePosition);
  elements.totalDuration.textContent = formatPlaybackTime(safeDuration);
}

function setPauseButtonState(hasTrack, isPlaying) {
  const pauseIcon = elements.pause.querySelector('.icon-pause');
  const playIcon = elements.pause.querySelector('.icon-play');
  const shouldShowPauseIcon = !hasTrack || isPlaying;
  const shouldShowPlayIcon = hasTrack && !isPlaying;
  const pauseLabel = hasTrack && !isPlaying ? 'Resume playback' : 'Pause playback';

  elements.pause.disabled = !hasTrack;
  elements.pause.setAttribute('aria-label', pauseLabel);

  if (pauseIcon instanceof SVGElement) {
    toggleHiddenAttribute(pauseIcon, !shouldShowPauseIcon);
  }
  if (playIcon instanceof SVGElement) {
    toggleHiddenAttribute(playIcon, !shouldShowPlayIcon);
  }
}

export function renderQueue(queue) {
  elements.queue.replaceChildren();
  if (queue.length === 0) {
    const emptyItem = document.createElement('li');
    emptyItem.className = 'queue-empty';
    emptyItem.textContent = 'Queue is empty';
    elements.queue.append(emptyItem);
    return;
  }

  queue.forEach((item, index) => {
    const listItem = document.createElement('li');
    const title = document.createElement('strong');
    const artist = document.createElement('span');

    title.textContent = item.title;
    artist.textContent = item.artist;
    listItem.append(title, artist);
    elements.queue.append(listItem);
  });
}

export function renderState(state) {
  const title = state.title ?? 'Nothing playing';
  const artist = state.artist ?? 'Ask your agent to start a track';
  const hasTrack = state.title !== null;

  if (title !== lastTitle) {
    titleMarquee.setText(title);
    renderQueueCurrent(title, artist);
    lastTitle = title;
  }

  if (artist !== lastArtist) {
    elements.artist.textContent = artist;
    elements.queueCurrentArtist.textContent = artist;
    lastArtist = artist;
  }

  if (state.thumbnail !== lastArtwork) {
    setArtworkSource(elements.art, state.thumbnail);
    setArtworkSource(elements.queueArt, state.thumbnail);
    void ambientTheme.sync(state.thumbnail);
    lastArtwork = state.thumbnail;
  }

  elements.volume.value = String(state.volume);
  elements.volume.style.setProperty('--volume-progress', `${state.volume}%`);
  renderPlaybackProgress(state.position, state.duration);
  elements.next.disabled = state.queue.length === 0;
  applyPlaybackVisualState(document.documentElement, hasTrack, state.playing);
  setPauseButtonState(hasTrack, state.playing);
  renderQueue(state.queue);
}

export function renderPersona(data) {
  if (data.taste !== undefined && document.activeElement !== elements.taste) {
    elements.taste.value = data.taste;
    syncTasteTextareaHeight(elements.taste);
  }
}

export function renderDatabaseStats(stats) {
  elements.databasePath.textContent = stats.dbPath;
  elements.databasePlays.textContent = String(stats.counts.plays);
  elements.databaseTracks.textContent = String(stats.counts.tracks);
  elements.databaseProviderCache.textContent = String(stats.counts.providerCache);
  renderInsights(stats);
}

export function resetDangerActionLabels() {
  elements.databaseActions.forEach((button) => {
    button.classList.remove('is-armed');
    button.textContent = DATABASE_ACTION_LABELS[button.dataset.dbAction];
  });
  elements.stopDaemon.classList.remove('is-armed');
  elements.stopDaemon.textContent = STOP_DAEMON_LABEL;
}

export function setDangerActionArmed(button, text) {
  button.classList.add('is-armed');
  button.textContent = text;
}

export function setActiveView(view) {
  elements.navButtons.forEach((button) => {
    const isActive = button.dataset.nav === view;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  elements.viewPanels.forEach((panel) => {
    panel.hidden = panel.dataset.view !== view;
  });
  elements.sharedControls.hidden = view === 'settings';

  if (view === 'settings') {
    window.requestAnimationFrame(() => {
      syncTasteTextareaHeight(elements.taste);
    });
  }

  titleMarquee.refresh();
}

export function showDatabaseMessage(message, isError = false) {
  elements.databaseMessage.textContent = message;
  elements.databaseMessage.classList.toggle('is-error', isError);
}

export function showPersonaMessage(message, isError = false) {
  elements.personaMessage.textContent = message;
  elements.personaMessage.classList.toggle('is-error', isError);
}

export function applyStoppedState(message) {
  elements.pause.disabled = true;
  elements.next.disabled = true;
  elements.volume.disabled = true;
  elements.taste.disabled = true;
  elements.saveTaste.disabled = true;
  elements.stopDaemon.disabled = true;
  elements.databaseActions.forEach((button) => {
    button.disabled = true;
  });

  titleMarquee.setText('Daemon stopped');
  elements.artist.textContent = 'Run "agentune start", or open a new coding session if auto-start is enabled.';
  renderQueueCurrent('Daemon stopped', 'Run "agentune start" to bring playback back online.');
  elements.volume.value = '0';
  elements.volume.style.setProperty('--volume-progress', '0%');
  renderPlaybackProgress(0, 0);
  applyPlaybackVisualState(document.documentElement, false, false);
  setPauseButtonState(false, false);
  elements.queue.replaceChildren();

  const stoppedItem = document.createElement('li');
  stoppedItem.className = 'queue-empty';
  stoppedItem.textContent = 'Daemon is stopped';
  elements.queue.append(stoppedItem);

  showDatabaseMessage(message);
  showPersonaMessage('Daemon stopped. This page will stay offline until agentune starts again.');
}

export function applySessionExpiredState(message) {
  elements.pause.disabled = true;
  elements.next.disabled = true;
  elements.volume.disabled = true;
  elements.taste.disabled = true;
  elements.saveTaste.disabled = true;
  elements.stopDaemon.disabled = true;
  elements.databaseActions.forEach((button) => {
    button.disabled = true;
  });

  showDatabaseMessage(message, true);
  showPersonaMessage(message, true);
}

function attachArtworkFallback(image) {
  image.addEventListener('error', () => {
    const fallbackSource = image.dataset.fallbackSource ?? '';
    const fallbackTried = image.dataset.fallbackTried === 'true';
    const currentSource = image.currentSrc || image.src;

    if (fallbackSource && !fallbackTried) {
      image.dataset.fallbackTried = 'true';
      image.src = fallbackSource;
      return;
    }

    if (currentSource !== PLACEHOLDER_ARTWORK_URL) {
      image.src = PLACEHOLDER_ARTWORK;
    }
  });
}

attachArtworkFallback(elements.art);
attachArtworkFallback(elements.queueArt);
