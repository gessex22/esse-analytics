import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'esse_secret_key_2024';
const BASE = 'http://127.0.0.1:5000';

function tokenFor(id: string, username: string, role = 'todopoderoso') {
  return jwt.sign({ id, username, role, tier: 'premium', isOwner: username === 'esse' }, SECRET, { expiresIn: '10m' });
}

async function countVideos(label: string, token: string) {
  const res = await fetch(`${BASE}/api/videos?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json() as any;
  const arr = data?.data ?? data?.videos ?? data?.results ?? [];
  const total = data?.total ?? data?.pagination?.total ?? data?.metadata?.[0]?.total ?? arr.length;
  console.log(`  ${label}: HTTP ${res.status} → items=${arr.length}, total=${total} (keys: ${Object.keys(data).join(',')})`);
}

async function main() {
  console.log('Scoping test /api/videos:');
  await countVideos('owner (esse)', tokenFor('6a3794fb81e6fb54aca72461', 'esse'));
  await countVideos('otro (test2)', tokenFor('6a3e55dfa17d98d7e2af4c49', 'test2'));
}
main().catch(e => { console.error(e.message); process.exit(1); });
