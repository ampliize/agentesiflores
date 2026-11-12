// Demonstração no navegador: o mesmo núcleo do servidor rodando em memória.
// Intercepta fetch('/api/v1/...') e o tempo real (EventSource) e encaminha para o núcleo.
import { init, rotinas } from '../src/core/index.js';
import { createMemoryStore, comLoja } from '../src/core/store.js';
import { seedDemo } from '../src/core/seed.js';
import { handle } from '../src/core/api.js';
import { bus } from '../src/core/events.js';

init(createMemoryStore());
const tenantId = seedDemo();
const ready = comLoja(tenantId, () => rotinas(tenantId, { forcar: true }));
window.__EQ_TOKEN = 'demo';

const realFetch = window.fetch.bind(window);
window.fetch = async (input, opts = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/v1')) return realFetch(input, opts);
  await ready;
  const path = url.pathname.slice('/api/v1'.length);
  if (path === '/demo') return new Response(JSON.stringify({ token: 'demo' }), { status: 200 });
  const r = await comLoja(tenantId, () => handle({ method: (opts.method || 'GET').toUpperCase(), path, query: Object.fromEntries(url.searchParams), body: opts.body ? JSON.parse(opts.body) : null, tenantId }));
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
};
window.EventSource = class { constructor() { this.off = bus.on(`t:${tenantId}`, (ev) => this.onmessage?.({ data: JSON.stringify(ev) })); } close() { this.off(); } };
// rotinas periódicas (publicação agendada, recuperação de conversas...)
setInterval(() => comLoja(tenantId, () => rotinas(tenantId)).catch(() => {}), 30000);
