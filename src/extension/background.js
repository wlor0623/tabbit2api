import { normalizeCookieHeader, parseTabbitSessionId } from '../shared/session.js';

const BRIDGE_SYNC_URL = 'http://127.0.0.1:8787/__sync/tabbit';
const TABBIT_ORIGIN = 'https://web.tabbit.ai';

export function extractTabbitSessionState({ url, cookies }) {
  return {
    chatSessionId: parseTabbitSessionId(url),
    cookieHeader: normalizeCookieHeader(cookies),
    referer: url,
  };
}

function isSyncableTabbitUrl(url) {
  return url === `${TABBIT_ORIGIN}/newtab` || url?.startsWith(`${TABBIT_ORIGIN}/session/`);
}

async function injectContentScript(tabId) {
  if (!tabId || !chrome.scripting) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (error) {
    console.warn('Failed to inject Tabbit OpenAI Bridge content script.', error);
  }
}

async function syncActiveTabbitSession(tab) {
  if (!isSyncableTabbitUrl(tab?.url)) return;

  await injectContentScript(tab.id);

  const cookies = await chrome.cookies.getAll({ url: TABBIT_ORIGIN });
  const state = extractTabbitSessionState({ url: tab.url, cookies });

  await fetch(BRIDGE_SYNC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
  });
}

if (globalThis.chrome?.tabs && globalThis.chrome?.cookies) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.tabs.query({ url: `${TABBIT_ORIGIN}/*` }, (tabs) => {
      for (const tab of tabs) {
        syncActiveTabbitSession(tab).catch(console.error);
      }
    });
  });

  chrome.runtime.onStartup.addListener(() => {
    chrome.tabs.query({ url: `${TABBIT_ORIGIN}/*` }, (tabs) => {
      for (const tab of tabs) {
        syncActiveTabbitSession(tab).catch(console.error);
      }
    });
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
      syncActiveTabbitSession(tab).catch(console.error);
    }
  });

  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId);
    syncActiveTabbitSession(tab).catch(console.error);
  });
}
