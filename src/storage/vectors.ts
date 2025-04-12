import Adapter from './adapter';
import { Collection } from 'mongodb';
import mongoClient from './mongo';
import redisClient from './redis';

const COLLECTION_NAME = 'vectors';

class Vectors extends Adapter {
	collection!: Collection;

	constructor(
		public req: object,
		public mongo: typeof mongoClient,
		public redis: typeof redisClient,
	) {
		super(req);
		this.redis = redis;
	}

	async init(forced: boolean = false) {}

    async createIndex() {
		const exists = await this.redis.call('FT._LIST');
		const indexName = process.env.REDIS_INDEX || COLLECTION_NAME;

		if (exists.includes(indexName)) {
			console.log(`⚠️ Индекс "${indexName}" уже существует. Пропуск создания.`);
			return;
		}

        return this.redis.call('FT.CREATE', indexName, 'ON', 'HASH',
			'PREFIX', '1', 'doc:',
            'SCHEMA', 
            'embedding', 'VECTOR', 'FLAT', '6', 
            'TYPE', 'FLOAT32', 'DIM', '1536', 'DISTANCE_METRIC', 'COSINE',
            'text', 'TEXT'
        );
    }

	async uploadData(i: string, vector: number[], text: string) {
		const floatArray = new Float32Array(vector);
        const vectorBuffer = Buffer.from(floatArray.buffer);

		return this.redis.hset(`doc:${i}`, 'embedding', vectorBuffer, 'text', text);
	}

	async searchIndex(vector: Buffer) {
		const indexName = process.env.REDIS_INDEX || COLLECTION_NAME;

        return this.redis.send_command(
			'FT.SEARCH', [
				indexName,                     // Имя индекса                                    // Имя индекса
				'*=>[KNN 2 @embedding $vector]',                   // Поисковый запрос с вектором
				'PARAMS', '2', 'vector', vector,             // Параметры поиска
				'RETURN', '1', 'text',                             // Возвращаем только текст
				'DIALECT', '2'           
			]
		);
    }

	async deleteData(key: string) {
		return this.redis.del(`doc:${key}`);
	}
}

export default Vectors;
