export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const token  = process.env.TG_TOKEN;
  const chatId = process.env.TG_CHAT_ID || '888224075';
  const text   = `🆕 Новая заявка с сайта\n\n👤 Имя: ${name}\n📧 Email: ${email}\n💬 Задача: ${message}`;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  return res.status(200).json({ ok: true });
}
