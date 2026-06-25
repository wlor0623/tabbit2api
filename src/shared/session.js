export function parseTabbitSessionId(url) {
  const { pathname } = new URL(url);
  const match = pathname.match(/^\/session\/([^/]+)/);
  return match ? match[1] : null;
}

export function normalizeCookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}
