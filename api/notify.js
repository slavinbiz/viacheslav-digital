export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { master_id, service_type, task, name, username, time_pref } = req.body;

  if (!master_id) {
    return res.status(400).json({ error: 'master_id required' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  // Читаем токен бота из master_secrets (service_role — обходит RLS)
  const secretRes = await fetch(
    `${SUPABASE_URL}/rest/v1/master_secrets?master_id=eq.${master_id}&select=bot_token,chat_id`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      }
    }
  );

  const secrets = await secretRes.json();
  if (!secrets.length) {
    return res.status(404).json({ error: 'master secrets not found' });
  }

  const { bot_token, chat_id } = secrets[0];

  const timeLabels = { morning: 'Утром (9–12)', day: 'Днём (12–18)', evening: 'Вечером (18–21)' };
  const svcLabels  = { site: 'Сайт / лендинг', bot: 'Telegram-бот', ai: 'ИИ-агент', other: 'Другое' };

  const text = `📱 <b>Новая заявка из Mini App</b>\n\n` +
    `🛠 <b>Услуга:</b> ${svcLabels[service_type] || service_type || '—'}\n` +
    `💬 <b>Задача:</b> ${task || '—'}\n` +
    `👤 <b>Имя:</b> ${name || '—'}\n` +
    `✈️ <b>Telegram:</b> @${username || '—'}\n` +
    `🕐 <b>Время:</b> ${timeLabels[time_pref] || time_pref || '—'}`;

  await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' })
  });

  return res.status(200).json({ ok: true });
}
