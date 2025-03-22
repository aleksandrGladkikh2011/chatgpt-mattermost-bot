import Adapter from './adapter';
import { Collection } from 'mongodb';
import mongoClient from './mongo';

const COLLECTION_NAME = 'scheduled_prompts';

interface ScheduledPrompt {
    thread_id: string;
    channel_id: string;
    message_id: string;
    sender_name: string;
    prompt_name: string;
    created_at: Date;
    run_date: number;
  }

class ScheduledPrompts extends Adapter {
	collection!: Collection;

	constructor(
		public req: object,
		public mongo: typeof mongoClient,
	) {
		super(req);
		this.mongo = mongo;
	}

	async init(forced: boolean = false) {
		this.collection = this.mongo.db.collection(COLLECTION_NAME);

		if (forced || !this.mongo[`initialized_${this.constructor.name}`]) {
			await this.mongo.createCollection(COLLECTION_NAME);

			this.mongo[`initialized_${this.constructor.name}`] = true;
		}
	}

	async add(data: ScheduledPrompt) {
		return this.collection.insertOne(data);
	}
}

export default ScheduledPrompts;
