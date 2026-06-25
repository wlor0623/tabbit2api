import { randomUUID } from 'node:crypto';

const TABBIT_COMPLETION_URL = 'https://web.tabbit.ai/api/v1/chat/completion';

export function buildTabbitRequest(openAiBody, session) {
  const lastUserMessage = [...(openAiBody.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'user');
  const content = normalizeMessageContent(lastUserMessage?.content ?? '');

  return {
    url: TABBIT_COMPLETION_URL,
    headers: {
      cookie: session.cookieHeader,
      origin: 'https://web.tabbit.ai',
      referer: session.referer ?? 'https://web.tabbit.ai/newtab',
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: {
      chat_session_id: session.chatSessionId,
      message_id: randomUUID(),
      content,
      selected_model: openAiBody.model,
      parallel_group_id: null,
      task_name: 'chat',
      agent_mode: false,
      metadatas: { html_content: `<p>${escapeHtml(content)}</p>` },
      references: [],
      entity: { key: 'd41d8cd98f00b204e9800998ecf8427e', extras: { type: 'tab', url: '' } },
    },
  };
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part.text ?? ''))
      .join('');
  }
  return String(content ?? '');
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
