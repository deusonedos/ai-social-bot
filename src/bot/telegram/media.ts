import type { Api } from 'grammy';
import type { Message, PhotoSize } from 'grammy/types';
import { env } from '../../config/env.js';
import type { Attachment } from '../../core/types.js';
import { logger } from '../../util/logger.js';

/**
 * Берём НЕ самый большой размер, а предпоследний (обычно ~800–1280px).
 * Для распознавания задачи или текста этого достаточно, а вес и время
 * загрузки меньше в разы — при том что картинка потом едет в модель base64.
 */
export function pickPhotoSize(sizes: PhotoSize[]): PhotoSize | undefined {
  if (sizes.length === 0) return undefined;
  const sorted = [...sizes].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return sorted[Math.max(0, sorted.length - 2)];
}

/**
 * Собирает картинки из сообщения и из того, на которое отвечают.
 *
 * Второй случай в группах основной: у фото без подписи нельзя упомянуть бота,
 * поэтому люди отвечают на фото текстом «@bot реши».
 */
export async function collectImages(api: Api, token: string, msg: Message): Promise<Attachment[]> {
  const candidates: PhotoSize[] = [];

  const own = msg.photo ? pickPhotoSize(msg.photo) : undefined;
  if (own) candidates.push(own);

  const quoted = msg.reply_to_message?.photo ? pickPhotoSize(msg.reply_to_message.photo) : undefined;
  if (quoted) candidates.push(quoted);

  const attachments: Attachment[] = [];
  for (const size of candidates.slice(0, env.MAX_IMAGES_PER_MESSAGE)) {
    const attachment = await download(api, token, size.file_id);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}

async function download(api: Api, token: string, fileId: string): Promise<Attachment | null> {
  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) return null;

    if (file.file_size && file.file_size > env.MAX_IMAGE_BYTES) {
      logger.warn({ size: file.file_size }, 'изображение слишком большое, пропускаю');
      return null;
    }

    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!res.ok) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > env.MAX_IMAGE_BYTES) return null;

    return {
      kind: 'image',
      data: buf.toString('base64'),
      mimeType: guessMime(file.file_path),
      bytes: buf.byteLength,
    };
  } catch (err) {
    logger.warn({ err, fileId }, 'не удалось скачать изображение');
    return null;
  }
}

function guessMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Задел под голосовые.
 *
 * Всё, что останется сделать: скачать `msg.voice` (Telegram отдаёт ogg/opus),
 * перегнать через ffmpeg в mp3 16 кГц моно — OpenRouter формально принимает ogg,
 * но оговаривает, что не каждая модель поддерживает каждый формат, — и вернуть
 * Attachment с kind: 'audio'. Дальше пайплайн отправит его в роль 'audio'
 * (модели уже прописаны в config/models.ts), получит расшифровку и прогонит
 * её обычным текстовым путём, чтобы история осталась текстовой.
 *
 * Важно про группы: у голосовых не бывает подписи, значит упомянуть в них бота
 * нельзя и privacy mode их не пропустит. Единственный путь — reply на голосовое.
 */
export async function collectAudio(_api: Api, _token: string, _msg: Message): Promise<Attachment[]> {
  return [];
}
