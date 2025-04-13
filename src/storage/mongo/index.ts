// Native and third party modules and dependencies
import { ObjectId, MongoClient, Db } from 'mongodb';
// @ts-ignore
import config from 'config';
import Log from "debug-level"
// Logger
const log = new Log('mongo')
// Config
const configLocal: MongoConfig = config.get('mongodb');
// Interfaces
interface MongoConfig {
	user: string;
	password: string;
	database: string;
	port: number;
	replicaSet: string;
	hosts: string[];
	readPreference?: string;
}

function bytesToMegabytes(bytes: number) {
	return bytes / (1024 * 1024);
}

export class MongoClientLocal {
	dbName: string | undefined;
	url!: string;
	ObjectID!: typeof ObjectId;
	client!: MongoClient;
	db!: Db;

	constructor() {
		let auth;

		const MONGO_DB = process.env.MONGO_DB;
		const MONGO_URI = process.env.MONGO_URI;

		if (MONGO_URI && !MONGO_DB) {
			log.error('EMPTY_MONGO_DB_NAME', { method: 'init' });
		}

		if (MONGO_URI) {
			this.dbName = MONGO_DB;
			this.url = MONGO_URI;

			if (this.url.endsWith('w=majority')) {
				this.url += '&readPreference=secondaryPreferred';
			}
		} else {
			const config: MongoConfig = {
				user: process.env.MONGO_USER || configLocal.user,
				password: process.env.MONGO_PASSWORD || configLocal.password,
				database: process.env.MONGO_DB || configLocal.database,
				port: process.env.MONGO_PORT ? Number(process.env.MONGO_PORT) : configLocal.port,
				replicaSet: process.env.MONGO_REPLICA_SET || configLocal.replicaSet,
				hosts: process.env.MONGO_HOSTS ? JSON.parse(process.env.MONGO_HOSTS) : configLocal.hosts,
			};

			if (process.env.MONGO_HOST_STR) {
				config.hosts = process.env.MONGO_HOST_STR.split(',');
			}

			if (!config) {
				log.error('EMPTY_CONFIG', { method: 'init' });
				return;
			}

			if (config.user && config.password) {
				auth = `${config.user}:${config.password}`;
			}

			const hostsList = (config.hosts || []).map((host) => `${host}:${config.port}`).join(',');
			const opts: string[] = [];
			if (auth) {
				opts.push(`authSource=${config.database}`);
			}

			if (config.replicaSet) {
				opts.push(`replicaSet=${config.replicaSet}`);

				if (!config.readPreference) {
					opts.push('readPreference=secondaryPreferred');
				}
			}

			if (config.readPreference) {
				opts.push(`readPreference=${config.readPreference}`);
			}

			this.dbName = config.database;
			this.url = `mongodb://${auth ? `${auth}@` : ''}${hostsList}/${this.dbName}${opts.length > 0 ? `?${opts.join('&')}` : ''}`;
		}

		log.info('Mongo config', { config: this.url.replace(/:\/\/.*@/g, '://***@'), method: 'init' });

		this.ObjectID = ObjectId;
	}

	async connect() {
		if (!this.client) {
			this.client = await MongoClient.connect(this.url, {
				waitQueueTimeoutMS: 120000,
			});
			this.db = this.client.db(this.dbName);
			this.client.on('error', (err) => log.error('Mongo client error', { err, method: 'disconnect' }));
		}
	}

	async createCollection(name: string) {
		const collections = await this.db.listCollections().toArray();
		const collectionNames = collections.map((collection) => collection.name);

		if (!collectionNames.includes(name)) {
			return this.db.createCollection(name);
		} else {
			log.debug({ message: 'Collection already exists', name, method: 'createCollection' });
			return this.db.collection(name);
		}
	}

	async getCollectionsSize() {
		const collections = await this.db.listCollections().toArray();
		const metrics = collections.map(async (coll) => {
			const stats = await this.db.collection(coll.name).stats();
			return {
				name: coll.name,
				sizeMb: bytesToMegabytes(stats.size),
				indexSizeMB: bytesToMegabytes(stats.totalIndexSize),
			};
		});

		return Promise.all(metrics);
	}
}

export default new MongoClientLocal() as any;
