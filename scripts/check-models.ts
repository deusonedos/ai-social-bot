/**
 * Сверяет src/config/models.ts с живым каталогом OpenRouter.
 *
 * Бесплатный список меняется часто: модель может исчезнуть или перестать быть
 * бесплатной в любой день. Проверяем не только цену, но и модальности —
 * иначе однажды в цепочку попадёт модель вроде google/lyria-3-pro-preview,
 * у которой нулевая цена в полях API, но на выходе аудио, а не текст.
 *
 * Запуск: npm run models:check
 */
import { MODEL_CHAINS, OVERFLOW_CHAINS, type ModelRole, type ModelSpec } from '../src/config/models.js';

interface CatalogModel {
  id: string;
  pricing: Record<string, string>;
  architecture: { input_modalities?: string[]; output_modalities?: string[] };
}

const problems: string[] = [];

function checkSpec(role: string, spec: ModelSpec, catalog: Map<string, CatalogModel>): void {
  const model = catalog.get(spec.id);

  if (!model) {
    problems.push(`[${role}] ${spec.id}: ИСЧЕЗЛА из каталога`);
    return;
  }

  const isFree = Number(model.pricing.prompt ?? 1) === 0 && Number(model.pricing.completion ?? 1) === 0;
  if (spec.free && !isFree) {
    problems.push(
      `[${role}] ${spec.id}: больше НЕ бесплатная (prompt=${model.pricing.prompt}, completion=${model.pricing.completion})`,
    );
  }

  const input = model.architecture.input_modalities ?? [];
  const output = model.architecture.output_modalities ?? [];

  for (const m of spec.expectInput) {
    if (!input.includes(m)) problems.push(`[${role}] ${spec.id}: пропал вход "${m}" (сейчас: ${input.join(', ')})`);
  }
  for (const m of spec.expectOutput) {
    if (!output.includes(m)) {
      problems.push(`[${role}] ${spec.id}: нет выхода "${m}" (сейчас: ${output.join(', ')})`);
    }
  }
  if (spec.expectOutput.includes('text') && output.includes('audio')) {
    problems.push(`[${role}] ${spec.id}: модель отдаёт АУДИО — это не текстовая модель`);
  }
}

async function main(): Promise<void> {
  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) {
    console.error(`не удалось получить каталог: HTTP ${res.status}`);
    process.exit(1);
  }

  const { data } = (await res.json()) as { data: CatalogModel[] };
  const catalog = new Map(data.map((m) => [m.id, m]));

  let checked = 0;
  for (const [role, chain] of Object.entries(MODEL_CHAINS) as [ModelRole, ModelSpec[]][]) {
    for (const spec of chain) {
      checkSpec(role, spec, catalog);
      checked += 1;
    }
  }
  for (const [role, chain] of Object.entries(OVERFLOW_CHAINS)) {
    for (const spec of chain ?? []) {
      checkSpec(`${role}/overflow`, spec, catalog);
      checked += 1;
    }
  }

  if (problems.length === 0) {
    console.log(`✓ Все ${checked} моделей на месте, бесплатны и с ожидаемыми модальностями.`);
    return;
  }

  console.error(`Найдено проблем: ${problems.length} (проверено моделей: ${checked})\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('\nОбнови src/config/models.ts.');
  process.exit(1);
}

void main();
