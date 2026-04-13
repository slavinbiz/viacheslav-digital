# Backend Plan — Supabase + Beget

## Цель

Превратить Mini App из одного файла в полноценный WhiteLabel-продукт:
- Данные мастеров хранятся в базе, а не в коде
- Заявки от клиентов сохраняются и доступны в панели
- Любой мастер получает своё приложение без программирования

---

## Архитектура

### До Beget (Фазы 1–3) — всё через Supabase

```
Клиент (tma.html)
    ↓ fetch + anon key (только публичные поля)
Supabase REST API
    ↓ Edge Function (server-side, ключи скрыты)
Telegram Bot API → уведомление мастеру
```

### После Beget (Фаза 4) — ключи на сервере

```
Клиент (tma.html)
    ↓ fetch (без ключей — просто JSON)
Beget API (PHP/Node)
    ↓ запросы с секретами внутри сервера
Supabase + Telegram Bot API
```

> Переход на Beget нужен только если требуется полная защита ключей
> или сложная серверная логика. На старте достаточно Supabase.

---

## Фаза 1 — Supabase: база данных

### Таблицы

#### `masters` — публичные поля (видны через anon key)
| Поле | Тип | Описание |
|---|---|---|
| id | uuid | первичный ключ |
| slug | text | уникальный идентификатор (`viacheslav`) |
| name | text | имя мастера |
| specialization | text | специализация |
| photo_url | text | ссылка на фото |
| bio | text | биография |
| telegram | text | @username |
| phone | text | телефон |
| email | text | email |
| brand_accent | text | цвет акцента (hex) |
| brand_accent_d | text | тёмный акцент (hex) |
| stack | jsonb | массив технологий |
| stats | jsonb | массив статистики |
| created_at | timestamp | дата создания |

> ⚠️ `bot_token` и `chat_id` **не хранятся** в этой таблице —
> они живут только в Supabase Edge Function (сервер их никогда не отдаёт клиенту).

#### `leads` — заявки клиентов
| Поле | Тип | Описание |
|---|---|---|
| id | uuid | первичный ключ |
| master_id | uuid | FK → masters.id |
| service_type | text | тип услуги |
| task | text | описание задачи |
| name | text | имя клиента |
| username | text | Telegram клиента |
| time_pref | text | удобное время |
| created_at | timestamp | дата заявки |
| status | text | new / in_progress / done |

#### `master_secrets` — приватная таблица (только server-side)
| Поле | Тип | Описание |
|---|---|---|
| master_id | uuid | FK → masters.id |
| bot_token | text | токен Telegram-бота |
| chat_id | text | chat_id для уведомлений |

> RLS на `master_secrets`: **SELECT запрещён для anon** — клиент не может прочитать токен.

---

### RLS-политики (конкретные SQL-команды)

Выполнить в Supabase → SQL Editor:

```sql
-- MASTERS: читать может любой (anon), редактировать только owner
ALTER TABLE masters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "masters_select_public"
  ON masters FOR SELECT
  USING (true);  -- публичная таблица, читают все

CREATE POLICY "masters_update_owner"
  ON masters FOR UPDATE
  USING (auth.uid() = id);  -- редактирует только сам мастер

-- LEADS: вставлять может любой (клиент создаёт заявку),
--        читать/менять только мастер-владелец
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "leads_insert_anon"
  ON leads FOR INSERT
  WITH CHECK (true);  -- любой может создать заявку

CREATE POLICY "leads_select_owner"
  ON leads FOR SELECT
  USING (
    master_id IN (
      SELECT id FROM masters WHERE id = auth.uid()
    )
  );

-- MASTER_SECRETS: полный запрет для anon, только service_role (Edge Function)
ALTER TABLE master_secrets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "secrets_deny_all"
  ON master_secrets FOR ALL
  USING (false);  -- никто через REST API не читает
```

### Защита от спама в `leads`

```sql
-- Не более 10 заявок с одного Telegram username в сутки
CREATE OR REPLACE FUNCTION check_lead_rate_limit()
RETURNS trigger AS $$
BEGIN
  IF (
    SELECT COUNT(*) FROM leads
    WHERE username = NEW.username
      AND created_at > now() - interval '1 day'
  ) >= 10 THEN
    RAISE EXCEPTION 'rate_limit_exceeded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lead_rate_limit
  BEFORE INSERT ON leads
  FOR EACH ROW EXECUTE FUNCTION check_lead_rate_limit();
```

### Шаги настройки Supabase

- [ ] Зарегистрироваться на supabase.com
- [ ] Создать проект (бесплатный план — 500 МБ БД, 2 ГБ трафика)
- [ ] Создать таблицы `masters`, `leads`, `master_secrets`
- [ ] Выполнить SQL-политики RLS выше
- [ ] Настроить keep-alive (см. Фазу 1б ниже)
- [ ] Получить `SUPABASE_URL` и `SUPABASE_ANON_KEY` в Settings → API

---

## Фаза 1б — Keep-alive для бесплатного плана

**Проблема:** Supabase Free засыпает через 7 дней без активности. Первый запрос после сна занимает 10–30 секунд — для пользователя это пустой экран.

**Решение А — крон-пинг (бесплатно):**

Настроить бесплатный крон на [cron-job.org](https://cron-job.org):
- URL: `https://<your-project>.supabase.co/rest/v1/masters?select=id&limit=1`
- Headers: `apikey: <SUPABASE_ANON_KEY>`
- Расписание: раз в 4 дня

**Решение Б — перейти на Pro ($25/мес):**

Оправдано при появлении 2–3 платящих мастеров. Pro не засыпает, даёт 8 ГБ БД и priority support.

---

## Фаза 2 — Supabase: загрузка данных мастера

```javascript
const MASTER_SLUG  = 'viacheslav'; // вшито в файл или берётся из URL
const SUPABASE_URL = 'https://xxxx.supabase.co';
const SUPABASE_KEY = 'eyJ...'; // anon key — публичный, это нормально

async function loadMasterConfig(slug) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/masters?slug=eq.${encodeURIComponent(slug)}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Accept': 'application/json' } }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.length) throw new Error('master not found');
    return data[0];
  } catch (err) {
    console.warn('Supabase недоступен, используем локальный CONFIG:', err.message);
    return null; // fallback — initUI возьмёт данные из CONFIG
  }
}

// В STARTUP вместо просто initUI():
(async () => {
  const remoteMaster = await loadMasterConfig(MASTER_SLUG);
  if (remoteMaster) {
    // Мерджим с CONFIG — поля из БД перезаписывают локальные
    Object.assign(CONFIG.master, {
      name:           remoteMaster.name,
      specialization: remoteMaster.specialization,
      photo:          remoteMaster.photo_url,
      bio:            remoteMaster.bio,
      telegram:       remoteMaster.telegram,
      phone:          remoteMaster.phone,
      email:          remoteMaster.email,
      stack:          remoteMaster.stack || CONFIG.master.stack,
      stats:          remoteMaster.stats || CONFIG.master.stats,
    });
    if (remoteMaster.brand_accent) {
      CONFIG.brand.accent  = remoteMaster.brand_accent;
      CONFIG.brand.accentD = remoteMaster.brand_accent_d || remoteMaster.brand_accent;
      // Применяем новые цвета
      document.documentElement.style.setProperty('--accent',   CONFIG.brand.accent);
      document.documentElement.style.setProperty('--accent-d', CONFIG.brand.accentD);
      document.documentElement.style.setProperty('--btn',      CONFIG.brand.accent);
    }
  }
  initUI();          // теперь данные точно актуальны
  renderServices('all');
  renderPortfolio('all');
  // ... остальной STARTUP код
})();
```

> CONFIG в tma.html остаётся как **запасной вариант** — если Supabase недоступен,
> приложение всё равно работает с локальными данными.

---

## Фаза 3 — Supabase Edge Function: уведомление в Telegram

**Почему Edge Function, а не fetch с клиента:**
- `bot_token` остаётся на сервере — клиент его никогда не видит
- Можно добавить логику: антиспам, форматирование, отправка нескольким мастерам

### Создать функцию в Supabase → Edge Functions

Файл `supabase/functions/notify-master/index.ts`:

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async (req) => {
  const { master_id, service_type, task, name, username, time_pref } = await req.json();

  // Получаем секреты мастера (service_role key — только на сервере)
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  const { data: secret } = await supabase
    .from('master_secrets')
    .select('bot_token, chat_id')
    .eq('master_id', master_id)
    .single();

  if (!secret) return new Response('master not found', { status: 404 });

  const timeLabels: Record<string, string> = {
    morning: 'Утром (9–12)', day: 'Днём (12–18)', evening: 'Вечером (18–21)'
  };
  const svcLabels: Record<string, string> = {
    site: 'Сайт / лендинг', bot: 'Telegram-бот', ai: 'ИИ-агент', other: 'Другое'
  };

  const text = `📱 <b>Новая заявка из Mini App</b>\n\n` +
    `🛠 <b>Услуга:</b> ${svcLabels[service_type] || service_type}\n` +
    `💬 <b>Задача:</b> ${task}\n` +
    `👤 <b>Имя:</b> ${name}\n` +
    `✈️ <b>Telegram:</b> @${username}\n` +
    `🕐 <b>Время:</b> ${timeLabels[time_pref] || time_pref}`;

  await fetch(`https://api.telegram.org/bot${secret.bot_token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: secret.chat_id, text, parse_mode: 'HTML' })
  });

  return new Response('ok');
});
```

### Вызов из tma.html (вместо прямого fetch к Telegram)

```javascript
async function saveLead(data) {
  try {
    // 1. Сохранить заявку в БД
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        master_id:    CONFIG._masterId, // сохраняем при loadMasterConfig
        service_type: data.serviceType,
        task:         data.task,
        name:         data.name,
        username:     data.username,
        time_pref:    data.time,
        status:       'new'
      })
    });
    if (!insertRes.ok) throw new Error('insert failed');

    // 2. Отправить уведомление через Edge Function (токен скрыт)
    await fetch(`${SUPABASE_URL}/functions/v1/notify-master`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        master_id:    CONFIG._masterId,
        service_type: data.serviceType,
        task:         data.task,
        name:         data.name,
        username:     data.username,
        time_pref:    data.time
      })
    });
  } catch (err) {
    // Fallback: прямой fetch к Telegram (старый способ, работает пока нет Beget)
    console.warn('Edge Function недоступна, fallback:', err.message);
    await sendToTelegram(/* текст сообщения */);
  }
}
```

---

## Фаза 4 — Beget: когда и зачем переходить

### Переходить на Beget если

| Ситуация | Решение |
|---|---|
| Нужен webhook для приёма команд от бота (`/start`, `/leads`) | PHP или Node на Beget |
| Нужны платежи (ЮKassa, Tinkoff) | PHP-обработчик на Beget |
| Supabase Edge Function не подходит по скорости или цене | Свой API на Beget |
| Хочется полностью убрать Supabase anon key из браузера | Beget-прокси |

### Что НЕ нужно переносить на Beget

- Простое чтение данных мастера — Supabase REST справляется
- Сохранение заявок — RLS + trigger антиспама достаточно
- Уведомления в Telegram — Edge Function решает

### Структура на Beget

```
beget/
├── api/
│   ├── get-master.php    # GET /api/get-master?slug=viacheslav
│   ├── save-lead.php     # POST /api/save-lead
│   └── webhook.php       # POST /api/webhook (Telegram Bot)
└── .env                  # SUPABASE_SERVICE_KEY, BOT_TOKEN — только здесь
```

### После перехода — в tma.html меняется только BASE_URL

```javascript
// До Beget:
const API_BASE = SUPABASE_URL; // прямые запросы в Supabase

// После Beget:
const API_BASE = 'https://yourdomain.beget.tech/api'; // всё через свой сервер
// Остальной код tma.html не меняется
```

---

## Фаза 5 — Панель мастера

Отдельный HTML-файл `dashboard.html`:
- Вход через Supabase Auth (email + пароль)
- Список заявок из `leads` с фильтром по статусу
- Редактирование своего профиля в `masters`
- Смена цвета акцента (color picker → сохранить в `brand_accent`)

---

## Порядок реализации

1. [ ] Создать Supabase-проект
2. [ ] Создать таблицы `masters`, `leads`, `master_secrets`
3. [ ] Выполнить RLS-политики и trigger антиспама
4. [ ] Добавить данные Вячеслава в `masters` и `master_secrets`
5. [ ] Настроить keep-alive крон (cron-job.org)
6. [ ] Обновить `tma.html`: `loadMasterConfig()` + merge с CONFIG
7. [ ] Создать Edge Function `notify-master` в Supabase
8. [ ] Обновить `submitBrief()`: `saveLead()` + Edge Function
9. [ ] Протестировать: заявка → `leads` в БД → Telegram
10. [ ] При необходимости — Beget (webhook бота / платежи)

---

## Полезные ссылки

| Что | Ссылка |
|---|---|
| Supabase | https://supabase.com |
| Supabase Edge Functions | https://supabase.com/docs/guides/functions |
| Supabase RLS | https://supabase.com/docs/guides/auth/row-level-security |
| Keep-alive крон | https://cron-job.org |
| Beget | https://beget.com |
