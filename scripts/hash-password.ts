// Generates ADMIN_PASSWORD_HASH for the dashboard login (live mode).
// The password is typed without being shown, is never written to disk, and only the hash is printed.
// Usage: npm run hash:password
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/api/auth.js';

function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const first = await askHidden(`Dashboard password (min ${MIN_PASSWORD_LENGTH} characters, hidden): `);
const second = await askHidden('Repeat the password: ');
if (first !== second) {
  console.error('The passwords do not match. Nothing was generated.');
  process.exit(1);
}
try {
  const hash = await hashPassword(first);
  console.log('\nPut this line in your .env file (it is a hash, not the password):\n');
  console.log(`ADMIN_PASSWORD_HASH=${hash}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
