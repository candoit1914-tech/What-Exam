'use strict';
const config = require('../src/config');
const { checkConfig } = require('../src/services/configCheck');
const report = checkConfig(config, process.env);
console.log('What Exam - configuration self-check');
for (const item of report.items) {
  console.log(`[${item.level.toUpperCase()}] ${item.key}: ${item.status}`);
  if (item.level !== 'info' || item.status !== 'set') {
    console.log(`  ${item.problem}`);
    if (item.fix) console.log(`  Fix: ${item.fix}`);
  }
}
console.log(`${report.counts.critical} critical, ${report.counts.warning} warning, ${report.counts.info} info`);
console.log('Credentials, template approval and public reachability are not verified by this local check.');
console.log(report.ok ? 'No critical configuration gaps found.' : 'Fix the critical settings above before sending an exam.');
process.exitCode = report.ok ? 0 : 1;
