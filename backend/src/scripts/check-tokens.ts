import { MongoClient } from 'mongodb';
const MONGO_URI = process.env.MONGO_URI!;

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('renders_manager');

  const users = await db.collection('users').find({}, { projection: { username: 1 } }).toArray();
  const nameById = new Map(users.map(u => [String(u._id), u.username]));

  const toks = await db.collection('oauth_tokens').find({}, { projection: { provider: 1, userId: 1, updatedAt: 1 } }).toArray();
  console.log(`oauth_tokens: ${toks.length}`);
  for (const t of toks) {
    console.log(`  provider=${t.provider}  userId=${t.userId} (${nameById.get(String(t.userId)) ?? '??'})  updated=${t.updatedAt?.toISOString?.() ?? t.updatedAt}`);
  }
  console.log('\nesse _id = 6a3794fb81e6fb54aca72461');
  await client.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
