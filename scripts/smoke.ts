/** Быстрая проверка чистой логики: не требует ни токенов, ни БД. */
import { splitForTelegram } from '../src/bot/telegram/format.js';
import { stripMention } from '../src/bot/telegram/triggers.js';
import { stripReasoning } from '../src/util/text.js';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const long = Array.from({ length: 400 }, (_, i) => `Строка ${i} с текстом задачи.`).join('\n\n');
const parts = splitForTelegram(long);
check('длинный ответ режется', parts.length > 1, `частей: ${parts.length}`);
check(
  'каждая часть влезает в лимит Telegram',
  parts.every((p) => p.length <= 4096),
  `макс: ${Math.max(...parts.map((p) => p.length))}`,
);
check('текст не теряется при нарезке', parts.join(' ').replace(/\s+/g, '').length === long.replace(/\s+/g, '').length);
check('короткий ответ не режется', splitForTelegram('привет').length === 1);

check('reasoning вырезается', stripReasoning('<think>долго думал</think>Ответ: 42') === 'Ответ: 42');
check('незакрытый think не ломает', stripReasoning('<think>обрыв по max_tokens') === 'обрыв по max_tokens');
check('обычный текст не портится', stripReasoning('  ответ  ') === 'ответ');

check('упоминание убирается', stripMention('@MyBot реши пример', 'MyBot') === 'реши пример');
check('упоминание в середине убирается', stripMention('эй @MyBot помоги', 'MyBot') === 'эй помоги');
check('чужое упоминание остаётся', stripMention('@Other привет', 'MyBot') === '@Other привет');

console.log(failed === 0 ? '\nВсе проверки прошли.' : `\nПровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
