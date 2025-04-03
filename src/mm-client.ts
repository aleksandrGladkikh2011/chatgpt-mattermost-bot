import { Client4, WebSocketClient } from "@mattermost/client";
import Log from "debug-level"
import { Post } from '@mattermost/types/lib/posts';

if(!global.WebSocket) {
    global.WebSocket = require('ws')
}

const log = new Log('bot')

const mattermostToken = process.env['MATTERMOST_TOKEN']!
const matterMostURLString = process.env['MATTERMOST_URL']!

log.trace("Configuring Mattermost URL to " + matterMostURLString)

export const mmClient = new Client4()
mmClient.setUrl(matterMostURLString)
mmClient.setToken(mattermostToken)

export const wsClient = new WebSocketClient()
const wsUrl = new URL(mmClient.getWebSocketUrl())
wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss' : 'ws'

new Promise((resolve, reject) => {
    wsClient.addCloseListener(() => reject())
    wsClient.addErrorListener((e: Event) => {
        reject(e)
    })
})
.then(() => {
    process.exit(0)
})
.catch(reason => {
    log.error(reason)
    process.exit(-1)
})

/**
 * this resolves an issue with lost web messages and the client rebooting endlessly -
 * we need to have a listener attached to the client from the start so that it does
 * not reconnect infinitely, internally
 */
function workaroundWebsocketPackageLostIssue(webSocketClient: WebSocketClient) {
    // after a hundred messages it should be ok to unregister - the actual
    // listener should have been added by now.
    let messageCount = 100;
    const firstMessagesListener = (e: any) => {
        if (messageCount-- < 1) {
            webSocketClient.removeMessageListener(firstMessagesListener)
        }
    };
    webSocketClient.addMessageListener(firstMessagesListener)
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
export async function getOlderThreadPosts(refPost: Post | { id: string, create_at: number }, options: { lookBackTime?: number, postCount?: number }) {
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

export async function getOlderPosts(refPost: Post | { channel_id: string, create_at: number }, options: { lookBackTime?: number, postCount?: number }) {
    if (!refPost.channel_id) {
        return [];
    }

    const thread = await mmClient.getPosts(refPost.channel_id, 0, 100, false, false, true)

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
export async function userIdToName(userId: string): Promise<string> {
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

workaroundWebsocketPackageLostIssue(wsClient);

wsClient.initialize(wsUrl.toString(), mattermostToken)