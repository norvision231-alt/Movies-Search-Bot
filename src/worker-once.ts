import mongoose from 'mongoose';
import { ensureDbConnected } from './index';
import { runWorkerCycle } from './scheduler/worker';
import { AppSettings } from './database/models';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  console.log('🚀 Starting GitHub Actions Worker...');
  const startedAt = Date.now();
  const MAX_RUN_MS = 25 * 60 * 1000; // 25 mins max per Actions run

  try {
    await ensureDbConnected();

    while (Date.now() - startedAt < MAX_RUN_MS) {
      const s: any = await AppSettings.findOne({ key: 'global' }).lean();
      if (s && !s.autoPublishEnabled && !s.autoSeedingEnabled) {
        console.log('⏸️ Both Auto-Publish and Auto-Seeding are paused.');
        break;
      }

      const intervalMins = Math.max(1, Number(s?.publishIntervalMinutes || 1));
      await runWorkerCycle(false);

      // If admin set >= 15 mins, 1 check per 15-min GitHub cron run is enough
      if (intervalMins >= 15) {
        break;
      }

      const fresh: any = await AppSettings.findOne({ key: 'global' }).lean();
      const lastPub = fresh?.lastPublishAt ? new Date(fresh.lastPublishAt).getTime() : Date.now();
      const nextDueInMs = lastPub + intervalMins * 60 * 1000 - Date.now();
      const remainingRunMs = MAX_RUN_MS - (Date.now() - startedAt);

      if (remainingRunMs < 15000) {
        break;
      }

      const waitMs = Math.max(5000, Math.min(nextDueInMs, remainingRunMs));
      if (Date.now() - startedAt + waitMs >= MAX_RUN_MS) {
        break;
      }

      console.log(`⏳ Waiting ${Math.ceil(waitMs / 1000)}s for next batch...`);
      await sleep(waitMs);
    }

    console.log('✅ Worker Run Completed Successfully.');
  } catch (err) {
    console.error('❌ Worker Run Failed:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
    process.exit();
  }
};

main();
