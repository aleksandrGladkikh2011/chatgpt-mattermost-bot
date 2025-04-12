import IoRedis from 'ioredis';
import config from 'config';

const configLocal: any = config.get('redisdb');

const RECONNECT_WITH_RESEND_COMMANDS = 2;
const NOT_RECONNECT = 0;
const RECONNECT_TRIGGER_MS = 1000;
const RECONNECTION_REBOOT_TIMEOUT = 30000;

const reconnectOnError = (err: any) => (err.message?.startsWith('READONLY') && RECONNECT_WITH_RESEND_COMMANDS) || NOT_RECONNECT;

class Redis {
	sentinels: any;
	name: string | undefined;
	password: string | undefined;
	role: string | undefined;
	uri: string | undefined;
	host: any;
	port: any;
	options: any;
	redis: any;

	constructor() {
		if (!process.env.REDIS_URI) {
			this.sentinels = process.env.REDIS_SENTINELS ? JSON.parse(process.env.REDIS_SENTINELS) : undefined;
			this.name = process.env.REDIS_NAME || undefined;
			this.password = process.env.REDIS_PASSWORD || undefined;
			this.role = process.env.REDIS_ROLE || undefined;
		} else {
			this.uri = process.env.REDIS_URI || undefined;
		}

		// local
		this.host = process.env.REDIS_HOST || configLocal.host;
		this.port = process.env.REDIS_PORT || configLocal.port;
		this.options = process.env.REDIS_OPTIONS ? JSON.parse(process.env.REDIS_OPTIONS) : configLocal.options;
	}

	listeners() {
		let rebootTimer: NodeJS.Timeout | null = null;

		this.redis.on('error', (err: any) => {
			if (err.code !== 'ECONNREFUSED') {
				// log.error('REDIS_ERROR_ECONNREFUSED', { err, method: 'createClient' });
			}
		});
		this.redis.on('reconnecting', (ms: number) => {
			if (ms >= RECONNECT_TRIGGER_MS) {
				// log.error('REDIS_CONNECTION_LOST', { method: 'createClient' });
			}

			if (!rebootTimer) {
				rebootTimer = setTimeout(() => {
					// log.error('REDIS_CONNECTION_RESET', { method: 'createClient' });
					process.exit(1);
				}, RECONNECTION_REBOOT_TIMEOUT);
			}
		});
		this.redis.on('ready', () => {
			if (rebootTimer) {
				clearTimeout(rebootTimer);
				rebootTimer = null;
			}
		});
	}

	init() {
		if (this.sentinels) {
            // @ts-ignore
			this.redis = new IoRedis({
				sentinels: this.sentinels,
				name: this.name,
				password: this.password,
				role: this.role,
			});
		} else if (this.uri) {
			this.redis = new IoRedis(this.uri);
		} else {
			this.redis = new IoRedis(this.host, this.port, { ...this.options, reconnectOnError });
		}

		this.listeners();

		return this.redis;
	}
}

export default new Redis().init();
