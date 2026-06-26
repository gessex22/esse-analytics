import { db } from '../db/database';

const rows = db.prepare(`SELECT * FROM platform_config`).all();
console.log('platform_config:', JSON.stringify(rows, null, 2));
