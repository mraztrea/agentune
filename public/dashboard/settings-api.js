import { dashboardFetch } from './auth.js';

export async function fetchDatabaseStats() {
  const response = await dashboardFetch('/api/database/stats');
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message ?? 'Failed to load database stats.');
  }
  return data.stats;
}

export async function postDatabaseAction(actionId) {
  const response = await dashboardFetch(`/api/database/${actionId}`, { method: 'POST' });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message ?? 'Database cleanup failed.');
  }
  return data;
}

export async function savePersonaTaste(taste) {
  const response = await dashboardFetch('/api/persona', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taste }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message ?? 'Persona save failed.');
  }
  return data;
}

export async function requestDaemonStop() {
  const response = await dashboardFetch('/api/daemon/stop', { method: 'POST' });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message ?? 'Daemon stop failed.');
  }
  return data;
}
