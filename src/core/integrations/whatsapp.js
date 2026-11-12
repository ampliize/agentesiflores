// WhatsApp Business Cloud API (Meta). Sem credenciais, as mensagens ficam apenas
// registradas no painel (modo demonstração / simulador de conversa).
const GRAPH = 'https://graph.facebook.com/v21.0';

export async function sendWhatsApp(tenant, to, text) {
  const wa = tenant?.integrations?.whatsapp;
  if (!wa?.connected || !wa.phone_number_id || !wa.access_token) return { demo: true };
  const res = await fetch(`${GRAPH}/${wa.phone_number_id}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${wa.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: true } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Extrai mensagens de texto recebidas do payload de webhook da Meta. */
export function parseIncoming(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) {
        const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
        if (text) out.push({ from: m.from, name: names[m.from] || '', text, id: m.id, phone_number_id: v.metadata?.phone_number_id });
      }
    }
  }
  return out;
}

export async function testWhatsApp({ phone_number_id, access_token }) {
  const res = await fetch(`${GRAPH}/${phone_number_id}?fields=display_phone_number,verified_name`, {
    headers: { authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Falha ao validar WhatsApp (${res.status})`);
  return res.json();
}
