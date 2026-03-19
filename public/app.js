const elements = {
  artist: document.querySelector('[data-artist]'),
  art: document.querySelector('[data-art]'),
  currentTime: document.querySelector('[data-current-time]'),
  duration: document.querySelector('[data-duration]'),
  mute: document.querySelector('[data-mute]'),
  progress: document.querySelector('[data-progress]'),
  queue: document.querySelector('[data-queue]'),
  state: document.querySelector('[data-state]'),
  title: document.querySelector('[data-title]'),
  volume: document.querySelector('[data-volume]'),
  taste: document.querySelector('[data-taste]'),
  saveTaste: document.querySelector('[data-save-taste]'),
  personaMessage: document.querySelector('[data-persona-message]'),
  traitExplorationInput: document.querySelector('[data-trait-exploration-input]'),
  traitExplorationVal: document.querySelector('[data-trait-exploration-val]'),
  traitVarietyInput: document.querySelector('[data-trait-variety-input]'),
  traitVarietyVal: document.querySelector('[data-trait-variety-val]'),
  traitLoyaltyInput: document.querySelector('[data-trait-loyalty-input]'),
  traitLoyaltyVal: document.querySelector('[data-trait-loyalty-val]'),
};

let socket;
let traitsDirty = false;

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function renderQueue(queue) {
  if (queue.length === 0) {
    elements.queue.innerHTML = '<li class="queue-empty">Queue not wired yet</li>';
    return;
  }

  elements.queue.innerHTML = queue
    .map((item) => `<li><strong>${item.title}</strong><span>${item.artist}</span></li>`)
    .join('');
}

function renderState(state) {
  elements.title.textContent = state.title ?? 'Nothing playing';
  elements.artist.textContent = state.artist ?? 'Ask your agent to start a track';
  elements.state.textContent = state.playing ? 'Playing' : 'Idle';
  elements.currentTime.textContent = formatTime(state.position);
  elements.duration.textContent = formatTime(state.duration);
  elements.progress.style.width = `${state.duration > 0 ? (state.position / state.duration) * 100 : 0}%`;
  elements.volume.value = String(state.volume);
  elements.mute.textContent = state.muted ? 'Unmute' : 'Mute';
  elements.art.src = state.thumbnail || 'https://placehold.co/640x640/10131a/e6ecff?text=Sbotify';
  renderQueue(state.queue);
}

function connect() {
  socket = new WebSocket(`ws://${window.location.host}/ws`);

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'state') {
      renderState(payload.data);
    }
    if (payload.type === 'persona') {
      renderPersona(payload.data);
    }
  });

  socket.addEventListener('close', () => {
    window.setTimeout(connect, 1000);
  });
}

function sendSocketMessage(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

elements.volume.addEventListener('input', (event) => {
  sendSocketMessage({ type: 'volume', level: Number(event.target.value) });
});

elements.mute.addEventListener('click', () => {
  sendSocketMessage({ type: 'mute' });
});

function renderPersona(data) {
  if (data.traits && !traitsDirty) {
    renderTrait('exploration', data.traits.exploration);
    renderTrait('variety', data.traits.variety);
    renderTrait('loyalty', data.traits.loyalty);
  }
  // Don't overwrite textarea if user is editing
  if (data.taste !== undefined && document.activeElement !== elements.taste) {
    elements.taste.value = data.taste;
  }
}

function renderTrait(name, value) {
  const val = Math.round((value ?? 0.5) * 100) / 100;
  const input = elements[`trait${name.charAt(0).toUpperCase() + name.slice(1)}Input`];
  const label = elements[`trait${name.charAt(0).toUpperCase() + name.slice(1)}Val`];
  if (input && document.activeElement !== input) input.value = val.toFixed(2);
  if (label) label.textContent = val.toFixed(2);
}

function getTraitPayload() {
  return {
    exploration: Number(elements.traitExplorationInput.value),
    variety: Number(elements.traitVarietyInput.value),
    loyalty: Number(elements.traitLoyaltyInput.value),
  };
}

function syncTraitLabelsFromInputs() {
  traitsDirty = true;
  renderTrait('exploration', Number(elements.traitExplorationInput.value));
  renderTrait('variety', Number(elements.traitVarietyInput.value));
  renderTrait('loyalty', Number(elements.traitLoyaltyInput.value));
}

for (const input of [
  elements.traitExplorationInput,
  elements.traitVarietyInput,
  elements.traitLoyaltyInput,
]) {
  input.addEventListener('input', syncTraitLabelsFromInputs);
}

elements.saveTaste.addEventListener('click', () => {
  const text = elements.taste.value.trim();
  const payload = { taste: text };
  if (traitsDirty) {
    payload.traits = getTraitPayload();
  }

  fetch('/api/persona', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message ?? 'Persona save failed.');
      }
      return data;
    })
    .then((data) => {
      traitsDirty = false;
      showPersonaMessage('Persona saved.');
      if (data.traits || data.taste !== undefined) renderPersona(data);
    })
    .catch((err) => {
      showPersonaMessage(err.message ?? 'Persona save failed.', true);
      console.error('Save taste failed:', err);
    });
});

fetch('/api/status')
  .then((response) => response.json())
  .then((state) => renderState(state))
  .catch(() => {
    elements.state.textContent = 'Waiting for server';
  });

fetch('/api/persona')
  .then((response) => response.json())
  .then((data) => renderPersona(data))
  .catch(() => {});

connect();

function showPersonaMessage(message, isError = false) {
  elements.personaMessage.textContent = message;
  elements.personaMessage.classList.toggle('is-error', isError);
}
