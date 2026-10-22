// Node consumers keep canonical Chinese values; only the browser installs a UI locale.
export const t=value=>globalThis.PMI18n?.t(value)??value;
export const ui=(strings,...values)=>globalThis.PMI18n?.ui(strings,...values)??String.raw({raw:strings},...values);
export const locale=()=>globalThis.PMI18n?.locale||'zh-CN';
export const message=value=>globalThis.PMI18n?.message(value)??value;
export const enumLabel=value=>t(value);
