# 🌷 iFlores · Equipe Virtual (MVP)

Quatro agentes de IA para floriculturas que já usam a [iFlores](https://www.iflores.app.br/), com um painel
de configuração e monitoramento que fica **dentro da iFlores** (iframe) e uma **API aberta** para a integração.

| Agente | O que faz |
|---|---|
| 👩‍💼 **Gerente** | Mede as metas definidas pelo dono, revisa cada arte antes de publicar (reprova e pede ajuste), audita conversas do WhatsApp, cobra os outros agentes criando tarefas e envia relatório diário pelo WhatsApp. |
| 📈 **Gestor de Tráfego** | Lê as métricas do Meta Ads, **pausa** campanhas que não performam (regras do dono), **escala** as que vendem, cria campanhas para datas comemorativas e pede criativos à Social Media. |
| 🎨 **Social Media** | Planeja a semana (posts de feed, stories e criativos de anúncio nas quantidades definidas), gera as **artes em PNG** com as cores da marca, escreve as legendas e **publica automaticamente** no Instagram. |
| 💬 **Atendente** | Atende no WhatsApp, consulta o catálogo, calcula o frete, **fecha o pedido** na iFlores com link de pagamento, faz upsell e transfere para um humano quando necessário. |

## Rodar localmente

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm start
```

Abra http://localhost:3000 e clique em **Abrir loja de demonstração**.

Sem `ANTHROPIC_API_KEY`, tudo funciona em **modo demonstração**: os agentes usam regras e modelos prontos,
com catálogo e campanhas de exemplo. Com a chave, os agentes passam a usar o Claude (`AI_MODEL`, padrão `claude-opus-5-5`).

Testes:

```bash
npm test
```

## Painel (abas)

* **Equipe**: organograma com o Gerente acima dos 3 agentes, status ao vivo (online/trabalhando/pausado), o que cada um está fazendo, nota de desempenho, ações em 24 h, metas no topo, feed de atividade em tempo real (SSE) e o último relatório do Gerente.
* **Tarefas**: kanban. O dono delega tarefas; o Gerente e os agentes também criam tarefas entre si. A coluna "Aguardando você" traz as ações que pedem aprovação.
* **Conteúdo**: as artes geradas, com aprovar, pedir ajuste (a IA refaz), publicar agora e baixar.
* **Atendimento**: conversas do WhatsApp, simulador para testar a Atendente e o botão para um humano assumir.
* **Tráfego**: campanhas com ROAS/CPA/CTR, diagnóstico, ações automáticas e campanhas propostas.
* **Metas**: as metas e a rotina do Gerente.
* **Configurar**: personalização completa de cada agente (quantidade de posts, horários, cores, tom, horário de atendimento, upsell, desconto máximo, FAQ, verba, regras de corte, autonomia…).
* **Integrações**: conexão em 4 passos (iFlores, WhatsApp, Meta Ads, Instagram), chave da API e webhook.

## Integração com a iFlores

Veja [docs/INTEGRACAO-IFLORES.md](docs/INTEGRACAO-IFLORES.md) (fluxo completo e contrato da API que a iFlores
precisa expor) e [docs/openapi.yaml](docs/openapi.yaml) (API aberta).

## Arquitetura

```
src/
  server.js            Express: API, webhooks, mídia, painel
  scheduler.js         ciclos automáticos por loja (plano semanal, análise de tráfego, supervisão, relatório, publicação)
  agents/              gerente.js · trafego.js · social.js · atendente.js · defaults.js (config padrão)
  integrations/        iflores.js · whatsapp.js · meta.js (Ads + Instagram)
  lib/                 llm.js (Claude) · art.js (gerador de artes) · tenants.js · tasks.js · events.js · calendar.js
  routes/              api.js (API aberta v1) · webhooks.js (WhatsApp)
public/                painel (HTML/CSS/JS, sem build)
```

* Multi-loja (tenant) com SQLite nativo do Node 22 (`DB_PATH`). Para produção com muitas lojas, trocar por Postgres.
* As decisões de corte do tráfego são **regras determinísticas** (auditáveis); a IA cuida da estratégia, das peças e do atendimento.
* Saídas da IA com JSON Schema estruturado; a Atendente usa ferramentas (tool use) com schema estrito.

## Próximos passos sugeridos

1. Implementar na iFlores as rotas da seção 3 do guia de integração e trocar o catálogo de demonstração pelos dados reais.
2. Fluxo de OAuth da Meta (Embedded Signup do WhatsApp e login do Facebook) para conectar com um clique, sem colar tokens.
3. Fila de jobs (BullMQ/Redis) e Postgres para escalar; observabilidade dos custos de IA por loja.
4. Geração de imagem por IA a partir das fotos reais dos produtos (hoje as artes são layouts de marca gerados em SVG/PNG).
5. Upload de criativos e criação de anúncios completos (conjuntos e anúncios), além de campanhas.
