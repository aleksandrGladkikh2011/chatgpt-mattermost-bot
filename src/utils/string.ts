export function split(text: string, delimeter: string, length: number) {
	let result = text.split(delimeter);
	if (result.length > length) {
	  result = [
	    ...result.slice(0, length),
	    result.slice(length).join(delimeter)
	  ];
	}

	return result;
}
