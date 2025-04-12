import {Log} from "debug-level";

Log.options({json: true, colors: true})
Log.wrapConsole('bot-ws', {level4log: 'INFO'})
export const  botLog = new Log('bot')
export const openAILog = new Log('open-ai')
export const matterMostLog = new Log('mattermost')
export const cronLog = new Log('cron')
export const vectorsLog = new Log('vectors')
export const imageLog = new Log('image')