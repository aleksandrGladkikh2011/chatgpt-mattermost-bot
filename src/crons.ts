import cron from 'node-cron';
import { ChatCompletionRequestMessage } from 'openai';
import { DateTime } from 'luxon';

import Storage from './storage';
import Prompts from './models/prompts';
import ScheduledPrompts from './models/scheduled_prompts';
import Reminders from './models/reminders';

import { continueThread } from './openai-wrapper';
import { mmClient, getOlderThreadPosts } from './mm-client';
import { getChatMessagesByPosts } from './utils/posts';
import { cronLog } from './logging';
import { summaryPrompt, summaryDayPrompt, summaryAdvicePrompt } from './summary';
import { calculateNextRunDate } from './utils/time';

const HANDLE_PROMPTS: { [key: string]: string } = {
    summary: summaryPrompt,
    summary_day: summaryDayPrompt,
    summary_advice: summaryAdvicePrompt,
};

export const startCronJobs = () => {
    const CRON_MSK_22 = '0 19 * * *';
    // Проверка тредов в конце дня и применение промптов
    cron.schedule(CRON_MSK_22, async () => {
        const meId = (await mmClient.getMe()).id;
        const storage = new Storage({});
        await storage.init();
        const scheduledPrompts = new ScheduledPrompts({}, storage);
        const prompts = new Prompts({}, storage);
        const mskMidnight = DateTime.now()
            .setZone('Europe/Moscow')
            .startOf('day')
            .toMillis();

        const todayRange = {
            $gte: mskMidnight,
            $lt: mskMidnight + 24 * 60 * 60 * 1000,
        };

        const entries = await scheduledPrompts.getAll({
            run_date: todayRange,
            finished: { $ne: true },
        });

        cronLog.trace({ message: `[CRON] Начало выполнения: ${entries.length} запланированных промптов` });

        for (const entry of entries) {
            const prompt = HANDLE_PROMPTS[entry.prompt_name] ?
                { text: HANDLE_PROMPTS[entry.prompt_name] } :
                await prompts.get({ 
                    name: entry.prompt_name,
                    $or: [
                        { type: 'public' },
                        { type: 'private', created_by: entry.sender_name }
                    ]
                });

            if (!prompt) {
                cronLog.trace({ message: `⚠️ Промпт ${entry.prompt_name} не найден для ${entry.thread_id}` });
                continue;
            }

            const posts = await getOlderThreadPosts({ id: entry.message_id, create_at: entry.created_at }, {});
            const chatmessages: ChatCompletionRequestMessage[] = await getChatMessagesByPosts(posts, prompt.text, meId);
            const { message, props } = await continueThread(chatmessages, { channel_id: entries.channel_id, id: entries.message_id, create_at: entry.created_at }, { useFunctions: false });

            try {
                await mmClient.createPost({
                    message,
                    channel_id: entry.channel_id,
                    props,
                    root_id: entry.thread_id,
                });

                await scheduledPrompts.update(
                    { _id: entry._id },
                    { finished: true, finished_at: Date.now() }
                );
            } catch (err) {
                cronLog.trace({ message: `❌ Ошибка при применении промпта к треду ${entry.thread_id}:`, error: err });
            }

            cronLog.trace({ entry });
        }

        cronLog.trace({ message: `[CRON] Выполнено ${entries.length} запланированных промптов` });
    });
    const CRON_EVERY_FIVE_MINUTES = '*/5 * * * *';
    // Проверка напоминаний и применение промптов
    cron.schedule(CRON_EVERY_FIVE_MINUTES, async () => {
        const meId = (await mmClient.getMe()).id;
        const storage = new Storage({});
        await storage.init();
        const reminders = new Reminders({}, storage);
        const prompts = new Prompts({}, storage);
        const now = DateTime.now();

        const activeReminders = await reminders.getAll({ run_date: { $lte: now.toMillis() }, active: true });

        cronLog.trace({ message: `[CRON] Начало выполнения: ${activeReminders.length} запланированных напоминаний` });

        await Promise.all(
            activeReminders.map(async (entry: any) => {
                const prompt = HANDLE_PROMPTS[entry.prompt_name] ?
                    { text: HANDLE_PROMPTS[entry.prompt_name] } :
                    await prompts.get({ 
                        name: entry.prompt_name,
                        $or: [
                            { type: 'public' },
                            { type: 'private', created_by: entry.sender_name }
                        ]
                    });

                if (!prompt) {
                    cronLog.trace({ message: `⚠️ Промпт ${entry.prompt_name} не найден для ${entry.thread_id}` });
                    return;
                }

                // const posts = await getOlderThreadPosts({ id: entry.message_id, create_at: entry.created_at }, {});
                // без постов, потому что нет треда и хотим сделать больше как оповещение
                const chatmessages: ChatCompletionRequestMessage[] = await getChatMessagesByPosts([], prompt.text, meId);
                const { message, props } = await continueThread(chatmessages, { channel_id: entry.channel_id, id: entry.message_id, create_at: entry.created_at }, { useFunctions: false });

                try {
                    await mmClient.createPost({
                        message,
                        channel_id: entry.channel_id,
                        props,
                        root_id: entry.thread_id,
                    });

                    if (entry.repeat) {
                        // Обновляем дату следующего запуска
                        const nextRunDate = calculateNextRunDate(entry.time, entry.days);
                        await reminders.update({ _id: entry._id }, { run_date: nextRunDate });
                        cronLog.trace({ message: `🔄 Напоминание "${entry.prompt_name}" обновлено на следующий запуск: ${nextRunDate}` });
                    } else {
                        // Если одноразовое — деактивируем
                        await reminders.update({ _id: entry._id }, { active: false, finished_at: Date.now() });
                        cronLog.trace({ message: `✅ Одноразовое напоминание "${entry.prompt_name}" завершено.` });
                    }
                } catch (err) {
                    cronLog.trace({ message: `❌ Ошибка при применении промпта к треду ${entry.thread_id}:`, error: err });
                }

                cronLog.trace({ entry });
            })
        );

        cronLog.trace({ message: `[CRON] Выполнено ${activeReminders.length} запланированных напоминаний` });
    });

    cronLog.trace({ message: 'Все крон-задачи запущены.' });
};