# Guia de integração: iFlores ↔ Equipe Virtual

A Equipe Virtual é um serviço separado. A iFlores se conecta a ela em **3 pontos**:

```
┌──────────────────────── iFlores (sistema de gestão) ────────────────────────┐
│  Menu "Equipe Virtual"  ──iframe──►  /painel?token=...   (monitoramento)    │
│  Backend iFlores        ──POST────►  /api/v1/platform/*  (criar loja/sessão)│
│  Backend iFlores        ──POST────►  /api/v1/events      (pedidos, estoque…)│
│  API da loja  ◄──────── GET/POST ──  agentes (catálogo, frete, pedidos)     │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 1. Ativar a Equipe Virtual para uma loja

Quando o cliente contrata o add-on, o backend da iFlores chama:

```http
POST /api/v1/platform/tenants
X-Platform-Key: <IFLORES_PLATFORM_KEY>
Content-Type: application/json

{
  "name": "Floricultura Jardim Encantado",
  "iflores_store_id": "12345",
  "iflores": { "base_url": "https://api.iflores.app.br/lojas/12345", "token": "<token da loja>" }
}
```

Resposta `201`: `{ tenant, api_key, panel_url }`. Guarde a `api_key` (ela não é exibida de novo).

## 2. Abrir o painel dentro da iFlores (iframe)

A cada acesso do dono ao menu "Equipe Virtual", o backend gera uma sessão de 8 h:

```http
POST /api/v1/platform/tenants/12345/session
X-Platform-Key: <IFLORES_PLATFORM_KEY>
```

```html
<iframe src="{panel_url}" style="width:100%;height:100vh;border:0"></iframe>
```

O header `Content-Security-Policy: frame-ancestors` libera `https://*.iflores.app.br` (ajuste com `FRAME_ANCESTORS`).

## 3. API que a iFlores precisa expor para os agentes

Os agentes chamam a API da loja com `Authorization: Bearer <token da loja>`. Enquanto isso não existir,
os agentes usam um **catálogo de demonstração**, e tudo funciona para testes.

| Método | Rota | Usado por | Retorno esperado |
|---|---|---|---|
| GET | `/v1/store` | teste de conexão | `{ id, nome }` |
| GET | `/v1/products?q=&categoria=&preco_max=&ocasiao=&limit=` | Atendente, Social | `{ items: [{ id, nome, preco, categoria, estoque, descricao, imagem_url, tags[] }], addons: [{ id, nome, preco }] }` |
| GET | `/v1/products/{id}` | Atendente | produto |
| POST | `/v1/delivery/quote` `{ cep, bairro, data }` | Atendente | `{ disponivel, taxa, prazo, janelas[] }` |
| POST | `/v1/orders` (itens, destinatário, endereço, cep, data_entrega, janela, mensagem_cartao, comprador_nome, comprador_telefone, taxa_entrega, origem) | Atendente | `{ id, status, total, link_pagamento, rastreio_url }` |
| GET | `/v1/orders/{id}` | Atendente | `{ id, status, previsao, rastreio_url }` |
| GET | `/v1/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD` | Gerente | `{ faturamento, pedidos, ticket_medio, por_canal }` |

## 4. Eventos da iFlores para os agentes

```http
POST /api/v1/events
Authorization: Bearer ifa_...
X-IFlores-Signature: hex(HMAC-SHA256(webhook_secret, corpo))   (opcional)

{ "type": "order.created", "data": { "id": "PED123", "total": 189.9 } }
```

| type | O que acontece |
|---|---|
| `order.created` | Gerente registra a venda no feed |
| `order.delivered` | Atendente registra o pós-venda |
| `product.out_of_stock` | Tráfego recebe tarefa para pausar anúncios do produto |
| `review.created` (nota ≥ 4) | Social Media recebe tarefa de post de depoimento |

## 5. Eventos dos agentes para a iFlores (webhook de saída)

Configure em **Integrações → Webhook**. Cada evento é um `POST` com o corpo
`{ event, tenant_id, sent_at, data }` e o header `X-IFlores-Signature`. Exemplos:
`agent.pedido_criado`, `agent.transferido_humano`, `agent.campanha_pausada`, `agent.post_publicado`,
`atendimento.transferido`.

## 6. WhatsApp e Meta

* **WhatsApp Cloud API**: webhook `{PUBLIC_URL}/webhooks/whatsapp/{tenant_id}`, verify token `WHATSAPP_VERIFY_TOKEN`.
  Assine o campo `messages`.
* **Meta Ads**: use um System User com permissão `ads_management` na conta de anúncios.
* **Instagram**: conta Business ligada a uma página, com permissões `instagram_basic` e `instagram_content_publish`.
  As artes são servidas em `{PUBLIC_URL}/media/...png`, então `PUBLIC_URL` precisa ser público (HTTPS).
