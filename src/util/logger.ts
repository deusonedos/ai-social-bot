import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Красивый вывод через pino-pretty — только локально.
 *
 * В serverless его включать нельзя: pino-pretty лежит в devDependencies и в бандл
 * функции не попадает, а pino поднимает транспорт в отдельном worker-потоке —
 * ненайденный модуль там приводит к зависанию функции, а не к внятной ошибке.
 * На Vercel пишем обычный JSON в stdout, его и так собирают их логи.
 */
const usePretty = !env.SERVERLESS && env.NODE_ENV === 'development';

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(usePretty
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
    : {}),
});
