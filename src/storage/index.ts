import mongoClient from './mongo';
import redisClient from './redis';

import Prompts from './prompts';
import Channels from './channels';
import ScheduledPrompts from './scheduled_prompts';
import Reminders from './reminders';
import Vectors from './vectors';
import Faqs from './faqs';

import PromiseMap from '../utils/promise';

const STORAGES = [
	{
		name: 'prompts',
		Module: Prompts,
	},
	{
		name: 'channels',
		Module: Channels,
	},
	{
		name: 'scheduledPrompts',
		Module: ScheduledPrompts,
	},
	{
		name: 'reminders',
		Module: Reminders,
	},
	{
		name: 'vectors',
		Module: Vectors,
		redis: true,
	},
	{
		name: 'faqs',
		Module: Faqs,
	}
];

class Storage {
	prompts: any;
	[key: string]: any;

	constructor(req: object) {
		STORAGES.forEach((storage: any) => {
			this[storage.name] = new storage.Module(req, mongoClient, storage.redis ? redisClient : undefined);
		});
	}

	async init() {
		await mongoClient.connect();

		await PromiseMap(
			STORAGES,
			async (storage: any) => this[storage.name].init(),
			{ concurrency: 1 },
		);
	}

	/**
	 * @return {PromptsStorage}
	 */
	getPrompts(): Prompts {
		return this.prompts;
	}

	getChannels(): Channels {
		return this.channels;
	}

	getScheduledPrompts(): ScheduledPrompts {
		return this.scheduledPrompts;
	}

	getReminders(): Reminders {
		return this.reminders;
	}

	getVectors(): Vectors {
		return this.vectors;
	}

	getFaqs(): Faqs {
		return this.faqs;
	}
}

export default Storage;
