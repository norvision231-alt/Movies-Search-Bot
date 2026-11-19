import mongoose from 'mongoose';
import { ensureDbConnected } from './index';
import { runWorkerCycle } from './scheduler/worker';

const main = async () => {
  console.log('🚀 Starting GitHub Actions Worker Cycle...');
  try {
    await ensureDbConnected();
    await runWorkerCycle(true);
    console.log('✅ Worker Cycle Completed Successfully.');
  } catch (err) {
    console.error('❌ Worker Cycle Failed:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
    process.exit();
  }
};

main();
