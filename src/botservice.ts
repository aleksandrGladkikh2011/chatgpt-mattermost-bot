import { DateTime} from 'luxon';

import {continueThread, registerChatPlugin} from "./openai-wrapper";
import {mmClient, wsClient} from "./mm-client";
import 'babel-polyfill'
import 'isomorphic-fetch'
import {WebSocketMessage} from "@mattermost/client";
import {ChatCompletionRequestMessage, ChatCompletionRequestMessageRoleEnum} from "openai";
import {GraphPlugin} from "./plugins/GraphPlugin";
import {ImagePlugin} from "./plugins/ImagePlugin";
import {Post} from "@mattermost/types/lib/posts";
import {PluginBase} from "./plugins/PluginBase";
import {JSONMessageData, MessageData} from "./types";
import {ExitPlugin} from "./plugins/ExitPlugin";
import {MessageCollectPlugin} from "./plugins/MessageCollectPlugin";

import {botLog, matterMostLog} from "./logging";

import { summaryPrompt, summaryDayPrompt, summaryAdvicePrompt } from "./summary";

import Storage from "./storage";
import Prompts from "./models/prompts";

if (!global.FormData) {
    global.FormData = require('form-data')
}

const name = process.env['MATTERMOST_BOTNAME'] || '@chatgpt'
const contextMsgCount = Number(process.env['BOT_CONTEXT_MSG'] ?? 2500)
const additionalBotInstructions = process.env['BOT_INSTRUCTION'] || "You are a helpful assistant. Whenever users asks you for help you will " +
    "provide them with succinct answers formatted using Markdown. You know the user's name as it is provided within the " +
    "meta data of the messages."

/* List of all registered plugins */
const plugins: PluginBase<any>[] = [
    new GraphPlugin("graph-plugin", "Generate a graph based on a given description or topic"),
    new ImagePlugin("image-plugin", "Generates an image based on a given image description."),
    new ExitPlugin("exit-plugin", "Says goodbye to the user and wish him a good day."),
    new MessageCollectPlugin("message-collect-plugin", "Collects messages in the thread for a specific user or time"),
]

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
    // example
    const storage = new Storage({});
    await storage.init();
    const prompts = new Prompts({}, storage);

    console.log(await prompts.getAll({}));
    // end example

    if (msg.event !== 'posted' || !meId) {
        matterMostLog.debug({ msg: msg })
        return
    }

    const msgData = parseMessageData(msg.data);

    let lookBackTime;

    if (msgData.channel_type === 'D') {
        lookBackTime = 1000 * 60 * 60 * 24;
    }

    const posts = await getOlderPosts(msgData.post, { lookBackTime })

    if (isMessageIgnored(msgData, meId, posts)) {
        return
    }

    /* The main system instruction for GPT */
    let botInstructions = "Your name is " + name + ". " + additionalBotInstructions
    botLog.debug({botInstructions: botInstructions})

    const splitMessage = split(msgData.post.message, ' ', 2);

    let useFunctions = true;

    if (splitMessage[1] === 'summary') {
        botInstructions = summaryPrompt + (splitMessage[2] ?? '');
        useFunctions = false;
    }

    if (splitMessage[1] === 'summary_day') {
        botInstructions = summaryDayPrompt + (splitMessage[2] ?? '');
        useFunctions = false;
    }

    if (splitMessage[1] === 'summary_advice') {
        botInstructions = summaryAdvicePrompt + (splitMessage[2] ?? '');
        useFunctions = false;
    }

    const chatmessages: ChatCompletionRequestMessage[] = [
        {
            role: ChatCompletionRequestMessageRoleEnum.System,
            content: botInstructions
        },
    ]

    // create the context
    for (const threadPost of posts.slice(-contextMsgCount)) {
        matterMostLog.trace({msg: threadPost})
        if (threadPost.user_id === meId) {
            chatmessages.push({
                role: ChatCompletionRequestMessageRoleEnum.Assistant,
                content: threadPost.props.originalMessage ?? threadPost.message
            })
        } else {
            chatmessages.push({
                role: ChatCompletionRequestMessageRoleEnum.User,
                name: await userIdToName(threadPost.user_id),
                content: `${DateTime.fromMillis(threadPost.create_at).toFormat('dd-MM-yyyy HH:mm:ss')} ${threadPost.message}`
            })
        }
    }

    // start typing
    const typing = () => wsClient.userTyping(msgData.post.channel_id, (msgData.post.root_id || msgData.post.id) ?? "")
    typing()
    const typingInterval = setInterval(typing, 2000)

    try {
        const {message, fileId, props} = await continueThread(chatmessages, msgData, { useFunctions })
        botLog.trace({message})

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
function isMessageIgnored(msgData: MessageData, meId: string, previousPosts: Post[]): boolean {
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
        post: JSON.parse(msg.post),
        sender_name: msg.sender_name
    }
}

/**
 * Looks up posts which where created in the same thread and within a given timespan before the reference post.
 * @param refPost The reference post which determines the thread and start point from where older posts are collected.
 * @param options Additional arguments given as object.
 * <ul>
 *     <li><b>lookBackTime</b>: The look back time in milliseconds. Posts which were not created within this time before the
 *     creation time of the reference posts will not be collected anymore.</li>
 *     <li><b>postCount</b>: Determines how many of the previous posts should be collected. If this parameter is omitted all posts are returned.</li>
 * </ul>
 */
async function getOlderPosts(refPost: Post, options: { lookBackTime?: number, postCount?: number }) {
    const thread = await mmClient.getPostThread(refPost.id, true, false, true)

    let posts: Post[] = [...new Set(thread.order)].map(id => thread.posts[id])
        .sort((a, b) => a.create_at - b.create_at)

    if (options.lookBackTime && options.lookBackTime > 0) {
        posts = posts.filter(a => a.create_at > refPost.create_at - options.lookBackTime!)
    }
    if (options.postCount && options.postCount > 0) {
        posts = posts.slice(-options.postCount)
    }

    return posts
}

const usernameCache: Record<string, { username: string, expireTime: number }> = {}

/**
 * Looks up the mattermost username for the given userId. Every username which is looked up will be cached for 5 minutes.
 * @param userId
 */
async function userIdToName(userId: string): Promise<string> {
    let username: string

    // check if userId is in cache and not outdated
    if (usernameCache[userId] && Date.now() < usernameCache[userId].expireTime) {
        username = usernameCache[userId].username
    } else {
        // username not in cache our outdated
        username = (await mmClient.getUser(userId)).username

        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
            username = username.replace(/[.@!?]/g, '_').slice(0, 64)
        }

        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
            username = [...username.matchAll(/[a-zA-Z0-9_-]/g)].join('').slice(0, 64)
        }

        usernameCache[userId] = {
            username: username,
            expireTime: Date.now() + 1000 * 60 * 5
        }
    }

    return username
}

/* Entry point */
async function main(): Promise<void> {
    const meId = (await mmClient.getMe()).id

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
