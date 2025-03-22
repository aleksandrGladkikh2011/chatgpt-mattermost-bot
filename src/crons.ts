import cron from 'node-cron';
import { ChatCompletionRequestMessage } from 'openai';
import { DateTime } from 'luxon';

import Storage from './storage';
import Prompts from './models/prompts';
import ScheduledPrompts from './models/scheduled_prompts';
import { continueThread } from './openai-wrapper';
import { mmClient, getOlderPosts } from './mm-client';
import { getChatMessagesByPosts } from './utils/posts';
import { cronLog } from './logging';
import { summaryPrompt, summaryDayPrompt, summaryAdvicePrompt } from './summary';

const HANDLE_PROMPTS: { [key: string]: string } = {
    summary: summaryPrompt,
    summary_day: summaryDayPrompt,
    summary_advice: summaryAdvicePrompt,
};

export const startCronJobs = () => {
    const CRON_MSK_22 = '0 19 * * *';

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

            const posts = await getOlderPosts({ id: entry.message_id, create_at: entry.created_at }, {});
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

    cronLog.trace({ message: 'Все крон-задачи запущены.' });
};