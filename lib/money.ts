export const formatZar=(cents:number)=>new Intl.NumberFormat("en-ZA",{style:"currency",currency:"ZAR"}).format(cents/100);
export function parsePositiveInteger(value:unknown,field="value"):number{if(typeof value!=="number"||!Number.isSafeInteger(value)||value<=0)throw new Error(`${field} must be a positive integer`);return value;}
