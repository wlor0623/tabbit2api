const BRIDGE_ORIGIN = process.env.BRIDGE_ORIGIN ?? 'http://127.0.0.1:8787';
const MODEL = process.env.MODEL ?? 'GLM-5.2';
const PROMPT = process.argv.slice(2).join(' ') || '写一句简短的欢迎语';

console.log(`Bridge: ${BRIDGE_ORIGIN}`);
console.log(`Model: ${MODEL}`);
console.log(`Prompt: ${PROMPT}`);
console.log('');

await checkHealth();
await checkChatCompletion();

async function checkHealth() {
  console.log('[1/2] 检查 bridge /health ...');

  const response = await fetch(`${BRIDGE_ORIGIN}/health`);
  const body = await response.json();

  console.log(JSON.stringify(body, null, 2));

  if (!response.ok || !body.ok) {
    throw new Error('bridge 健康检查失败，请确认 npm run start:bridge 已启动。');
  }

  if (!body.tabbitPageActive) {
    throw new Error('Tabbit 页面 worker 未激活：请打开 https://web.tabbit.ai/newtab，确认右侧显示 Bridge 已就绪。');
  }

  console.log('bridge 和 Tabbit 页面 worker 正常。');
  console.log('');
}

async function checkChatCompletion() {
  console.log('[2/2] 测试 /v1/chat/completions ...');

  const response = await fetch(`${BRIDGE_ORIGIN}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [{ role: 'user', content: PROMPT }],
    }),
  });

  const rawText = await response.text();
  const body = parseJson(rawText);

  console.log(JSON.stringify(body, null, 2));

  if (!response.ok) {
    throw new Error(body?.error?.message ?? rawText);
  }

  const answer = body?.choices?.[0]?.message?.content;
  if (!answer) {
    throw new Error('响应里没有 choices[0].message.content。');
  }

  console.log('');
  console.log('测试成功，Tabbit 页面接收状态：');
  console.log(answer);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
