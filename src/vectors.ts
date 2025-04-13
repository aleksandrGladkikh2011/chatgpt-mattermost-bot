import fs from 'fs';
import { generateEmbedding } from './openai-wrapper';
import { vectorsLog } from './logging';

import Storage from './storage';
import Vectors from './models/vectors';
import Faqs from './models/faqs';

async function initModules() {
  const storage = new Storage({});
  await storage.init();

  return {
    vectors: new Vectors({}, storage),
    faqs: new Faqs({}, storage),
  };
}

function generateKey(id: number, i: number) {
  return `${id}:${i}`;
}

export async function addTextById(faq: { _id: number, text: string }) {
  const { vectors } = await initModules();
  
  // Разбиваем текст на строки
  const lines = faq.text.split('\n');
  
  for (const [i, line] of lines.entries()) {
    const embedding = await generateEmbedding(line);
    await vectors.uploadData(generateKey(faq._id, i), embedding, line);
    vectorsLog.info({ message: `✅ Добавлен новый документ #${faq._id * 1000 + i}: ${line.slice(0, 50)}...` });
  }

  vectorsLog.info({ message: '🚀 Новый FAQ успешно загружен в Redis!' });
}

export async function deleteById(id: number) {
  const { vectors } = await initModules();

  try {
    // Удаляем все документы с префиксом данного FAQ
    for (let i = 0; i < 100; i++) {
      const key = generateKey(id, i);
      await vectors.deleteData(key);
      vectorsLog.info({ message: `✅ Удалён документ ${key}` });
    }

    vectorsLog.info({ message: '🚀 FAQ успешно удалён из Redis!' });
  } catch (error: any) {
    vectorsLog.error({ message: `❌ Ошибка при удалении FAQ ${id}: ${error.message}`, error: error.message });
  }
}

export async function uploadData() {
  const { vectors, faqs } = await initModules();
  await vectors.createIndex();
  const data: { id: number, text: string }[] = [];
  const faqsData = await faqs.getAll({});

  // Обрабатываем все записи из базы данных
  faqsData.forEach((faq: { _id: number, text: string }) => {
    faq.text.split('\n').forEach((text, index) => {
      data.push({ id: faq._id, text });
    });
  });

  for (const [i, item] of data.entries()) {
    try {
      const embedding = await generateEmbedding(item.text);

      // Уникальный ключ: doc:<faqId>:<lineNumber>
      const key: string = generateKey(item.id, i);

      // Загружаем данные в Redis
      await vectors.uploadData(key, embedding, item.text);
      vectorsLog.info({ message: `✅ Загрузил документ ${key}: ${item.text.slice(0, 50)}...` });
    } catch (error: any) {
      vectorsLog.error({ message: `❌ Ошибка загрузки документа ${item.id}: ${error.message}`, error: error.message });
    }
  }

  vectorsLog.info({ message: '🚀 Данные успешно загружены в Redis!' });
}

export async function queryData(query: string) {
  const { vectors } = await initModules();
  const embedding = await generateEmbedding(query);
  const floatArray = new Float32Array(embedding);
  const vectorBuffer = Buffer.from(floatArray.buffer);
  const results = await vectors.searchIndex(vectorBuffer);
  
  if (!results || !results.length || results[0] === 0) {
    return 'Не знаю такого';
  }

  // Извлекаем количество найденных документов
  const numDocs = results[0] as number;

  vectorsLog.info({ message: '🔍 Найдено документов:', numDocs });

  const response = [];

  for (let i = 1; i < results.length; i += 2) {
    const fields = results[i + 1] as string[];

    // Извлекаем текст из поля
    const textIndex = fields.indexOf('text');
    const text = textIndex !== -1 ? fields[textIndex + 1] : 'Без текста';

    response.push(text);
  }

  return response.join('\n');
}
