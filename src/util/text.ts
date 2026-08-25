/**
 * Reasoning-модели иногда отдают размышления прямо в content вместо отдельного
 * поля `reasoning`. Пользователю они не нужны — он ждёт ответ, а не протокол.
 *
 * Живёт в утилитах, а не в пайплайне: функция чистая и не должна тянуть за собой
 * конфигурацию окружения.
 */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    // Незакрытый тег означает, что модель уперлась в max_tokens посреди размышления.
    .replace(/<\/?(think|reasoning)>/gi, '')
    .trim();
}
