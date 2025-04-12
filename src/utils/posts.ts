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
        const isBot = threadPost.user_id === meId
        // Обработка реакций
        let parts: string[] = []

        if ((threadPost.type as string) === 'slack_attachment' && Array.isArray(threadPost.props?.attachments)) {
            for (const attachment of threadPost.props.attachments) {
                const title = attachment.title?.trim()
                const text = attachment.text?.trim()
                if (title) parts.push(`🔔 ${title}`)
                if (text) parts.push(text)
            }
        } else {
            const msg = threadPost.props?.originalMessage ?? threadPost.message
            if (msg) parts.push(msg.trim())
        }

        // Обработка реакций
        const reactions = threadPost.metadata?.reactions
        if (reactions && Array.isArray(reactions) && reactions.length > 0) {
            const grouped: Record<string, string[]> = {};
            
            await Promise.all(reactions.map(async (r) => {
                const emoji = r.emoji_name;
                const user = await userIdToName(r.user_id) ?? r.user_id;
                grouped[emoji] = grouped[emoji] || [];
                grouped[emoji].push(user);
            }));

            parts.push(
                "💬 Реакции:\n" +
                Object.entries(grouped)
                    .map(([emoji, users]) => `:${emoji}: от ${users.join(", ")}`)
                    .join("\n")
            )
        }

        const fullContent = parts.join("\n\n")
        const formattedDate = DateTime.fromMillis(threadPost.create_at).toFormat("dd-MM-yyyy HH:mm:ss")

        if (isBot) {
            chatmessages.push({
                role: ChatCompletionRequestMessageRoleEnum.Assistant,
                content: fullContent,
            })
        } else {
            chatmessages.push({
                role: ChatCompletionRequestMessageRoleEnum.User,
                name: await userIdToName(threadPost.user_id),
                content: `${formattedDate} ${fullContent}`,
            })
        }
    }
    
    return chatmessages;
}