// Configuração padrão de cada agente. O dono da floricultura personaliza tudo pelo painel.
export const AGENTS = {
  gerente: {
    nome: 'Gerente',
    cargo: 'Gerente da Equipe Virtual',
    avatar: '👩‍💼',
    cor: '#7c3aed',
    descricao: 'Acompanha metas, revisa o trabalho dos outros agentes e reporta ao dono.',
  },
  trafego: {
    nome: 'Gestor de Tráfego',
    cargo: 'Especialista em Tráfego Pago',
    avatar: '📈',
    cor: '#2563eb',
    descricao: 'Cria, analisa e otimiza campanhas. Pausa o que não performa e escala o que vende.',
  },
  social: {
    nome: 'Social Media',
    cargo: 'Designer & Social Media',
    avatar: '🎨',
    cor: '#db2777',
    descricao: 'Cria artes de feed, stories e anúncios e publica automaticamente.',
  },
  atendente: {
    nome: 'Atendente',
    cargo: 'Vendedora no WhatsApp',
    avatar: '💬',
    cor: '#16a34a',
    descricao: 'Atende clientes, tira dúvidas, calcula frete e fecha pedidos pelo WhatsApp.',
  },
};

export const AGENT_KEYS = Object.keys(AGENTS);

export const DEFAULT_CONFIG = {
  gerente: {
    nome_exibicao: 'Flora',
    metas: {
      faturamento_mensal: 30000,
      pedidos_mes: 250,
      ticket_medio: 150,
      roas_minimo: 4,
      tempo_resposta_seg: 60,
      taxa_conversao_atendimento: 25,
      posts_semana: 5,
    },
    relatorio: { frequencia: 'diario', horario: '19:00', canal: 'whatsapp', whatsapp_dono: '' },
    exigencia: 'alta', // baixa | media | alta
    revisar_posts_antes_de_publicar: true,
    auditar_atendimentos: true,
    amostra_auditoria: 5,
    instrucoes: 'Priorize vendas para datas comemorativas e garanta que nenhuma conversa fique sem resposta.',
  },
  trafego: {
    nome_exibicao: 'Leo',
    plataforma: 'meta',
    objetivo: 'vendas', // vendas | mensagens | trafego
    verba_diaria: 80,
    verba_mensal: 2400,
    cpa_maximo: 35,
    roas_minimo: 3,
    raio_entrega_km: 15,
    cidade: '',
    publico: 'Mulheres e homens 25-55, interesses: flores, presentes, decoração, datas especiais',
    regras: {
      pausar_sem_conversao_apos_gasto: 60,
      pausar_ctr_abaixo: 0.8,
      escalar_roas_acima: 5,
      percentual_escala: 20,
    },
    acao_automatica: true, // false = só sugere, dono aprova
    criar_campanhas_sazonais: true,
    frequencia_analise_horas: 6,
    instrucoes: '',
  },
  social: {
    nome_exibicao: 'Bia',
    posts_feed_semana: 4,
    stories_dia: 2,
    criativos_anuncio_semana: 2,
    horarios: ['10:00', '18:30'],
    dias: ['seg', 'ter', 'qua', 'qui', 'sex', 'sab'],
    tom: 'acolhedor, romântico e elegante',
    hashtags_fixas: ['#floricultura', '#flores', '#presente'],
    cores_marca: ['#c2185b', '#1b5e20', '#fff7f2'],
    publicacao_automatica: false, // true = publica direto; false = vai para aprovação
    usar_fotos_produtos: true,
    temas: ['produtos em destaque', 'bastidores', 'dicas de cuidado', 'datas comemorativas', 'depoimentos'],
    instrucoes: '',
  },
  atendente: {
    nome_exibicao: 'Rosa',
    saudacao: 'Olá! 🌷 Seja bem-vindo(a)! Sou a {nome}, como posso deixar seu dia mais florido?',
    tom: 'simpática, próxima e objetiva; usa emojis com moderação',
    horario_atendimento: { inicio: '08:00', fim: '20:00', dias: ['seg', 'ter', 'qua', 'qui', 'sex', 'sab'] },
    mensagem_fora_horario: 'Estamos fora do horário agora, mas já anotei seu pedido e retornamos assim que abrirmos! 🌸',
    fazer_upsell: true,
    sugestoes_upsell: ['cartão personalizado', 'chocolate', 'pelúcia', 'vaso decorativo'],
    desconto_maximo_percent: 5,
    politicas: 'Entregas no mesmo dia para pedidos até 15h. Trocas em até 24h mediante foto. Pagamento via Pix, cartão ou link.',
    transferir_para_humano_quando: 'reclamação, pedido de desconto acima do permitido, eventos/casamentos, cliente pedir atendente humano',
    whatsapp_humano: '',
    faq: [
      { pergunta: 'Vocês entregam hoje?', resposta: 'Sim! Pedidos confirmados até 15h saem no mesmo dia.' },
    ],
    instrucoes: '',
  },
};

export function mergeDeep(base, override) {
  if (Array.isArray(override) || typeof override !== 'object' || override === null) return override ?? base;
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(override)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeDeep(base?.[k], v) : v;
  }
  return out;
}
