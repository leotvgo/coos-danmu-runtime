import {readFileSync} from 'node:fs';
export function workerSource(){return readFileSync(new URL('./worker.cjs',import.meta.url),'utf8');}
