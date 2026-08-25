/**
 * Интерактивная настройка бота: спрашивает секреты, создаёт .env,
 * заливает переменные в Vercel и регистрирует вебхук.
 *
 * Запуск:  npm run setup
 *
 * Секреты вводятся в терминале и остаются на этой машине.
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const PROD_URL = 'https://ai-social-bot-seven.vercel.app';
// fileURLToPath, а не URL.pathname: в пути к проекту есть пробел, и pathname
// вернул бы его закодированным как %20 — файл создался бы не с тем именем.
const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));

const rl = createInterface({ input: stdin, output: stdout });

// Ctrl+C или обрыв ввода: без этого цикл проверки значения крутился бы вхолостую.
rl.on('close', () => process.exit(0));

const bold = (s: string) => `[1m${s}[0m`;
const dim = (s: string) => `[2m${s}[0m`;
const green = (s: string) => `[32m${s}[0m`;
const red = (s: string) => `[31m${s}[0m`;
const yellow = (s: string) => `[33m${s}[0m`;

async function ask(question: string, validate?: (v: string) => string | null): Promise<string> {
  for (;;) {
    const answer = (await rl.question(question)).trim();
    if (!answer) {
      console.log(red('  Пустое значение, попробуй ещё раз.'));
      continue;
    }
    const problem = validate?.(answer);
    if (problem) {
      console.log(red(`  ${problem}`));
      continue;
    }
    return answer;
  }
}

async function confirm(question: string): Promise<boolean> {
  const answer = (await rl.question(`${question} ${dim('[Y/n]')} `)).trim().toLowerCase();
  return answer === '' || answer === 'y' || answer === 'да' || answer === 'yes';
}

function run(command: string, args: string[], input?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function telegram(token: string, method: string, body?: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return (await res.json()) as { ok: boolean; result?: any; description?: string };
}

async function main(): Promise<void> {
  console.log(bold('\n  Настройка AI Social Bot\n'));

  if (existsSync(ENV_PATH)) {
    console.log(yellow('  Файл .env уже существует.'));
    if (!(await confirm('  Перезаписать его?'))) {
      console.log('  Отменено.');
      rl.close();
      return;
    }
  }

  // --- 1. Токен бота ---------------------------------------------------------
  console.log(bold('\n  1. Токен бота'));
  console.log(dim('     Telegram -> @BotFather -> /newbot -> скопируй строку вида 8123456789:AAF...\n'));

  const botToken = await ask('  Токен бота: ', (v) =>
    /^\d{8,12}:[A-Za-z0-9_-]{30,}$/.test(v) ? null : 'Не похоже на токен. Он выглядит как 8123456789:AAF...',
  );

  process.stdout.write(dim('  Проверяю токен... '));
  const me = await telegram(botToken, 'getMe');
  if (!me.ok) {
    console.log(red(`\n  Токен отвергнут Telegram: ${me.description}`));
    rl.close();
    process.exit(1);
  }
  console.log(green(`ок, это @${me.result.username}`));

  // --- 2. Ключ OpenRouter ----------------------------------------------------
  console.log(bold('\n  2. Ключ OpenRouter'));
  console.log(dim('     https://openrouter.ai/keys -> Create Key -> скопируй (начинается с sk-or-v1-)\n'));

  const openrouterKey = await ask('  Ключ OpenRouter: ', (v) =>
    v.startsWith('sk-or-') ? null : 'Ключ должен начинаться с sk-or-',
  );

  // --- 3. Строка подключения к базе ------------------------------------------
  console.log(bold('\n  3. Строка подключения к базе'));
  console.log(dim('     Supabase -> проект ai-social-bot -> кнопка Connect -> вкладка Transaction pooler'));
  console.log(dim('     Не забудь заменить [YOUR-PASSWORD] на пароль базы (вместе со скобками)\n'));

  const databaseUrl = await ask('  DATABASE_URL: ', (v) => {
    if (!v.startsWith('postgres://') && !v.startsWith('postgresql://')) return 'Должна начинаться с postgres://';
    if (v.includes('[YOUR-PASSWORD]')) return 'Замени [YOUR-PASSWORD] на настоящий пароль базы';
    if (v.includes('.supabase.co')) {
      return 'Это Direct connection — он живёт только в IPv6 и с Vercel не работает. Нужна вкладка Transaction pooler.';
    }
    if (!v.includes(':6543')) {
      return 'Нужен Transaction pooler с портом 6543. Порт 5432 с Vercel не заработает.';
    }
    return null;
  });

  // --- Записываем .env -------------------------------------------------------
  const webhookSecret = randomBytes(32).toString('hex');
  const cronSecret = randomBytes(32).toString('hex');

  const envFile = [
    '# Создано скриптом npm run setup. В git не попадает (см. .gitignore).',
    '',
    `TELEGRAM_BOT_TOKEN=${botToken}`,
    `TELEGRAM_WEBHOOK_SECRET=${webhookSecret}`,
    '',
    `OPENROUTER_API_KEY=${openrouterKey}`,
    '',
    `DATABASE_URL=${databaseUrl}`,
    'DATABASE_SSL=true',
    '',
    `CRON_SECRET=${cronSecret}`,
    '',
    'NODE_ENV=development',
    'LOG_LEVEL=info',
    '',
  ].join('\n');

  writeFileSync(ENV_PATH, envFile, { mode: 0o600 });
  console.log(green('\n  ✓ Файл .env создан'));

  // --- Заливаем переменные в Vercel ------------------------------------------
  console.log(bold('\n  4. Переменные в Vercel'));

  const vars: Array<[string, string]> = [
    ['TELEGRAM_BOT_TOKEN', botToken],
    ['TELEGRAM_WEBHOOK_SECRET', webhookSecret],
    ['OPENROUTER_API_KEY', openrouterKey],
    ['DATABASE_URL', databaseUrl],
    ['DATABASE_SSL', 'true'],
    ['CRON_SECRET', cronSecret],
  ];

  const whoami = await run('npx', ['--yes', 'vercel', 'whoami']);
  if (whoami.code !== 0) {
    console.log(yellow('  Vercel CLI не авторизован.'));
    console.log('  Выполни в отдельном окне терминала:');
    console.log(bold('\n    npx vercel login\n'));
    console.log('  ...а потом запусти этот скрипт заново — он всё дозальёт.');
    console.log(dim('\n  (Либо вставь переменные руками: Vercel -> Settings -> Environment Variables.'));
    console.log(dim('   Значения лежат в файле .env, который я только что создал.)'));
    rl.close();
    return;
  }

  console.log(dim(`  Vercel: ${whoami.output.trim()}`));

  const link = await run('npx', ['--yes', 'vercel', 'link', '--yes', '--project', 'ai-social-bot']);
  if (link.code !== 0) {
    console.log(yellow('  Не удалось связать папку с проектом Vercel:'));
    console.log(dim(`  ${link.output.trim().split('\n').slice(-3).join('\n  ')}`));
    console.log('  Вставь переменные руками — значения в файле .env.');
    rl.close();
    return;
  }

  for (const [name, value] of vars) {
    for (const target of ['production', 'preview', 'development']) {
      // Старое значение может остаться с прошлого запуска — сначала удаляем.
      await run('npx', ['--yes', 'vercel', 'env', 'rm', name, target, '--yes']);
      const add = await run('npx', ['--yes', 'vercel', 'env', 'add', name, target], value);
      if (add.code !== 0) {
        console.log(red(`  ✗ ${name} (${target}): ${add.output.trim().split('\n').slice(-1)[0]}`));
      }
    }
    console.log(green(`  ✓ ${name}`));
  }

  // --- Передеплой ------------------------------------------------------------
  console.log(bold('\n  5. Передеплой'));
  console.log(dim('     Vercel подхватывает переменные только при новой сборке.\n'));

  if (await confirm('  Передеплоить сейчас?')) {
    process.stdout.write(dim('  Собираю (это займёт минуту)... '));
    const deploy = await run('npx', ['--yes', 'vercel', 'deploy', '--prod', '--yes']);
    if (deploy.code !== 0) {
      console.log(red('не вышло:'));
      console.log(dim(`  ${deploy.output.trim().split('\n').slice(-5).join('\n  ')}`));
    } else {
      console.log(green('готово'));
    }
  }

  // --- Вебхук ----------------------------------------------------------------
  console.log(bold('\n  6. Вебхук'));

  const hook = await telegram(botToken, 'setWebhook', {
    url: `${PROD_URL}/api/telegram`,
    secret_token: webhookSecret,
    drop_pending_updates: true,
    allowed_updates: ['message'],
  });

  if (!hook.ok) {
    console.log(red(`  ✗ Не удалось установить вебхук: ${hook.description}`));
    rl.close();
    process.exit(1);
  }
  console.log(green(`  ✓ Вебхук установлен: ${PROD_URL}/api/telegram`));

  console.log(bold(`\n  Готово. Напиши боту @${me.result.username} в личку — он должен ответить.`));
  console.log(dim('  Если молчит: npm run webhook:info покажет, не копятся ли ошибки доставки.\n'));

  rl.close();
}

main().catch((err) => {
  console.error(red(`\n  Ошибка: ${err instanceof Error ? err.message : String(err)}`));
  rl.close();
  process.exit(1);
});
