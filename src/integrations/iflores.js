// Cliente da API da iFlores (sistema de gestão da floricultura).
// O contrato esperado está em docs/INTEGRACAO-IFLORES.md. Enquanto a loja não estiver
// conectada, usamos um catálogo de demonstração para que os agentes funcionem de ponta a ponta.

const DEMO_PRODUCTS = [
  { id: 'p1', nome: 'Buquê 12 Rosas Vermelhas', preco: 189.9, categoria: 'buques', estoque: 14, descricao: 'Clássico buquê com 12 rosas colombianas vermelhas, folhagens e papel kraft.', imagem_url: '', tags: ['romantico', 'namorados', 'aniversario'] },
  { id: 'p2', nome: 'Arranjo Girassóis Alegria', preco: 149.9, categoria: 'arranjos', estoque: 9, descricao: '6 girassóis em vaso de vidro com laço amarelo.', imagem_url: '', tags: ['alegria', 'amizade', 'melhoras'] },
  { id: 'p3', nome: 'Orquídea Phalaenopsis Branca', preco: 129.9, categoria: 'plantas', estoque: 20, descricao: 'Orquídea com 2 hastes em cachepô de cerâmica.', imagem_url: '', tags: ['elegante', 'maes', 'corporativo'] },
  { id: 'p4', nome: 'Cesta Café da Manhã com Flores', preco: 259.9, categoria: 'cestas', estoque: 6, descricao: 'Cesta com mini buquê, pães, frutas, suco e chocolates.', imagem_url: '', tags: ['maes', 'aniversario', 'surpresa'] },
  { id: 'p5', nome: 'Box Rosas & Ferrero', preco: 219.9, categoria: 'presentes', estoque: 11, descricao: 'Caixa com 9 rosas e 8 bombons Ferrero Rocher.', imagem_url: '', tags: ['romantico', 'namorados'] },
  { id: 'p6', nome: 'Mini Buquê Campestre', preco: 79.9, categoria: 'buques', estoque: 25, descricao: 'Flores do campo sortidas, ideal para um carinho rápido.', imagem_url: '', tags: ['carinho', 'economico'] },
];
const ADDONS = [
  { id: 'a1', nome: 'Cartão personalizado', preco: 9.9 },
  { id: 'a2', nome: 'Caixa de bombons', preco: 39.9 },
  { id: 'a3', nome: 'Pelúcia urso 25cm', preco: 59.9 },
];

export class IFloresClient {
  constructor(tenant) {
    this.tenant = tenant;
    this.cfg = tenant?.iflores || {};
    this.demo = !(this.cfg.base_url && this.cfg.token);
  }

  async #req(method, path, body) {
    const res = await fetch(this.cfg.base_url.replace(/\/$/, '') + path, {
      method,
      headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`iFlores API ${method} ${path} -> ${res.status}`);
    return res.json();
  }

  async ping() {
    if (this.demo) return { ok: true, demo: true, loja: this.tenant?.name };
    return this.#req('GET', '/v1/store');
  }

  async searchProducts({ busca = '', categoria, preco_max, ocasiao, limite = 6 } = {}) {
    if (!this.demo) {
      const q = new URLSearchParams(Object.entries({ q: busca, categoria, preco_max, ocasiao, limit: limite }).filter(([, v]) => v != null && v !== ''));
      return this.#req('GET', `/v1/products?${q}`);
    }
    const terms = busca.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').split(/\s+/).filter(Boolean);
    const norm = (s) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    let list = DEMO_PRODUCTS.filter((p) => {
      const hay = norm(`${p.nome} ${p.descricao} ${p.categoria} ${p.tags.join(' ')}`);
      return (!terms.length || terms.some((t) => hay.includes(t)))
        && (!categoria || p.categoria === categoria)
        && (!preco_max || p.preco <= preco_max)
        && (!ocasiao || p.tags.includes(norm(ocasiao)));
    });
    if (!list.length) list = DEMO_PRODUCTS;
    return { items: list.slice(0, limite), addons: ADDONS };
  }

  async getProduct(id) {
    if (!this.demo) return this.#req('GET', `/v1/products/${encodeURIComponent(id)}`);
    return DEMO_PRODUCTS.find((p) => p.id === id) || null;
  }

  async listProducts() {
    if (!this.demo) return (await this.#req('GET', '/v1/products?limit=100')).items;
    return DEMO_PRODUCTS;
  }

  async deliveryQuote({ cep, bairro, data }) {
    if (!this.demo) return this.#req('POST', '/v1/delivery/quote', { cep, bairro, data });
    const digits = String(cep || '').replace(/\D/g, '');
    const fee = digits ? 12 + (Number(digits.slice(-2)) % 4) * 5 : 15;
    return { disponivel: true, taxa: fee, prazo: 'mesmo dia (pedidos até 15h)', janelas: ['09h-12h', '12h-15h', '15h-18h'] };
  }

  async createOrder(order) {
    if (!this.demo) return this.#req('POST', '/v1/orders', order);
    const total = (order.itens || []).reduce((s, i) => s + (i.preco || 0) * (i.quantidade || 1), 0) + (order.taxa_entrega || 0);
    const id = 'PED' + Math.floor(Math.random() * 90000 + 10000);
    return { id, status: 'aguardando_pagamento', total: Math.round(total * 100) / 100, link_pagamento: `https://pagar.iflores.app.br/demo/${id}`, rastreio_url: `https://rastreio.iflores.app.br/demo/${id}` };
  }

  async getOrder(id) {
    if (!this.demo) return this.#req('GET', `/v1/orders/${encodeURIComponent(id)}`);
    return { id, status: 'em_rota', previsao: 'hoje entre 15h e 18h', rastreio_url: `https://rastreio.iflores.app.br/demo/${id}` };
  }

  /** Vendas do período: usado pelo Gerente (metas) e pelo Tráfego (ROAS real). */
  async salesSummary({ from, to }) {
    if (!this.demo) return this.#req('GET', `/v1/reports/sales?from=${from}&to=${to}`);
    const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 864e5));
    const pedidos = Math.round(days * 7.4);
    const faturamento = Math.round(pedidos * 163.5);
    return { faturamento, pedidos, ticket_medio: Math.round((faturamento / pedidos) * 100) / 100, por_canal: { whatsapp: 0.46, site: 0.31, balcao: 0.23 }, demo: true };
  }
}
