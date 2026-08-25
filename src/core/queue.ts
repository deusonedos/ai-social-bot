import { logger } from '../util/logger.js';

export interface Job {
  id: string;
  run: () => Promise<void>;
}

/**
 * Очередь в памяти с ограничением параллелизма.
 *
 * Почему очередь нужна с первого дня: бесплатные модели отвечают 5–30 секунд,
 * а Telegram считает вебхук провалившимся по таймауту и присылает апдейт заново.
 * Приём события и его обработка обязаны быть разнесены.
 *
 * Почему пока в памяти, а не BullMQ: для одного инстанса Redis — лишняя
 * зависимость. Идемпотентность всё равно живёт в Postgres, так что потеря
 * очереди при рестарте не приводит к дублям, только к потере незавершённых задач.
 * Интерфейс совместим с BullMQ — замена будет локальной.
 */
export class TaskQueue {
  private readonly pending: Job[] = [];
  private active = 0;

  constructor(private readonly concurrency: number) {}

  push(job: Job): void {
    this.pending.push(job);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.active += 1;

      void job
        .run()
        .catch((err) => logger.error({ err, jobId: job.id }, 'задача упала'))
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  get depth(): number {
    return this.pending.length + this.active;
  }
}
