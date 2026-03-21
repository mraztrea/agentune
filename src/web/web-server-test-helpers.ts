export async function getDashboardAuth(webServer: { getDashboardUrl(): string }): Promise<{
  headers: Record<string, string>;
  origin: string;
  token: string;
}> {
  const origin = new URL(webServer.getDashboardUrl()).origin;
  const response = await fetch(webServer.getDashboardUrl());
  const html = await response.text();
  const tokenMatch = html.match(/<meta name="agentune-dashboard-token" content="([^"]+)"/i);
  if (!tokenMatch?.[1]) {
    throw new Error('Dashboard auth token missing from bootstrap HTML.');
  }

  return {
    headers: {
      'Origin': origin,
      'X-Agentune-Dashboard-Token': tokenMatch[1],
    },
    origin,
    token: tokenMatch[1],
  };
}
