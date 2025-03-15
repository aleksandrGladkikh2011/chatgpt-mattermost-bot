import Model from '../models/model';

class Channels extends Model {
	constructor(req: any, storage: any) {
		super(req, storage, 'getChannels');
	}
}

export default Channels;
