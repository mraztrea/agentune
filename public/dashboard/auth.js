export const DASHBOARD_SESSION_EXPIRED_MESSAGE = 'Dashboard session expired. Refresh page.';

const DASHBOARD_TOKEN_HEADER = 'X-Agentune-Dashboard-Token';
const DASHBOARD_TOKEN_META_NAME = 'agentune-dashboard-token';
const DASHBOARD_TOKEN_QUERY_PARAM = 'dashboardToken';

let cachedDashboardToken = '';

export async function dashboardFetch(input, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set(DASHBOARD_TOKEN_HEADER, getDashboardToken());

  const response = await fetch(input, {
    ...init,
    headers,
  });
  if (response.status === 403) {
    throw new Error(DASHBOARD_SESSION_EXPIRED_MESSAGE);
  }

  return response;
}

export function buildDashboardWebSocketUrl(pathname = '/ws') {
  const url = new URL(pathname, window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set(DASHBOARD_TOKEN_QUERY_PARAM, getDashboardToken());
  return url.toString();
}

export function appendDashboardTokenToPath(pathname) {
  const url = new URL(pathname, window.location.href);
  url.searchParams.set(DASHBOARD_TOKEN_QUERY_PARAM, getDashboardToken());
  return url.origin === window.location.origin
    ? `${url.pathname}${url.search}${url.hash}`
    : url.toString();
}

export function isDashboardSessionExpiredError(error) {
  return error instanceof Error && error.message === DASHBOARD_SESSION_EXPIRED_MESSAGE;
}

function getDashboardToken() {
  if (cachedDashboardToken) {
    return cachedDashboardToken;
  }

  const tokenMeta = document.querySelector(`meta[name="${DASHBOARD_TOKEN_META_NAME}"]`);
  if (!(tokenMeta instanceof HTMLMetaElement) || !tokenMeta.content) {
    throw new Error(DASHBOARD_SESSION_EXPIRED_MESSAGE);
  }

  cachedDashboardToken = tokenMeta.content;
  return cachedDashboardToken;
}
