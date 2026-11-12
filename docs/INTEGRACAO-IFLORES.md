# Integração iFlores ↔ Equipe dos Sonhos (guia técnico)

Para o time da iFlores. Descreve como ativar a Equipe para uma loja, abrir o painel, manter o CRM sincronizado e
o que a iFlores precisa expor. Regras de separação entre lojas: `ISOLAMENTO.md`.

```
 iFlores (backend)                                   Equipe dos Sonhos
 ─────────────────                                   ─────────────────
 1. contratação  ── POST /api/v1/plataforma/lojas ──►  cria a loja, devolve api_key
 2. menu         ── POST .../lojas/{id}/sessao  ────►  token de 8 h → iframe /painel?token=
 3. eventos      ── POST /api/v1/eventos  ──────────►  pedidos, pagamentos, clientes, avaliações
 4. API da loja  ◄── GET /v1/sync, /v1/catalog ─────   CRM e catálogo (pull por cursor)
                 ◄── POST /v1/orders, /v1/customers ─  fila de saída com novas tentativas
                 ◄── POST /v1/changes ──────────────   alterações feitas pelo Alex
 5. webhook      ◄── POST {url da loja} ────────────   o que os agentes fizeram (assinado)
```

## 1. Ativar a Equipe para uma loja

```http
POST /api/v1/plataforma/lojas
X-Platform-Key: <IFLORES_PLATFORM_KEY>
Content-Type: application/json

{ "nome": "Floricultura Jardim Encantado", "iflores_store_id": "12345",
  "iflores": { "base_url": "https://api.iflores.app.br/lojas/12345", "token": "<token da loja>" },
  "agentes": ["alex", "flora", "mari", "caio", "sol"] }
```

Resposta `201`: `{ loja_id, api_key, webhook_secret, panel_url }`. A `api_key` e o `webhook_secret` aparecem uma única vez; guarde-os cifrados.
`agentes` define a contratação (individual ou combo). Enviar `base_url` e `token` deixa a iFlores já conectada,
então o lojista não precisa fazer esse passo.

## 2. Abrir o painel dentro da iFlores

A cada acesso do lojista ao menu, gere uma sessão curta:

```http
POST /api/v1/plataforma/lojas/12345/sessao
X-Platform-Key: <IFLORES_PLATFORM_KEY>
```

```html
<iframe src="{panel_url}" style="width:100%;height:100vh;border:0"></iframe>
```

O servidor envia `Content-Security-Policy: frame-ancestors` com `https://*.iflores.app.br` (ajuste com `FRAME_ANCESTORS`).

## 3. Eventos que a iFlores envia

```http
POST /api/v1/eventos
Authorization: Bearer ifa_...
X-IFlores-Signature: hex(HMAC-SHA256(segredo_do_webhook, corpo))   (recomendado)

{ "id": "evt_8f2c", "type": "payment.confirmed", "data": { "external_id": "P77" } }
```

O campo `id` torna o envio **idempotente**: o mesmo evento reenviado é ignorado. Envie sempre.

| type | data | O que acontece |
|---|---|---|
| `payment.confirmed` | `order_id` ou `external_id` | Pedido marcado como pago; automação "Confirmação de pagamento" avisa o cliente; CRM recalcula a etapa |
| `order.created` / `order.updated` | pedido no formato de `/v1/sync` | Upsert do pedido e do contato no CRM |
| `order.status` | `order_id`/`external_id`, `status` (`em_producao`, `saiu_para_entrega`, `entregue`, `cancelado`) | "Saiu para entrega" avisa o cliente; "entregue" agenda o pós-venda |
| `customer.created` / `customer.updated` | `id`, `telefone`, `nome`, `email`, `aceita_marketing`, `tags`, `datas` | Upsert do contato |
| `customer.optout` | `telefone` | Remove o consentimento de marketing |
| `review.created` | `nota`, `comentario`, `cliente` | Nota ≥ 4 vira tarefa de post de depoimento para a Mari |

## 4. API que a iFlores precisa expor

Chamada com `Authorization: Bearer <token da loja>` no `base_url` da loja. Sem ela, a Equipe funciona com a base
local (modo demonstração).

| Método | Rota | Uso | Resposta |
|---|---|---|---|
| GET | `/v1/store` | testar conexão | `{ id, nome }` |
| GET | `/v1/sync?desde={cursor}` | CRM: clientes e pedidos alterados desde o cursor | `{ cursor, clientes: [...], pedidos: [...] }` |
| GET | `/v1/catalog` | produtos (com composição), insumos, entregas, fretes | ver formato abaixo |
| POST | `/v1/customers` · PUT `/v1/customers/{id}` | contatos criados/editados pela Flora ou no CRM | `{ id }` |
| POST | `/v1/orders` | pedidos criados pela Flora | `{ id, link_pagamento }` |
| POST | `/v1/changes` | alterações do Alex (produto ativo, estoque, destaque, datas, horários, fretes, catálogo comemorativo) | `{ ok }` |

Formatos:
- **cliente**: `{ id, telefone, nome, email, aceita_marketing, tags[], datas[{ tipo, data }] }`
- **pedido**: `{ id, numero, telefone, cliente_nome, itens[{ produto_id, nome, preco, qtd }], total, status, pago, data_entrega, modalidade, link_pagamento, criado_em }`
- **alteração**: `{ change_id, descricao, ops: [{ coll, id, after }] }`. `after` é o documento completo depois da mudança; `null` remove.

Regras:
- `GET /v1/sync` deve devolver tudo que mudou desde o cursor, em ordem, e um cursor novo. Reenviar o mesmo registro é seguro: a Equipe faz upsert por `id`.
- Os envios da Equipe passam por uma fila: em erro, ela tenta de novo com espera crescente (1 min, 2 min, 4 min… até 6 h, 8 tentativas). Responda 2xx só quando gravou.

## 5. Webhook de saída (opcional)

Configure com `PUT /api/v1/webhook` `{ "url": "https://...", "enabled": true }` e receba `{ event, tenant_id, sent_at, data }` com o header
`X-IFlores-Signature` (HMAC-SHA256 do corpo com o segredo da loja). Exemplos: `agent.pedido`, `agent.alteracao`,
`agent.campanha`, `agent.automacao`, `agent.transferencia`.

## 6. WhatsApp e Meta

- Webhook do WhatsApp Cloud API: `{PUBLIC_URL}/webhooks/whatsapp/{loja_id}` com o verify token `WHATSAPP_VERIFY_TOKEN`.
- Imagens das peças para o Instagram: `{PUBLIC_URL}/media/posts/{id}/{n}.png`. `PUBLIC_URL` precisa ser HTTPS público.
- Mensagens fora da janela de 24 h do WhatsApp (pós-venda, datas especiais) exigem modelos aprovados na Meta. Cadastre os modelos com os mesmos textos das automações.

## 7. Variáveis do servidor

| Variável | Para quê |
|---|---|
| `IFLORES_PLATFORM_KEY` | chave da iFlores para criar lojas e sessões |
| `APP_SECRET` | assina os tokens de sessão do painel |
| `PUBLIC_URL` | endereço público (webhooks e imagens) |
| `ANTHROPIC_API_KEY`, `AI_MODEL` | IA dos agentes (sem chave: modo demonstração) |
| `IA_LIMITE_DIARIO_POR_LOJA` | limite de chamadas de IA por loja por dia (padrão 400) |
| `LIMITE_REQ_POR_MINUTO` | limite de requisições por loja (padrão 240) |
| `ROTINAS_CONCORRENCIA` | quantas lojas processar em paralelo nas rotinas (padrão 8) |
| `DB_PATH` | arquivo SQLite (para muitas lojas, trocar por Postgres mantendo a interface do store) |
