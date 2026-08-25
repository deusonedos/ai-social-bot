import { env } from '../config/env.js';
import { logger } from '../util/logger.js';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export interface SearchResponse {
  query: string;
  /** Краткая выжимка от самого Tavily — экономит токены контекста. */
  answer?: string;
  results: SearchResult[];
}

/**
 * Поиск через Tavily.
 *
 * Выбран из-за единственного бесплатного тарифа без карты: 1000 запросов в месяц.
 * У Brave бесплатный тариф закрыли в феврале 2026, а встроенный веб-поиск
 * OpenRouter платный даже для бесплатных моделей ($0.007 за запрос).
 */
export async function search(query: string): Promise<SearchResponse | null> {
  if (!env.TAVILY_API_KEY) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.TAVILY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        // Готовая выжимка: дешевле по токенам, чем скармливать модели все страницы.
        include_answer: true,
        search_depth: 'basic',
        max_results: env.SEARCH_MAX_RESULTS,
      }),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, 'поиск Tavily вернул ошибку');
      return null;
    }

    const json = (await res.json()) as {
      answer?: string;
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };

    const results = (json.results ?? [])
      .filter((r) => r.url && r.content)
      .map((r) => ({
        title: r.title ?? '',
        url: r.url!,
        // Обрезаем: контекст у нас намеренно небольшой, а страниц несколько.
        content: r.content!.slice(0, 800),
      }));

    if (results.length === 0 && !json.answer) return null;

    logger.info({ query, found: results.length }, 'поиск выполнен');
    return { query, answer: json.answer, results };
  } catch (err) {
    // Поиск — улучшение, а не обязательное звено: если он недоступен,
    // отвечаем как обычно, честно предупредив об устаревших данных.
    logger.warn({ err }, 'поиск не удался');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Список источников, который дописывается к ответу.
 *
 * Составляем его сами, а не просим модель: она выдавала «Источники: [1], [2]»
 * без единого адреса, и ссылки получались некликабельными. Здесь адреса точные
 * по построению, а Telegram сам делает ссылку из голого URL в обычном тексте —
 * parse_mode для этого не нужен.
 */
export function formatSources(sr: SearchResponse, limit = 3): string {
  const urls = [...new Set(sr.results.map((r) => r.url))].slice(0, limit);
  if (urls.length === 0) return '';
  return `\n\nИсточники:\n${urls.join('\n')}`;
}

/** Готовит найденное для подстановки в контекст модели. */
export function formatForContext(sr: SearchResponse): string {
  const lines = [`Результаты поиска в интернете по запросу «${sr.query}» (получены только что):`];

  if (sr.answer) lines.push('', `Краткая выжимка: ${sr.answer}`);

  if (sr.results.length > 0) {
    lines.push('', 'Источники:');
    for (const [i, r] of sr.results.entries()) {
      lines.push(`${i + 1}. ${r.title} — ${r.url}`, r.content, '');
    }
  }

  return lines.join('\n');
}
