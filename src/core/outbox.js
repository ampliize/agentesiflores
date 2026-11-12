// Fila de saída para a iFlores: tudo que os agentes criam ou alteram (clientes, pedidos, alterações
// do Alex) é enfileirado e enviado com novas tentativas. Se a iFlores estiver fora do ar, nada se perde.
import { db } from './store.js';
import { uid, now } from './util.js';

export function enfileirar(tenantId, tipo, payload, chave = null) {
  // a mesma chave substitui um item ainda pendente (ex.: várias edições do mesmo cliente)
  if (chave) {
    const pend = db().list('outbox', tenantId, (o) => o.chave === chave && o.status !== 'enviado')[0];
    if (pend) return db().put('outbox', { ...pend, payload, atualizado_em: now() });
  }
  return db().put('outbox', { id: uid('out_'), tenant_id: tenantId, tipo, chave, payload, status: 'pendente', tentativas: 0, proxima_em: now(), erro: null });
}

export const listarOutbox = (tenantId, status) => db().list('outbox', tenantId, (o) => !status || o.status === status).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
