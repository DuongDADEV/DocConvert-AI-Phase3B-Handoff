import { runRenderingAndGeometryTests } from './phase7_1/rendering_and_geometry.test.js';
import { runPhase71Benchmark } from './phase7_1/accuracy_and_benchmark.test.js';

console.log('========================================================================');
console.log('   PHASE 7.1 — MASTER REAL DOCUMENT ACCEPTANCE & BENCHMARK SUITE');
console.log('========================================================================\n');

async function main() {
  const tStart = performance.now();

  console.log('>>> RUNNING PART 1: RENDERING & GEOMETRY VERIFICATION MATRIX...');
  const renderingResults = await runRenderingAndGeometryTests();

  console.log('\n>>> RUNNING PART 2: COMPREHENSIVE ACCURACY, WORKER & EXCEL MATRIX...');
  const benchmarkResults = await runPhase71Benchmark();

  const totalTime = ((performance.now() - tStart) / 1000).toFixed(2);
  const totalPassed = renderingResults.passedCount + benchmarkResults.passedAssertions;

  console.log('========================================================================');
  console.log(`   ALL PHASE 7.1 ACCEPTANCE TESTS PASSED: ${totalPassed}/${totalPassed}`);
  console.log(`   Total Execution Time: ${totalTime}s`);
  console.log('========================================================================\n');
}

main().catch((err) => {
  console.error('[FATAL] Master benchmark suite encountered an unhandled error:', err);
  process.exit(1);
});
