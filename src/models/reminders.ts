import Model from '../models/model';

class Reminders extends Model {
	constructor(req: any, storage: any) {
		super(req, storage, 'getReminders');
	}
}

export default Reminders;
