import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI!;
const OWNER = (process.env.OWNER_USERNAME || 'esse').toLowerCase();

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('renders_manager');

  const users = await db.collection('users')
    .find({}, { projection: { username: 1, role: 1, tier: 1 } }).toArray();
  console.log('Usuarios:');
  for (const u of users) console.log(`  _id=${u._id}  user=${u.username}  role=${u.role}  tier=${u.tier}`);

  const owner = users.find(u => (u.username || '').toLowerCase() === OWNER);
  console.log(`\nOwner ('${OWNER}') _id = ${owner?._id ?? '(no encontrado)'}`);

  await client.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
