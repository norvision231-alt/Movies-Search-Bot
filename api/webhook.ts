import { handleWebhookUpdate } from '../src/index';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(200).send('Movie Bot Webhook is Active!');
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (body) {
      await handleWebhookUpdate(body);
    }
    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error('Webhook Error:', err?.message || err);
    return res.status(200).json({ ok: false });
  }
}
