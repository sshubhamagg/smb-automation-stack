import 'dotenv/config';
import { handleMiningReport } from './src/handler';

const MANAGER_PHONE = '+917017875169';

const NORTH_MINE_MESSAGE = `Mine: North Mine
Labor: 25
Machine A Hours: 6
Machine B Hours: 4
Output (tons): 120
Material: Iron`;

const SOUTH_MINE_MESSAGE = `Mine: South Mine
Labor: 38
Machine A Hours: 5
Machine B Hours: 6
Output (tons): 280
Material: Coal`;

async function run() {
  console.log('--- Test Run: North Mine ---');
  await handleMiningReport({ userId: MANAGER_PHONE, message: NORTH_MINE_MESSAGE });

  console.log('\n--- Test Run: South Mine ---');
  await handleMiningReport({ userId: MANAGER_PHONE, message: SOUTH_MINE_MESSAGE });

  console.log('\n--- Done ---');
}

run().catch((err: unknown) => {
  console.error('Unhandled error:', err);
});
