import Model from '../models/model';

class ScheduledPrompts extends Model {
	constructor(req: any, storage: any) {
		super(req, storage, 'getScheduledPrompts');
	}
}

export default ScheduledPrompts;
