// Cliente da API da iFlores. O contrato está em docs/INTEGRACAO-IFLORES.md.
// Sem loja conectada, a base compartilhada local (store) é a fonte de verdade (demonstração).
export class IFloresClient {
  constructor(tenant) { this.cfg = tenant?.iflores || {}; this.conectado = !!(this.cfg.base_url && this.cfg.token); }
  async req(method, path, body) {
    const res = await fetch(this.cfg.base_url.replace(/\/$/, '') + path, { method, headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`iFlores ${method} ${path}: ${res.status}`);
    return res.json();
  }
  ping() { return this.conectado ? this.req('GET', '/v1/store') : Promise.resolve({ demo: true }); }
  /** Sincroniza o catálogo, insumos e configurações para a base compartilhada. */
  async catalogo() { return this.conectado ? this.req('GET', '/v1/catalog') : null; }
  /** Envia uma alteração feita pelo Alex (produto, estoque, datas, fretes...). */
  async aplicar(change) { return this.conectado ? this.req('POST', '/v1/changes', change) : { demo: true }; }
  async criarPedido(order) { return this.conectado ? this.req('POST', '/v1/orders', order) : null; }
  /** Clientes e pedidos alterados desde o cursor: { clientes: [], pedidos: [], cursor }. */
  async alteracoesDesde(cursor) { return this.req('GET', `/v1/sync?desde=${encodeURIComponent(cursor || '')}`); }
  /** Cria ou atualiza um cliente (com id = atualiza). Retorna { id }. */
  async salvarCliente(c) { return c.id ? this.req('PUT', `/v1/customers/${encodeURIComponent(c.id)}`, c) : this.req('POST', '/v1/customers', c); }
}
