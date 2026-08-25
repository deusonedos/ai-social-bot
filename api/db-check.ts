import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/index.js';

/**
 * Диагностика подключения к базе. Закрыта CRON_SECRET, поэтому может отдавать
 * подробности ошибки — наружу они не утекут.
 *
 * Пароль не показываем никогда: только хост, порт и пользователя, потому что
 * почти все ошибки подключения к Supabase — это либо не тот порт (нужен
 * transaction pooler 6543), либо не тот пароль.
 */
/**
 * Расшифровка типовых ошибок. Голый ENOTFOUND ничего не объясняет, а причина
 * почти всегда одна и та же: в DATABASE_URL попала строка Direct connection,
 * которая на бесплатном тарифе Supabase живёт только в IPv6, тогда как
 * Vercel ходит по IPv4.
 */
function diagnose(code: string | undefined, host: string): string | undefined {
  if (code === 'ENOTFOUND' && host.startsWith('db.') && host.endsWith('.supabase.co')) {
    return (
      'Это строка Direct connection — она доступна только по IPv6, а Vercel работает по IPv4. ' +
      'Возьми в Supabase вкладку "Transaction pooler": хост вида aws-N-<регион>.pooler.supabase.com, ' +
      'порт 6543, пользователь postgres.<ref>.'
    );
  }
  if (code === '28P01') return 'Неверный пароль базы. Supabase: Settings -> Database -> Reset database password.';
  if (code === 'ETIMEDOUT') return 'Соединение не устанавливается: проверь порт (нужен 6543) и что проект не на паузе.';
  return undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const provided = req.query.secret ?? req.headers.authorization?.replace(/^Bearer /, '');
  if (!env.CRON_SECRET || provided !== env.CRON_SECRET) {
    res.status(403).json({ ok: false, error: 'нужен параметр ?secret=<CRON_SECRET>' });
    return;
  }

  const info: Record<string, unknown> = { ssl: env.DATABASE_SSL };
  try {
    const parsed = new URL(env.DATABASE_URL);
    info.host = parsed.hostname;
    info.port = parsed.port || '(по умолчанию 5432)';
    info.user = parsed.username;
    info.database = parsed.pathname.replace(/^\//, '');
    info.passwordSet = parsed.password.length > 0;
    info.looksLikeTransactionPooler = parsed.port === '6543' && parsed.hostname.includes('pooler');
  } catch {
    info.parseError = 'DATABASE_URL не разбирается как URL';
  }

  try {
    const { rows } = await pool.query<{ now: Date; version: string }>(
      'SELECT now() AS now, version() AS version',
    );
    const tables = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );
    res.status(200).json({
      ok: true,
      connection: info,
      serverTime: rows[0]?.now,
      postgres: rows[0]?.version?.split(' ').slice(0, 2).join(' '),
      publicTables: Number(tables.rows[0]?.count ?? 0),
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    res.status(500).json({
      ok: false,
      connection: info,
      error: err instanceof Error ? err.message : String(err),
      code,
      hint: diagnose(code, String(info.host ?? '')),
    });
  }
}
