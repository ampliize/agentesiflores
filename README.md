# 🌷 Equipe dos Sonhos iFlores

Cinco profissionais virtuais para a floricultura, dentro da iFlores:

| Agente | Área | Faz |
|---|---|---|
| **Alex** | Gestão | Executa alterações na loja por conversa (com histórico e desfazer), resumo diário, relatório semanal, recomendações com hipótese e revisão, sugestão de compras de flores |
| **Flora** | Atendimento e vendas | WhatsApp e chat da loja 24 h: recomenda, calcula frete, mostra o resumo, cria o pedido e envia o link de pagamento |
| **Mari** | Conteúdo | Posts, carrosséis e stories a partir das fotos reais da loja, com aprovação individual, em lote ou automática |
| **Caio** | Anúncios | Meta e Google dentro do teto do lojista; pausa o que não vende e anúncios de produto esgotado |
| **Sol** | Finanças | CMV, margem de contribuição, rateio, preço sugerido e efeito de descontos, sempre com as premissas |

Junto com eles: **CRM** sincronizado com a iFlores, **automações** (pagamento, entrega, pós-venda, datas especiais,
insumos), **painel** embutível e **API aberta**.

> **Regra do produto:** nenhuma loja vê ou recebe dados de outra. Garantido no código e testado com 1000 lojas
> simultâneas. Veja [docs/ISOLAMENTO.md](docs/ISOLAMENTO.md).

## Documentação

- [docs/COMECE-AQUI.md](docs/COMECE-AQUI.md): passo a passo para o lojista conectar em 15 minutos
- [docs/INTEGRACAO-IFLORES.md](docs/INTEGRACAO-IFLORES.md): guia técnico para o time da iFlores
- [docs/ISOLAMENTO.md](docs/ISOLAMENTO.md): regras e garantias entre lojas

## Rodar

```bash
npm install
```

```bash
npm start
```

Abra http://localhost:3000 e clique em **Abrir loja de demonstração**. Sem `ANTHROPIC_API_KEY`, os agentes usam
regras de demonstração; com a chave, usam o Claude.

```bash
npm test
```

```bash
npm run build:demo
```

O último comando gera `dist/painel-demo.html`, o painel completo rodando no navegador com o mesmo núcleo.

## Estrutura

```
src/core/          núcleo (roda no servidor e na demo)
  store.js           armazenamento com isolamento obrigatório por loja
  agents/            alex, flora, mari, caio, sol
  crm.js             contatos, funil, linha do tempo, sincronização com a iFlores
  automacoes.js      automações com deduplicação, consentimento e horário de silêncio
  outbox.js          fila de envio para a iFlores com novas tentativas
  catalog.js         base compartilhada (produtos, insumos, entregas, fretes) com histórico e desfazer
  finance.js         motor financeiro da Sol
  api.js             API v1 (independente de framework)
src/server/        Express, SQLite, autenticação, contexto por loja, webhooks
public/            painel
test/              testes, incluindo isolamento com 1000 lojas
```
