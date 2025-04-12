import Model from '../models/model';

class Vectors extends Model {
	constructor(req: any, storage: any) {
		super(req, storage, 'getVectors');
	}

	async searchIndex(query: Buffer) {
		const storageVectors = this.storage.getVectors();
		return storageVectors.searchIndex(query);
	}

	async uploadData(i: string, vector: number[], text: string) {
		const storageVectors = this.storage.getVectors();
		return storageVectors.uploadData(i, vector, text);
	}

	async createIndex() {
		const storageVectors = this.storage.getVectors();
		return storageVectors.createIndex();
	}

	async deleteData(key: string) {
		const storageVectors = this.storage.getVectors();
		return storageVectors.deleteData(key);
	}
}

export default Vectors;
