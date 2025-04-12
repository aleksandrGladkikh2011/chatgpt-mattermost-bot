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

import { getChatMessagesByPosts } from './utils/posts';
import { split } from './utils/string';

import Storage from './storage';
import Channels from './models/channels';
import Prompts from './models/prompts';
import ScheduledPrompts from './models/scheduled_prompts';
import Reminders from './models/reminders';
import Faqs from './models/faqs';

import { uploadData } from './vectors';

uploadData().catch(console.error);

import { HANDLE_PROMPTS, COMMANDS } from './commands';

startCronJobs();

if (!global.FormData) {
    global.FormData = require('form-data')
}

async function initModules() {
    const storage = new Storage({});
    await storage.init();

    return {
        channels: new Channels({}, storage),
        prompts: new Prompts({}, storage),
        scheduledPrompts: new ScheduledPrompts({}, storage),
        reminders: new Reminders({}, storage),
        faqs: new Faqs({}, storage),
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

async function onClientMessage(msg: WebSocketMessage<JSONMessageData>, meId: string) {
    const { channels, prompts, scheduledPrompts, reminders, faqs } = await initModules();
    const msgData = msg.data && parseMessageData(msg.data) || {};

    if (msg.event !== 'posted' || !meId || msgData.post?.type === 'system_add_to_channel') {
        matterMostLog.debug({ msg: msg })
        return;
    }

    const botName = await userIdToName(meId);
    const channelData = await channels.get({ channel_display_name: msgData.channel_display_name }) || {};
    // TODO: на случай расширения и выносы команд в каналы
    // msgData.channel_type === 'D' - пока только для личных сообщений
    // msgData.channel_type === 'O' - пока только для канала
    const SPLIT_MESSAGE_FOR_BOT = split(msgData.post.message.replace(`@${botName}`, '').trim(), ' ', 1);
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
                    message: `⚠️ Команда используется только для: ${command.channel_type.includes('D') ? 'личных сообщений' : 'канала'}`,
                    channel_id: msgData.post.channel_id,
                    root_id: msgData.post.root_id || msgData.post.id,
                });
    
                return;
            }

            const result = await command.fn({ channels, prompts, scheduledPrompts, reminders, faqs }, { post: msgData.post, sender_name: msgData.sender_name, botName });

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
        const promptName = SPLIT_MESSAGE_FOR_BOT[0];
        // Проверяем, есть ли такой промпт в базе (сначала приватный, затем общий)
        const userPrompt = await prompts.get({ name: promptName, created_by: msgData.sender_name });
        const publicPrompt = userPrompt ? null : await prompts.get({ name: promptName, type: 'public' });

        if (userPrompt || publicPrompt) {
            const selectedPrompt = userPrompt || publicPrompt;
            botInstructions = selectedPrompt.text + (SPLIT_MESSAGE_FOR_BOT[1] ?? '');
            useFunctions = false;
        } else {
            // Это было начало и сделали так
            if (HANDLE_PROMPTS[promptName]) {
                botInstructions = HANDLE_PROMPTS[promptName] + (SPLIT_MESSAGE_FOR_BOT[1] ?? '');
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
    } else if (['O', 'P'].includes(msgData.channel_type)) {
        const now = DateTime.now();
        lookBackTime = now.toMillis() - now.startOf('day').toMillis();
    }
    // const postsT = await getOlderPosts(msgData.post, { lookBackTime });

    const posts = await (SPLIT_MESSAGE_FOR_BOT[0] !== 'monitor_alerts' ? getOlderThreadPosts : getOlderPosts)(msgData.post, { lookBackTime });
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
