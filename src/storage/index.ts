import mongoClient from './mongo';

import Prompts from './prompts';
import Channels from './channels';
import ScheduledPrompts from './scheduled_prompts';

import PromiseMap from '../utils/promise';

const STORAGES = [
	{
		name: 'prompts',
		Module: Prompts,
		init: true,
	},
	{
		name: 'channels',
		Module: Channels,
		init: true,
	},
	{
		name: 'scheduledPrompts',
		Module: ScheduledPrompts,
		init: true,
	}
];

class Storage {
	prompts: any;
	[key: string]: any;

	constructor(req: object) {
		STORAGES.forEach((storage: any) => {
			this[storage.name] = new storage.Module(req, mongoClient);
		});
	}

	async init() {
		await mongoClient.connect();

		await PromiseMap(
			STORAGES.filter((storage: any) => storage.init),
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
}

export default Storage;
