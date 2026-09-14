// Minimal server-side forwarder for LLM providers (like IFM) that block direct
// browser/extension-origin requests. The real provider API key lives only here,
// as an encrypted Cloudflare Worker secret — it never touches the browser.
//
// The extension authenticates to THIS proxy with a separate shared secret
// (PROXY_SHARED_SECRET), which is not the provider's real API key.

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}

function jsonResponse(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

async function forward(request, env, upstreamPath, method) {
  const upstream = await fetch(`${env.PROVIDER_BASE_URL}${upstreamPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.PROVIDER_API_KEY}`,
    },
    body: method === 'GET' ? undefined : await request.text(),
  });
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!env.PROXY_SHARED_SECRET || token !== env.PROXY_SHARED_SECRET) {
      return jsonResponse({ error: 'Unauthorized' }, 401, env);
    }

    const url = new URL(request.url);
    if (url.pathname === '/chat/completions' && request.method === 'POST') {
      return forward(request, env, '/chat/completions', 'POST');
    }
    if (url.pathname === '/models' && request.method === 'GET') {
      return forward(request, env, '/models', 'GET');
    }
    return jsonResponse({ error: 'Not found' }, 404, env);
  },
};
