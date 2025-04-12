import Model from '../models/model';

class Faqs extends Model {
	constructor(req: any, storage: any) {
		super(req, storage, 'getFaqs');
	}
}

export default Faqs;
