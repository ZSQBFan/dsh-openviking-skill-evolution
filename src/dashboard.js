export const DASHBOARD_PATH = '/api/dsh-openviking-skill-evolution/dashboard';

const ACTIONS = new Set([
  'run', 'settings', 'preview', 'applyDraft', 'approve', 'reject', 'rollback',
  'curator', 'adopt', 'archive', 'restore', 'clearProposals', 'clearHistory',
]);

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

function failure(error, status) {
  return json({ ok: false, error }, status);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mountDashboard(ctx, { snapshot, actions }) {
  if (typeof snapshot !== 'function' || !isRecord(actions)) throw new TypeError('Invalid dashboard service');
  const operations = new Map(Object.entries(actions).filter(([action, handler]) => ACTIONS.has(action) && typeof handler === 'function'));
  return ctx.connection.fetch.register({
    path: DASHBOARD_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request.method === 'GET') {
          const sessionId = new URL(request.url).searchParams.get('sessionId')?.trim();
          if (sessionId?.length > 512) return failure('badRequest', 400);
          const data = await snapshot({ signal: request.signal, sessionId: sessionId || undefined });
          const capabilities = Object.fromEntries([...operations.keys()].map(key => [key, data.capabilities?.[key] === true]));
          return json({ ok: true, data: { ...data, capabilities } });
        }
        if (request.method !== 'POST') return failure('method', 405);
        const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
        if (mediaType !== 'application/json') return failure('mediaType', 415);
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > 16_384) return failure('tooLarge', 413);
        let body;
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { return failure('badRequest', 400); }
        if (!isRecord(body) || typeof body.action !== 'string' || !isRecord(body.input)) {
          return failure('badRequest', 400);
        }
        const { action, input } = body;
        const handler = operations.get(action);
        if (!handler) return failure('forbidden', 403);
        const data = await snapshot({ signal: request.signal });
        if (data.capabilities?.[action] !== true) return failure('forbidden', 403);
        request.signal.throwIfAborted();
        const result = await handler(input, { signal: request.signal });
        return json({ ok: true, data: result ?? null });
      } catch {
        return failure('operationFailed', 500);
      }
    },
  });
}
