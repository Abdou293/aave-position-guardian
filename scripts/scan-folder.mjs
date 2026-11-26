// Full secret scan of the working folder.
//
// Local secret files (.env, .env.local, ...) are EXPECTED to hold real secrets on a
// developer machine. A finding in one of them is accepted ONLY if git confirms that
// the file is ignored AND not tracked, i.e. it can never be committed or pushed.
// Any other finding (or an env file that is not ignored) fails the scan.
//
// Generated build output (Next.js `.next`) contains random keys that Next.js creates by itself.
// Instead of accepting findings there, the folder is DELETED before the scan (it is rebuilt
// automatically), so the scan stays strict. It is only deleted if git ignores it and tracks
// none of its files. Stop the dashboard dev server before scanning.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isLocalEnvFile = (name) => /^\.env(\..+)?$/.test(name) && name !== '.env.example';
const BUILD_OUTPUT_DIRS = ['dashboard/.next'];

function gitOk(args) {
  return spawnSync('git', args, { stdio: 'ignore' }).status === 0;
}

for (const d of BUILD_OUTPUT_DIRS.filter((d) => existsSync(d))) {
  const ignored = gitOk(['check-ignore', '-q', d]);
  const tracked = spawnSync('git', ['ls-files', '--', d], { encoding: 'utf8' }).stdout.trim() !== '';
  if (ignored && !tracked) {
    rmSync(d, { recursive: true, force: true });
    console.log(`removed generated build output before scanning: ${d} (rebuilt automatically)`);
  } else {
    console.error(`WARNING: ${d} is ${tracked ? 'TRACKED by git' : 'NOT git-ignored'}; not deleted, scanned like any other folder.`);
  }
}

const protectedEnvFiles = new Set();
for (const name of readdirSync('.').filter(isLocalEnvFile)) {
  const ignored = gitOk(['check-ignore', '-q', name]);
  const tracked = gitOk(['ls-files', '--error-unmatch', name]);
  if (ignored && !tracked) protectedEnvFiles.add(name);
  else console.error(`WARNING: ${name} is ${tracked ? 'TRACKED by git' : 'NOT git-ignored'}; it is scanned like any other file.`);
}

const dir = mkdtempSync(join(tmpdir(), 'apg-scan-'));
const report = join(dir, 'report.json');
try {
  const r = spawnSync(
    'gitleaks',
    ['dir', '.', '--config', '.gitleaks.toml', '--redact', '--no-banner', '--exit-code', '0',
      '--report-format', 'json', '--report-path', report],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (r.error || r.status !== 0) {
    console.error('ERROR: gitleaks failed to run (is it installed?).');
    process.exit(1);
  }
  const findings = JSON.parse(readFileSync(report, 'utf8') || '[]');
  const accepted = findings.filter((f) => protectedEnvFiles.has(f.File.replace(/^\.[\\/]/, '')));
  const blocking = findings.filter((f) => !accepted.includes(f));

  for (const f of accepted) {
    console.log(`accepted (git-ignored local secret file): ${f.RuleID} in ${f.File} line ${f.StartLine}`);
  }
  if (blocking.length) {
    for (const f of blocking) console.error(`LEAK: ${f.RuleID} in ${f.File} line ${f.StartLine}`);
    console.error(`${blocking.length} possible secret(s) found outside git-ignored env files.`);
    process.exit(1);
  }
  console.log('Folder scan: no leaks found outside git-ignored env files.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
