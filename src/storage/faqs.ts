import Adapter from './adapter';
import { Collection } from 'mongodb';
import mongoClient from './mongo';

const COLLECTION_NAME = 'faqs';

interface Faq {
    name: string;
    text: string;
    created_by: string;
    created_at: number;
}

class Faqs extends Adapter {
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

	async add(data: Faq) {
		return this.collection.insertOne(data);
	}
}

export default Faqs;
