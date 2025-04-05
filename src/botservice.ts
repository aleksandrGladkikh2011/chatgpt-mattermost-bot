import 'babel-polyfill'
import 'isomorphic-fetch'
import { WebSocketMessage } from '@mattermost/client';
import { ChatCompletionRequestMessage } from 'openai';
import { DateTime } from 'luxon';

import { continueThread, registerChatPlugin } from './openai-wrapper';
import { mmClient, wsClient, getOlderThreadPosts, getOlderPosts, userIdToName } from './mm-client';
import { GraphPlugin } from './plugins/GraphPlugin';
import { ImagePlugin } from './plugins/ImagePlugin';
import { PluginBase } from './plugins/PluginBase';
import { JSONMessageData, MessageData } from './types';
import { ExitPlugin } from './plugins/ExitPlugin';
import { MessageCollectPlugin } from './plugins/MessageCollectPlugin';
import { startCronJobs } from './crons';

import { botLog, matterMostLog } from './logging';

import { summaryPrompt, summaryDayPrompt, summaryAdvicePrompt } from './summary';
import { getChatMessagesByPosts } from './utils/posts';
import { calculateNextRunDate, WEEK_DAYS, ALL_DAYS } from './utils/time';

import Storage from './storage';
import Channels from './models/channels';
import Prompts from './models/prompts';
import ScheduledPrompts from './models/scheduled_prompts';
import Reminders from './models/reminders';

startCronJobs();

if (!global.FormData) {
    global.FormData = require('form-data')
}

const HANDLE_PROMPTS: { [key: string]: string } = {
    summary: summaryPrompt,
    summary_day: summaryDayPrompt,
    summary_advice: summaryAdvicePrompt,
};

interface Command {
    description: string;
    example: string;
    channel_type: string[];
    fn: (...args: any[]) => Promise<any>;
}

interface ChannelData {
    _id?: string;
    shouldValidateContent: boolean;
    channel_display_name: string;
    prompt: string;
    created_by: string;
}

interface PromptData {
    _id?: string;
    name: string;
    text: string;
    type: string;
    created_by: string;
}

const COMMANDS: { [key: string]: Command } = {
    '!help': {
        description: 'Показать сообщение справки',
        example: '\n!help',
        channel_type: ['D'],
        fn: async () => {
            const helpMessage = Object.entries(COMMANDS)
                .map(([cmd, { description, example, channel_type }]) => `**${cmd}** - ${description}\n${channel_type.includes('D') ? '🔹 Доступно в личных сообщениях' : '🔹 Доступно в треде канала'}\nПример: ${example}`)
                .join('\n\n');

            return {
                botInstructions: `**Список доступных команд:**\n\n${helpMessage}`,
                useFunctions: false,
            };
        }
    },
    '!content_guard': {
        description: 'Установить проверку сообщений для канала',
        example: '\n1. !content_guard set <channel_name> <prompt>\n2. !content_guard list\n3. !content_guard delete <channel_name>',
        channel_type: ['D'],
        fn: async ({ channels }: { channels: Channels }, { post: { message }, sender_name }: { post: { message: string }, sender_name: string }) => {
            const [, action, channel_name, prompt] = split(message, ' ', 3);

            let botInstructions = '⚠️ Неверный формат команды. Используйте `!help` для справки.';

            if (action === 'set' && channel_name && prompt) {
                const existingChannel = await channels.get({ channel_display_name: channel_name }) || {};
                const saveChannelData: ChannelData = {
                    shouldValidateContent: true,
                    channel_display_name: channel_name,
                    prompt: prompt,
                    created_by: sender_name,
                };

                if (existingChannel._id) {
                    await channels.update({ _id: existingChannel._id }, saveChannelData);
                } else {
                    await channels.add(saveChannelData);
                }

                botInstructions = `✅ Проверка контента установлена для **${channel_name}**\n🔹 **Prompt**: ${prompt}\n👤 **Добавил**: ${sender_name}`;
            }

            if (action === 'list') {
                const guards = await channels.getAll({ shouldValidateContent: true });

                if (!guards.length) {
                    botInstructions = 'Вывести пользователю сообщение: ℹ️ Нет установленных проверок контента.';
                } else {
                    const listMessage = guards.map((g: ChannelData) => 
                        `📌 **Канал**: ${g.channel_display_name}\n🔹 **Prompt**: ${g.prompt}\n👤 **Добавил**: ${g.created_by}`
                    ).join('\n\n');
    
                    botInstructions = `📖 **Список активных проверок:**\n\n${listMessage}`;
                }
            }

            if (action === 'delete' && channel_name) {
                const existingChannel: ChannelData = await channels.get({ channel_display_name: channel_name });

                if (!existingChannel) {
                    botInstructions = `⚠️ Проверка для **${channel_name}** не найдена.`;
                } else {
                    if (existingChannel.created_by !== sender_name) {
                        botInstructions = '⚠️ Вы не можете удалить проверку, которую не добавили.';
                    } else {
                        await channels.remove({ _id: existingChannel._id }, true);
                        botInstructions = `🗑 Проверка контента для **${channel_name}** удалена.`;
                    }
                }
            } 

            return {
                botInstructions,
                useFunctions: false,
            };
        }
    },
    '!prompt': {
        description:  `Управление промптами (сохранение, просмотр, удаление)

        📌 **Best practices при создании промптов**:
        • 🔹 Промпт **обязательно должен начинаться со слова**: \`Промпт:\`
        • Формулируй промпт как четкое задание или роль: "Промпт: Ты — аналитик данных. Ответь пользователю..."
        • Добавляй инструкции, что делать при отсутствии цели или проблемы: "Если не указана цель — уточни её."
        • Используй примеры или правила — они помогут сделать поведение модели стабильным
        • Не добавляй лишний контекст — пиши максимально конкретно
        • Можешь использовать маркеры или эмодзи для структурирования ответа
        
        💡 Примеры:
        - "Промпт: Ты — редактор. Проверь текст на орфографические ошибки и предложи улучшения."
        - "Промпт: Если пользователь прислал неполный запрос — задай уточняющие вопросы."`,
        example: '\n1. !prompt save <public|private> <name> <text>\n2. !prompt list\n3. !prompt get <name>\n4. !prompt delete <name>',
        channel_type: ['D'],
        fn: async ({ prompts }: { prompts: Prompts }, { post: { message }, sender_name }: { post: { message: string }, sender_name: string }) => {
            const [, action, typeOrName, nameOrText, promptText] = split(message, ' ', 4);

            let botInstructions = '⚠️ Неверный формат команды. Используйте `!help` для справки.';

            if (action === 'save' && typeOrName && nameOrText && promptText) {
                const type = typeOrName.toLowerCase();

                if (type !== 'public' && type !== 'private') {
                    botInstructions = '⚠️ Тип промпта должен быть `public` или `private`.';
                } else {
                    const promptName = nameOrText;
                    const existingPrompt = await prompts.get({ name: promptName });

                    if (existingPrompt || HANDLE_PROMPTS[promptName]) {
                        botInstructions = `⚠️ Промпт с именем **${promptName}** уже существует.`;
                    } else {
                        await prompts.add({
                            name: promptName,
                            text: promptText,
                            type: type,
                            created_by: sender_name,
                        });

                        botInstructions = `✅ Промпт **${promptName}** (${type}) сохранен.\n👤 **Автор**: ${sender_name}`;
                    }
                }
            }

            if (action === 'list') {
                const allPrompts = await prompts.getAll({});
                const userPrompts = allPrompts.filter((p: PromptData) => p.type === 'public' || p.created_by === sender_name);

                if (!userPrompts.length) {
                    botInstructions = 'ℹ️ У вас нет доступных промптов.';
                } else {
                    const listMessage = userPrompts.map((p: PromptData) =>
                        `📌 **${p.name}** (${p.type})\n👤 **Автор**: ${p.created_by}`
                    ).join('\n\n');

                    botInstructions = `📖 **Список доступных промптов:**\n\n${listMessage}`;
                }
            }

            if (action === 'get' && typeOrName) {
                const prompt = await prompts.get({ name: typeOrName });

                if (HANDLE_PROMPTS[typeOrName]) {
                    botInstructions = `📌 **${typeOrName}** (public)\n👤 **Автор**: system\n📝 **Текст:**\n${HANDLE_PROMPTS[typeOrName]}`;
                } else if (!prompt) {
                    botInstructions = `⚠️ Промпт **${typeOrName}** не найден.`;
                } else {
                    if (prompt.type === 'private' && prompt.created_by !== sender_name) {
                        botInstructions = `⛔ У вас нет доступа к этому промпту.`;
                    } else {
                        botInstructions = `📌 **${prompt.name}** (${prompt.type})\n👤 **Автор**: ${prompt.created_by}\n📝 **Текст:**\n${prompt.text}`;
                    }
                }
            }

            if (action === 'delete' && typeOrName) {
                const prompt = await prompts.get({ name: typeOrName });

                if (HANDLE_PROMPTS[typeOrName]) {
                    botInstructions = '⛔ Вы не можете удалить этот промпт.';
                } else if (!prompt) {
                    botInstructions = `⚠️ Промпт **${typeOrName}** не найден.`;
                } else {
                    if (prompt.created_by !== sender_name) {
                        botInstructions = '⛔ Вы можете удалять только свои промпты.';
                    } else {
                        await prompts.remove({ name: typeOrName });

                        botInstructions = `🗑 Промпт **${typeOrName}** удален.`;
                    }
                }
            }

            return {
                botInstructions,
                useFunctions: false,
            };
        }
    },
    '!schedule_prompt': {
        description: 'Запланировать применение промпта к текущему треду в конце дня',
        example: '\n1. !schedule_prompt <prompt_name>',
        // вызывается только если бот указвыается
        channel_type: ['O', 'P'],
        fn: async (
            { scheduledPrompts, prompts }: { scheduledPrompts: ScheduledPrompts, prompts: Prompts },
            { post: { message, root_id, channel_id, id }, sender_name }: { post: { message: string, root_id: string, channel_id: string, id: string }, sender_name: string }
        ) => {
            const [, , promptName] = message.split(' ', 3);

            if (!promptName) {
                return {
                    botInstructions: '⚠️ Укажите имя промпта. Пример: `!schedule_prompt summary`',
                    useFunctions: false,
                };
            }

            // Проверка, что команда вызвана в треде
            if (!root_id) {
                return {
                    botInstructions: '⚠️ Эту команду можно использовать только внутри треда.',
                    useFunctions: false,
                };
            }

            // Проверка, существует ли такой промпт (public или private)
            const prompt = HANDLE_PROMPTS[promptName] || await prompts.get({
                name: promptName,
                $or: [
                    { type: 'public' },
                    { type: 'private', created_by: sender_name }
                ]
            });

            if (!prompt) {
                return {
                    botInstructions: `⚠️ Промпт с именем **${promptName}** не найден.`,
                    useFunctions: false,
                };
            }

            const mskMidnight = DateTime.now()
                .setZone('Europe/Moscow')
                .startOf('day')
                .toMillis();
            // Проверяем, не существует ли уже запланированный промпт на сегодня в этом треде
            const existing = await scheduledPrompts.get({
                thread_id: root_id,
                run_date: {
                    $gte: mskMidnight,
                    $lt: mskMidnight + 24 * 60 * 60 * 1000,
                },
            });

            if (existing) {
                return { 
                    botInstructions: `⚠️ На сегодня уже запланирован промпт для этого треда: **${existing.prompt_name}**.`,
                    useFunctions: false,
                };
            }

            const now = new Date().getTime();

            await scheduledPrompts.add({
                thread_id: root_id,
                channel_id,
                message_id: id,
                sender_name,
                prompt_name: promptName,
                created_at: now,
                run_date: now,
            });

            return {
                botInstructions: `📌 Промпт **${promptName}** будет применён к этому треду сегодня в конце дня.`,
                useFunctions: false,
            };
        }
    },
    '!reminder': {
        description: `Управление напоминаниями (создание, просмотр, удаление)

        📌 Поддерживаемые команды:
        • !reminder add <HH:mm> <repeat|once> [<days|all>] <prompt_name> — создать напоминание. Days: ${ALL_DAYS.join(', ')}. Выходные дни (sat, sun) используются только при явном намерении.
        • !reminder list — показать все активные напоминания
        • !reminder delete <prompt_name> — удалить напоминание`,

        example: '\n1. !reminder add 09:00 repeat mon,wed,fri daily_meeting\n2. !reminder list\n3. !reminder delete daily_meeting',
        channel_type: ['O', 'P'],

        fn: async (
            { reminders, prompts }: { reminders: Reminders, prompts: Prompts },
            { post: { message, root_id, channel_id, id }, sender_name, botName }: { post: { message: string, root_id: string, channel_id: string, id: string }, sender_name: string, botName: string }
        ) => {
            const [, action, timeOrName, repeatOrPrompt, daysOrPrompt, promptName] = message.replace(`@${botName}`, '').trim().split(' ', 6);
            // Проверка на главный канал
            if (root_id) {
                return {
                    botInstructions: '⚠️ Напоминания можно создавать только в главном канале.',
                    useFunctions: false,
                };
            }

            // 🔸 Добавление напоминания
            if (action === 'add' && timeOrName && repeatOrPrompt) {
                const time = timeOrName;
                const repeat = repeatOrPrompt === 'repeat';

                // Проверяем формат времени
                if (!/^\d{2}:\d{2}$/.test(time)) {
                    return {
                        botInstructions: '⚠️ Время должно быть в формате HH:mm. Пример: `!reminder add 09:00 repeat daily_meeting`',
                        useFunctions: false,
                    };
                }

                const [, minutes] = time.split(':').map(Number);
                if (minutes % 5 !== 0) {
                    return {
                        botInstructions: '⚠️ Время должно быть кратно 5 минутам (например: 09:00, 09:05, 09:10).',
                        useFunctions: false
                    };
                }

                let days: string[];
                let finalPromptName: string;

                // Если указаны дни недели
                if (promptName) {
                    const splitDays = daysOrPrompt.split(',').map(d => d.trim().toLowerCase());

                    days = splitDays.includes('all') ? WEEK_DAYS : splitDays;
                    finalPromptName = promptName;
                } else {
                    // Если дни недели не указаны, рассчитываем текущий или следующий день
                    const now = DateTime.now().setZone('Europe/Moscow');
                    const currentDay = now.toFormat('ccc').toLowerCase();
                    const currentTime = now.toFormat('HH:mm');

                    // Если время ещё не прошло — текущий день
                    if (currentTime <= time) {
                        days = [currentDay];
                    } else {
                        // Если время прошло — следующий день
                        const nextDayIndex = (WEEK_DAYS.indexOf(currentDay) + 1) % WEEK_DAYS.length;
                        const nextDay = WEEK_DAYS[nextDayIndex];
                        days = [nextDay];
                    }

                    finalPromptName = daysOrPrompt;
                }

                // Проверка корректности дней недели
                if (!days.every(d => ALL_DAYS.includes(d))) {
                    return {
                        botInstructions: '⚠️ Некорректные дни недели. Используйте: mon,tue,wed,thu,fri,sat,sun или all.',
                        useFunctions: false,
                    };
                }

                // Проверка существования промпта
                const prompt = HANDLE_PROMPTS[finalPromptName] || await prompts.get({
                    name: finalPromptName,
                    $or: [
                        { type: 'public' },
                        { type: 'private', created_by: sender_name }
                    ]
                });
                
                if (!prompt) {
                    return {
                        botInstructions: `⚠️ Промпт с именем **${finalPromptName}** не найден.`,
                        useFunctions: false,
                    };
                }

                // Проверка на дубликат
                const existing = await reminders.get({ prompt_name: finalPromptName, channel_id: channel_id, active: true });

                if (existing) {
                    return {
                        botInstructions: `⚠️ Напоминание с именем **${finalPromptName}** уже существует.`,
                        useFunctions: false,
                    };
                }

                const now = new Date().getTime();
                const nextRunDate = calculateNextRunDate(time, days);

                await reminders.add({
                    message_id: id,
                    channel_id: channel_id,
                    prompt_name: finalPromptName,
                    created_at: now,
                    run_date: nextRunDate,
                    time,
                    repeat,
                    days,
                    created_by: sender_name,
                    active: true,
                });

                return {
                    botInstructions: `🔔 Напоминание **${finalPromptName}** установлено на ${time} (${repeat ? 'повторяется' : 'одноразовое'}).`,
                    useFunctions: false,
                };
            }

            // 🔸 Список напоминаний
            if (action === 'list') {
                const activeReminders = await reminders.getAll({ channel_id: channel_id, active: true });

                if (!activeReminders.length) {
                    return {
                        botInstructions: 'ℹ️ Нет активных напоминаний.',
                        useFunctions: false,
                    };
                }

                const listMessage = activeReminders.map((r: any) => {
                    // Текущая дата и время в МСК
                    const now = DateTime.now().setZone('Europe/Moscow');
                    const currentDayIndex = now.weekday % 7; // 0 - воскресенье
                    const currentTime = now.toFormat('HH:mm');
                
                    let nextRunDate;

                    if (r.repeat) {
                        // Если повторяемое, ищем ближайший день недели
                        const dayIndexes = r.days.map((day: string) => ALL_DAYS.indexOf(day));
                        
                        // Найдём ближайший день после текущего или следующий день
                        const futureDays = dayIndexes
                            .map((dayIndex: number) => {
                                const daysDiff = (dayIndex - currentDayIndex + 7) % 7;
                                const targetDate = now.plus({ days: daysDiff }).set({
                                    hour: parseInt(r.time.split(':')[0]),
                                    minute: parseInt(r.time.split(':')[1]),
                                    second: 0,
                                    millisecond: 0
                                });
                
                                // Если текущий день и время еще не наступило, берем сегодня
                                if (daysDiff === 0 && currentTime <= r.time) {
                                    return targetDate;
                                }
                                // Если день в будущем
                                return targetDate;
                            })
                            .sort((a: DateTime, b: DateTime) => a.toMillis() - b.toMillis());
                
                        nextRunDate = futureDays[0].toFormat('ccc, HH:mm');
                    } else {
                        // Если одноразовое, берём run_date
                        const reminderDate = DateTime.fromMillis(r.run_date).setZone('Europe/Moscow');

                        if (reminderDate > now) {
                            nextRunDate = reminderDate.toFormat('ccc, HH:mm');
                        } else {
                            nextRunDate = 'истекло';
                        }
                    }
                
                    return `• ${r.prompt_name} — ${r.time} (${r.repeat ? 'повторяется' : 'одноразовое'}) в дни: ${r.days.join(', ')} (следующее: ${nextRunDate})`;
                }).join('\n');
                

                return {
                    botInstructions: `📋 **Список активных напоминаний:**\n${listMessage}`,
                    useFunctions: false,
                };
            }

            // 🔸 Удаление напоминания
            if (action === 'delete' && timeOrName) {
                const promptName = timeOrName;

                const existing = await reminders.get({ prompt_name: promptName, channel_id: channel_id, active: true });

                if (!existing) {
                    return {
                        botInstructions: `⚠️ Напоминание **${promptName}** не найдено.`,
                        useFunctions: false,
                    };
                }

                await reminders.update({ _id: existing._id }, { active: false });

                return {
                    botInstructions: `🗑 Напоминание **${promptName}** удалено.`,
                    useFunctions: false,
                };
            }

            return {
                botInstructions: '⚠️ Неверный формат команды. Используйте `!help` для справки.',
                useFunctions: false,
            };
        }
    }
}

const name = process.env['MATTERMOST_BOTNAME'] || '@chatgpt';
const additionalBotInstructions = process.env['BOT_INSTRUCTION'] || "You are a helpful assistant. Whenever users asks you for help you will " +
    "provide them with succinct answers formatted using Markdown. You know the user's name as it is provided within the " +
    "meta data of the messages.";

/* List of all registered plugins */
const plugins: PluginBase<any>[] = [
    new GraphPlugin("graph-plugin", "Generate a graph based on a given description or topic"),
    new ImagePlugin("image-plugin", "Generates an image based on a given image description."),
    new ExitPlugin("exit-plugin", "Says goodbye to the user and wish him a good day."),
    new MessageCollectPlugin("message-collect-plugin", "Collects messages in the thread for a specific user or time"),
];

function split(text: string, delimeter: string, length: number) {
	let result = text.split(delimeter);
	if (result.length > length) {
	  result = [
	    ...result.slice(0, length),
	    result.slice(length).join(delimeter)
	  ];
	}

	return result;
}

async function onClientMessage(msg: WebSocketMessage<JSONMessageData>, meId: string) {
    const storage = new Storage({});
    await storage.init();
    const channels = new Channels({}, storage);
    const prompts = new Prompts({}, storage);
    const scheduledPrompts = new ScheduledPrompts({}, storage);
    const reminders = new Reminders({}, storage);
    const msgData = msg.data && parseMessageData(msg.data) || {};

    // const postsT = await getOlderPosts(msgData.post, { lookBackTime: 1000 * 60 * 60 * 24 });
    // console.log(postsT)

    if (msg.event !== 'posted' || !meId || msgData.post?.type === 'system_add_to_channel') {
        matterMostLog.debug({ msg: msg })
        return;
    }

    const botName = await userIdToName(meId);
    const channelData = await channels.get({ channel_display_name: msgData.channel_display_name }) || {};
    // TODO: на случай расширения и выносы команд в каналы
    // msgData.channel_type === 'D' - пока только для личных сообщений
    // msgData.channel_type === 'O' - пока только для канала
    const SPLIT_MESSAGE_FOR_BOT = split(msgData.post.message.replace(`@${botName}`, '').trim(), ' ', 2);
    const command: any = SPLIT_MESSAGE_FOR_BOT[0] && COMMANDS[SPLIT_MESSAGE_FOR_BOT[0]];
    // --------------

    let botInstructions = "Your name is " + name + ". " + additionalBotInstructions;
    let useFunctions = true;

    // start typing
    const typing = () => wsClient.userTyping(msgData.post.channel_id, (msgData.post.root_id || msgData.post.id) ?? "")

    // Проверка, что сообщение в канале или треде с упоминанием бота + shouldValidateContent: true
    if (
        !command &&
        channelData.shouldValidateContent &&
        (!msgData.post.root_id || msgData.mentions.includes(meId)) &&
        msgData.post.user_id !== meId
    ) {
        botInstructions = channelData.prompt;
        useFunctions = false;
    } else if (command) {
        typing();

        const typingInterval = setInterval(typing, 2000);

        try {
            if (!command.channel_type.includes(msgData.channel_type)) {
                await mmClient.createPost({
                    message: `⚠️ Команда используется только для: ${msgData.channel_type === 'D' ? 'личных сообщений' : 'канала'}`,
                    channel_id: msgData.post.channel_id,
                    root_id: msgData.post.root_id || msgData.post.id,
                });
    
                return;
            }

            const result = await command.fn({ channels, prompts, scheduledPrompts, reminders }, { post: msgData.post, sender_name: msgData.sender_name, botName });

            botInstructions = result.botInstructions;
            useFunctions = result.useFunctions;

            await mmClient.createPost({
                message: botInstructions,
                channel_id: msgData.post.channel_id,
                root_id: msgData.post.root_id || msgData.post.id,
            });
        } catch (e) {
            botLog.error(e)
            await mmClient.createPost({
                message: "Sorry, but I encountered an internal error when trying to process your message",
                channel_id: msgData.post.channel_id,
                root_id: msgData.post.root_id || msgData.post.id,
            });
        } finally {
            clearInterval(typingInterval)
        }

        return;
    } else if (isMessageIgnored(msgData, meId)) {
        return;
    } else {
         /* The main system instruction for GPT */
        let splitMessage = split(msgData.post.message, ' ', 2);
        let commandName = splitMessage[1];

        // Проверяем, есть ли такой промпт в базе (сначала приватный, затем общий)
        const userPrompt = await prompts.get({ name: commandName, created_by: msgData.sender_name });
        const publicPrompt = userPrompt ? null : await prompts.get({ name: commandName, type: 'public' });

        if (userPrompt || publicPrompt) {
            const selectedPrompt = userPrompt || publicPrompt;
            botInstructions = selectedPrompt.text + (splitMessage[2] ?? '');
            useFunctions = false;
        } else {
            // Это было начало и сделали так
            if (HANDLE_PROMPTS[commandName]) {
                botInstructions = HANDLE_PROMPTS[commandName] + (splitMessage[2] ?? '');
                useFunctions = false;
            }
            // -----------------------
        }
        // -----------------------
    }

    botLog.debug({ botInstructions });

    let lookBackTime;

    if (msgData.channel_type === 'D') {
        lookBackTime = 1000 * 60 * 60 * 24 * 7;
    }

    const posts = await getOlderThreadPosts(msgData.post, { lookBackTime });
    const chatmessages: ChatCompletionRequestMessage[] = await getChatMessagesByPosts(posts, botInstructions, meId);

    typing();
    const typingInterval = setInterval(typing, 2000);

    try {
        const {message, fileId, props} = await continueThread(chatmessages, msgData, { useFunctions });
        botLog.trace({ message });
        // create answer response
        const newPost = await mmClient.createPost({
            message: message,
            channel_id: msgData.post.channel_id,
            props,
            root_id: msgData.post.root_id || msgData.post.id,
            file_ids: fileId ? [fileId] : undefined
        })
        botLog.trace({ msg: newPost })
    } catch (e) {
        botLog.error(e)
        await mmClient.createPost({
            message: "Sorry, but I encountered an internal error when trying to process your message",
            channel_id: msgData.post.channel_id,
            root_id: msgData.post.root_id || msgData.post.id,
        })
    } finally {
        // stop typing
        clearInterval(typingInterval)
    }
}

/**
 * Checks if we are responsible to answer to this message.
 * We do only respond to messages which are posted in a thread or addressed to the bot. We also do not respond to
 * message which were posted by the bot.
 * @param msgData The parsed message data
 * @param meId The mattermost client id
 * @param previousPosts Older posts in the same channel
 */
function isMessageIgnored(msgData: MessageData, meId: string): boolean {
    // we are not in a thread and not mentioned
    if (msgData.post.root_id === '' && !msgData.mentions.includes(meId)) {
        return true;
    }
    if (
        msgData.post.message.includes('@here') ||
        msgData.post.message.includes('@channel') ||
        msgData.post.message.includes('@everyone')
    ) {
        return true;
    }
    // it is our own message
    if (msgData.post.user_id === meId) {
        return true;
    }
    // we are in a direct message channel || a channel and not mentioned
    if (msgData.channel_type === 'D' || msgData.mentions.includes(meId)) {
        return false;
    }
    // we are in a thread but did not participate or got mentioned - we should ignore this message
    return true;
}

/**
 * Transforms a data object of a WebSocketMessage to a JS Object.
 * @param msg The WebSocketMessage data.
 */
function parseMessageData(msg: JSONMessageData): MessageData {
    return {
        channel_display_name: msg.channel_display_name,
        channel_name: msg.channel_name,
        channel_type: msg.channel_type,
        mentions: JSON.parse(msg.mentions ?? '[]'),
        post: JSON.parse(msg.post ?? '{}'),
        sender_name: msg.sender_name
    }
}

/* Entry point */
async function main(): Promise<void> {
    const meId = (await mmClient.getMe()).id;

    botLog.log("Connected to Mattermost.")

    for (const plugin of plugins) {
        if (plugin.setup()) {
            registerChatPlugin(plugin)
            botLog.trace("Registered plugin " + plugin.key)
        }
    }

    wsClient.addMessageListener((e) => onClientMessage(e, meId))
    botLog.trace("Listening to MM messages...")
}

main().catch(reason => {
    botLog.error(reason);
    process.exit(-1)
})
