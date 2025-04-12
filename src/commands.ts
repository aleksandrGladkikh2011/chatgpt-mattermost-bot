import { DateTime } from 'luxon';

import Channels from './models/channels';
import Prompts from './models/prompts';
import ScheduledPrompts from './models/scheduled_prompts';
import Reminders from './models/reminders';
import Faqs from './models/faqs';

import { calculateNextRunDate, WEEK_DAYS, ALL_DAYS } from './utils/time';
import { split } from './utils/string';

import { summaryPrompt, summaryDayPrompt, summaryAdvicePrompt } from './summary';

import { queryData, deleteById, addTextById } from './vectors';

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

export const HANDLE_PROMPTS: { [key: string]: string } = {
    summary: summaryPrompt,
    summary_day: summaryDayPrompt,
    summary_advice: summaryAdvicePrompt,
};

export const COMMANDS: { [key: string]: Command } = {
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
            { post: { message, root_id, channel_id, id }, sender_name, botName }: { post: { message: string, root_id: string, channel_id: string, id: string }, sender_name: string, botName: string }
        ) => {
            const [, promptName] = split(message.replace(`@${botName}`, '').trim(), ' ', 1);

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
        • !reminder add <HH:mm> <repeat|once> [<days|all>] <withHistory> <prompt_name> — создать напоминание. Days: ${ALL_DAYS.join(', ')}. Выходные дни (sat, sun) используются только при явном намерении. withHistory - берём сообщения за текущий день и обрабатываем.
        • !reminder list — показать все активные напоминания
        • !reminder delete <prompt_name> — удалить напоминание`,

        example: '\n1. !reminder add 09:00 repeat mon,wed,fri false daily_meeting\n2. !reminder list\n3. !reminder delete daily_meeting',
        channel_type: ['O', 'P'],

        fn: async (
            { reminders, prompts }: { reminders: Reminders, prompts: Prompts },
            { post: { message, root_id, channel_id, id }, sender_name, botName }: { post: { message: string, root_id: string, channel_id: string, id: string }, sender_name: string, botName: string }
        ) => {
            const [, action, timeOrName, repeatOrPrompt, daysOrPrompt, withHistory, promptName] = split(message.replace(`@${botName}`, '').trim(), ' ', 6);
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
                    withHistory: withHistory === 'true',
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
    },
    '!faq': {
        description: `Управление часто задаваемыми вопросами - FAQ (создание, просмотр, удаление)

        📌 Поддерживаемые команды:
        • !faq <name> — поиск FAQ с ключом "VPN"
        • !faq add <name> <text> — добавление нового FAQ
        • !faq delete <name> — удаление FAQ
        • !faq list — список всех доступных FAQ`,

        example: '\n1. !faq VPN\n2. !faq add VPN Как подключиться к VPN\n3. !faq delete VPN\n4. !faq list',
        channel_type: ['O', 'P', 'D'],
        fn: async (
            { faqs }: { faqs: Faqs },
            { post: { message }, sender_name }: { post: { message: string, root_id: string, channel_id: string, id: string }, sender_name: string, botName: string }
        ) => {
            const [, action, name, text] = split(message, ' ', 3);

            if (['add', 'delete', 'list'].includes(action)) {
                // Добавление нового FAQ
                if (action === 'add' && name && text) {
                    const existing = await faqs.get({ name });

                    if (existing) {
                        return {
                            botInstructions: `⚠️ Вопрос с именем "${name}" уже существует.`,
                            useFunctions: false,
                        };
                    }

                    const faq = await faqs.add({
                        name,
                        text,
                        created_by: sender_name,
                        created_at: Date.now(),
                    });

                    await addTextById({ _id: faq.insertedId, text });

                    return {
                        botInstructions: `✅ FAQ "${name}" успешно добавлен.`,
                        useFunctions: false,
                    };
                }

                // Удаление FAQ
                if (action === 'delete' && name) {
                    const existing = await faqs.get({ name });

                    if (!existing) {
                        return {
                            botInstructions: `⚠️ Вопрос с именем "${name}" не найден.`,
                            useFunctions: false,
                        };
                    }

                    await faqs.remove({ name });
                    await deleteById(existing._id);

                    return {
                        botInstructions: `🗑️ FAQ "${name}" успешно удалён.`,
                        useFunctions: false,
                    };
                }

                // Список всех FAQ
                if (action === 'list') {
                    const allFaqs = await faqs.getAll({});
                    if (allFaqs.length === 0) {
                        return {
                            botInstructions: 'ℹ️ Список FAQ пуст.',
                            useFunctions: false,
                        };
                    }

                    const list = allFaqs.map((faq: any) => `• ${faq.name}`).join('\n');
                    return {
                        botInstructions: `📚 Доступные вопросы:\n${list}`,
                        useFunctions: false,
                    };
                }

                return {
                    botInstructions: '⚠️ Неверный формат команды. Используйте "!help" для справки.',
                    useFunctions: false,
                };
            }

            const [, request] = split(message, ' ', 1);
            // Поиск ответа на вопрос
            const result = await queryData(request);

            return {
                botInstructions: `Вот что я нашёл по твоему запросу:\n${result}`,
                useFunctions: false,
            };
        }
    }
}
