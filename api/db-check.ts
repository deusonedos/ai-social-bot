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
    res.status(500).json({
      ok: false,
      connection: info,
      error: err instanceof Error ? err.message : String(err),
      code: (err as { code?: string }).code,
    });
  }
}
