/** Cliente HTTP da API: mesma origem (proxy /api), cookies de sessão e cabeçalho x-workspace-id. */
let workspaceId: string | null = null;

export function setApiWorkspace(id: string | null): void {
  workspaceId = id;
}

export function getApiWorkspace(): string | null {
  return workspaceId;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function apiHeaders(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  if (workspaceId) h.set('x-workspace-id', workspaceId);
  return h;
}

type Body = Record<string, unknown> | unknown[] | FormData | undefined;

export async function apiFetch(
  path: string,
  init: { method?: string; body?: Body; signal?: AbortSignal; headers?: HeadersInit } = {},
): Promise<Response> {
  const headers = apiHeaders(init.headers);
  let body: BodyInit | undefined;
  if (init.body instanceof FormData) body = init.body;
  else if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.body);
  }
  const res = await fetch(path, {
    method: init.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    credentials: 'include',
    signal: init.signal,
  });
  if (!res.ok) {
    let msg = res.status === 401 ? 'Faça login para continuar.' : 'Algo deu errado. Tente novamente.';
    let code: string | undefined;
    let details: unknown;
    try {
      const j = (await res.json()) as { error?: string; message?: string; code?: string; details?: unknown };
      msg = j.error ?? j.message ?? msg;
      code = j.code;
      details = j.details;
    } catch {
      /* sem corpo JSON */
    }
    throw new ApiError(res.status, msg, code, details);
  }
  return res;
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: Body; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await apiFetch(path, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Lê um corpo SSE (`data: {json}\n\n`) de um Response e chama onEvent para cada evento. */
export async function readSSE<T>(
  res: Response,
  onEvent: (e: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  const abort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', abort);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        const data = chunk
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          onEvent(JSON.parse(data) as T);
        } catch {
          /* evento malformado: ignora */
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
