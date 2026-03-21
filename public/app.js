import { DATABASE_ACTION_LABELS, STOP_DAEMON_LABEL } from './dashboard/constants.js';
import { elements } from './dashboard/dom.js';
import {
  buildDashboardWebSocketUrl,
  DASHBOARD_SESSION_EXPIRED_MESSAGE,
  dashboardFetch,
  isDashboardSessionExpiredError,
} from './dashboard/auth.js';
import {
  applySessionExpiredState,
  applyStoppedState,
  renderDatabaseStats,
  renderPersona,
  renderState,
  resetDangerActionLabels,
  setActiveView,
  setDangerActionArmed,
  showDatabaseMessage,
  showPersonaMessage,
} from './dashboard/render.js';
import {
  fetchDatabaseStats,
  postDatabaseAction,
  requestDaemonStop,
  savePersonaTaste,
} from './dashboard/settings-api.js';
import { syncTasteTextareaHeight } from './dashboard/taste-textarea.js';

let armedDangerAction = null;
let dangerArmTimer = null;
let daemonStoppedByUser = false;
let dashboardSessionExpired = false;
let socket;
let activeView = 'player';
let lastInsightTrackKey = '';
let allowStatusBootstrap = true;

function syncVolumeSliderFill(level) {
  elements.volume.style.setProperty('--volume-progress', `${level}%`);
}

function connect() {
  if (dashboardSessionExpired) {
    return;
  }

  try {
    socket = new WebSocket(buildDashboardWebSocketUrl('/ws'));
  } catch {
    handleDashboardSessionExpiry();
    return;
  }

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'state') {
      allowStatusBootstrap = false;
      renderState(payload.data);
      maybeRefreshInsightsForState(payload.data);
    }
    if (payload.type === 'persona') {
      renderPersona(payload.data);
    }
  });

  socket.addEventListener('close', (event) => {
    if (event.code === 4403) {
      handleDashboardSessionExpiry();
      return;
    }

    if (!daemonStoppedByUser && !dashboardSessionExpired) {
      window.setTimeout(connect, 1000);
    }
  });
}

function sendSocketMessage(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
    return true;
  }

  return false;
}

function transitionBetweenViews(nextView) {
  const fromPlayableView = activeView === 'player' || activeView === 'queue';
  const toPlayableView = nextView === 'player' || nextView === 'queue';
  const canTransition = typeof document.startViewTransition === 'function'
    && fromPlayableView
    && toPlayableView
    && activeView !== nextView;

  if (canTransition) {
    document.startViewTransition(() => {
      setActiveView(nextView);
      activeView = nextView;
      if (nextView === 'settings') {
        void loadDatabaseStats();
      }
    });
    return;
  }

  setActiveView(nextView);
  activeView = nextView;
  if (nextView === 'settings') {
    void loadDatabaseStats();
  }
}

function clearDangerArming() {
  armedDangerAction = null;
  if (dangerArmTimer) {
    window.clearTimeout(dangerArmTimer);
    dangerArmTimer = null;
  }
  resetDangerActionLabels();
}

function armDangerAction(button, action) {
  clearDangerArming();
  armedDangerAction = action;
  const label = action.kind === 'daemon'
    ? `Confirm ${STOP_DAEMON_LABEL}`
    : `Confirm ${DATABASE_ACTION_LABELS[action.id]}`;
  setDangerActionArmed(button, label);
  showDatabaseMessage('Click the same button again within 5 seconds to confirm.');
  dangerArmTimer = window.setTimeout(() => {
    clearDangerArming();
    showDatabaseMessage('Confirmation expired.');
  }, 5000);
}

async function loadDatabaseStats(options = {}) {
  const { preserveMessage = false } = options;
  try {
    const stats = await fetchDatabaseStats();
    renderDatabaseStats(stats);
    if (!preserveMessage) {
      showDatabaseMessage('');
    }
  } catch (error) {
    if (isDashboardSessionExpiredError(error)) {
      handleDashboardSessionExpiry();
      return;
    }
    showDatabaseMessage(error.message ?? 'Failed to load database stats.', true);
  }
}

async function runDatabaseAction(actionId, button) {
  button.disabled = true;
  try {
    const data = await postDatabaseAction(actionId);
    renderDatabaseStats(data.stats);
    showDatabaseMessage(data.message ?? 'Cleanup complete.');
    clearDangerArming();
  } catch (error) {
    if (isDashboardSessionExpiredError(error)) {
      handleDashboardSessionExpiry();
      return;
    }
    showDatabaseMessage(error.message ?? 'Database cleanup failed.', true);
  } finally {
    if (!dashboardSessionExpired) {
      button.disabled = false;
      await loadDatabaseStats({ preserveMessage: true });
    }
  }
}

async function runDaemonStop(button) {
  button.disabled = true;
  try {
    const data = await requestDaemonStop();
    daemonStoppedByUser = true;
    clearDangerArming();
    socket?.close();
    applyStoppedState(data.message ?? 'Daemon stop requested.');
  } catch (error) {
    if (isDashboardSessionExpiredError(error)) {
      handleDashboardSessionExpiry();
      return;
    }
    clearDangerArming();
    button.disabled = false;
    showDatabaseMessage(error.message ?? 'Daemon stop failed.', true);
  }
}

function maybeRefreshInsightsForState(state) {
  const nextTrackKey = `${state.title ?? ''}::${state.artist ?? ''}`;
  const trackChanged = nextTrackKey !== lastInsightTrackKey;
  lastInsightTrackKey = nextTrackKey;

  if (activeView === 'settings' && trackChanged) {
    void loadDatabaseStats();
  }
}

function handleDashboardSessionExpiry() {
  if (dashboardSessionExpired) {
    return;
  }

  dashboardSessionExpired = true;
  clearDangerArming();
  applySessionExpiredState(DASHBOARD_SESSION_EXPIRED_MESSAGE);
}

elements.navButtons.forEach((button) => {
  button.addEventListener('click', () => {
    transitionBetweenViews(button.dataset.nav ?? 'player');
  });
});

elements.volume.addEventListener('input', (event) => {
  const level = Number(event.target.value);
  syncVolumeSliderFill(level);
  if (sendSocketMessage({ type: 'volume', level })) {
    allowStatusBootstrap = false;
  }
});

elements.taste.addEventListener('input', () => {
  syncTasteTextareaHeight(elements.taste);
});

elements.pause.addEventListener('click', () => {
  if (elements.pause.disabled) {
    return;
  }
  if (sendSocketMessage({ type: 'playback-toggle' })) {
    allowStatusBootstrap = false;
  }
});

elements.next.addEventListener('click', () => {
  if (sendSocketMessage({ type: 'next' })) {
    allowStatusBootstrap = false;
  }
});

elements.saveTaste.addEventListener('click', async () => {
  try {
    const data = await savePersonaTaste(elements.taste.value.trim());
    showPersonaMessage('Persona saved.');
    renderPersona(data);
  } catch (error) {
    if (isDashboardSessionExpiredError(error)) {
      handleDashboardSessionExpiry();
      return;
    }
    showPersonaMessage(error.message ?? 'Persona save failed.', true);
  }
});

elements.databaseActions.forEach((button) => {
  button.addEventListener('click', async () => {
    const actionId = button.dataset.dbAction;
    const action = { kind: 'database', id: actionId };
    if (!actionId) {
      return;
    }
    if (armedDangerAction?.kind !== action.kind || armedDangerAction?.id !== action.id) {
      armDangerAction(button, action);
      return;
    }
    await runDatabaseAction(actionId, button);
  });
});

elements.stopDaemon.addEventListener('click', async () => {
  const action = { kind: 'daemon', id: 'stop-daemon' };
  if (armedDangerAction?.kind !== action.kind) {
    armDangerAction(elements.stopDaemon, action);
    return;
  }
  await runDaemonStop(elements.stopDaemon);
});

dashboardFetch('/api/status')
  .then((response) => response.json())
  .then((state) => {
    if (!allowStatusBootstrap) {
      return;
    }
    allowStatusBootstrap = false;
    renderState(state);
    maybeRefreshInsightsForState(state);
  })
  .catch((error) => {
    if (isDashboardSessionExpiredError(error)) {
      handleDashboardSessionExpiry();
      return;
    }
    showDatabaseMessage('Waiting for server state.');
  });

dashboardFetch('/api/persona')
  .then((response) => response.json())
  .then((data) => renderPersona(data))
  .catch((error) => {
    if (isDashboardSessionExpiredError(error)) {
      handleDashboardSessionExpiry();
    }
  });

syncVolumeSliderFill(Number(elements.volume.value));
syncTasteTextareaHeight(elements.taste);
setActiveView('player');
activeView = 'player';
void loadDatabaseStats();
connect();
