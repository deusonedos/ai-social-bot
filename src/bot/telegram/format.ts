const TELEGRAM_MAX_LEN = 4096;
/** Запас на случай, если оценка длины разойдётся с подсчётом Telegram. */
const CHUNK = TELEGRAM_MAX_LEN - 96;

/**
 * Режет ответ на части по границам абзацев, потом строк, и лишь в крайнем
 * случае — по символам.
 *
 * Сообщения отправляются БЕЗ parse_mode. Модель генерирует произвольный текст,
 * и любая некорректная разметка (незакрытая звёздочка, подчёркивание в формуле)
 * приводит к ошибке 400 от Telegram и потере ответа целиком. Простой текст
 * доставляется всегда — это важнее курсива.
 */
export function splitForTelegram(text: string): string[] {
  const clean = text.trim();
  if (clean.length <= CHUNK) return [clean];

  const chunks: string[] = [];
  let rest = clean;

  while (rest.length > CHUNK) {
    let cut = rest.lastIndexOf('\n\n', CHUNK);
    if (cut < CHUNK * 0.5) cut = rest.lastIndexOf('\n', CHUNK);
    if (cut < CHUNK * 0.5) cut = rest.lastIndexOf(' ', CHUNK);
    if (cut < CHUNK * 0.5) cut = CHUNK;

    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) chunks.push(rest);
  return chunks;
}
