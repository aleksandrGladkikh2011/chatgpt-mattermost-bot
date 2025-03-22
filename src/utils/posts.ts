import { ChatCompletionRequestMessage, ChatCompletionRequestMessageRoleEnum } from 'openai';
import { Post } from '@mattermost/types/lib/posts';
import { DateTime } from 'luxon';

import { userIdToName } from '../mm-client';

const contextMsgCount = Number(process.env['BOT_CONTEXT_MSG'] ?? 2500)

export async function getChatMessagesByPosts(posts: Post[], botInstructions: string, meId: string) {
    const chatmessages: ChatCompletionRequestMessage[] = [
        {
            role: ChatCompletionRequestMessageRoleEnum.System,
            content: botInstructions
        },
    ]

    // create the context
    for (const threadPost of posts.slice(-contextMsgCount)) {
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
    
    return chatmessages;
}