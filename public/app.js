const elements = {
  artist: document.querySelector('[data-artist]'),
  art: document.querySelector('[data-art]'),
  currentTime: document.querySelector('[data-current-time]'),
  duration: document.querySelector('[data-duration]'),
  lane: document.querySelector('[data-lane]'),
  mute: document.querySelector('[data-mute]'),
  progress: document.querySelector('[data-progress]'),
  queue: document.querySelector('[data-queue]'),
  state: document.querySelector('[data-state]'),
  title: document.querySelector('[data-title]'),
  volume: document.querySelector('[data-volume]'),
};

let socket;

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
  elements.lane.textContent = state.lane ? `${state.lane.description} (${state.lane.songCount} tracks)` : 'No lane';
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

fetch('/api/status')
  .then((response) => response.json())
  .then((state) => renderState(state))
  .catch(() => {
    elements.state.textContent = 'Waiting for server';
  });

connect();
