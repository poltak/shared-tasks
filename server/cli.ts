// Commands for the administrator: `node server/cli.ts <command>`. They use DATA_DIR like the server,
// and they are safe to run while the server runs.
import { createUser, listUsers, nameKey, setPassword } from './auth.ts';
import { loadConfig } from './config.ts';
import { dbPath, openDb } from './db.ts';
import type { Db } from './db.ts';
import { HttpError } from './http.ts';
import { readSeedAccounts, seed } from './seed.ts';

const USAGE = `Usage: node server/cli.ts <command>

  add-user <name> [password]        Makes an account. Works also when sign-up is closed
  reset-password <name> [password]  Sets a new password and ends the sessions of the account
  list-users                        Shows the accounts
  seed                              Fills an empty database with the test accounts and sample lists

With no password in the command, the password comes from the variable ST_PASSWORD,
or the command asks for it.`;

/** Reads one line from the terminal and does not show it. From a pipe: reads the first line. */
function ask(question: string): Promise<string> {
  const { stdin, stdout } = process;
  return new Promise((resolve) => {
    let text = '';
    const finish = (): void => {
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdin.removeAllListeners('data');
      stdout.write('\n');
      resolve(text);
    };
    stdout.write(question);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('end', finish);
    stdin.on('data', (chunk: string) => {
      for (const char of chunk) {
        if (char === '\n' || char === '\r' || char === '\u0004') return finish();
        if (char === '\u0003') process.exit(130);
        if (char === '\u007f' || char === '\b') text = text.slice(0, -1);
        else text += char;
      }
    });
  });
}

async function password(fromCommand: string | undefined): Promise<string> {
  return fromCommand ?? process.env.ST_PASSWORD ?? (await ask('Password: '));
}

async function run(db: Db, args: string[]): Promise<number> {
  const [command, name, secret] = args;
  switch (command) {
    case 'add-user': {
      if (!name) break;
      const user = await createUser({ db, name, password: await password(secret), now: Date.now() });
      console.log(`Made the account "${user.name}" (${user.id})`);
      return 0;
    }
    case 'reset-password': {
      if (!name) break;
      const row = db.q('SELECT id FROM users WHERE name_key = ?').get(nameKey(name)) as { id: string } | undefined;
      if (!row) {
        console.error(`No account has the name "${name}"`);
        return 1;
      }
      await setPassword({ db, userId: row.id, password: await password(secret) });
      console.log(`Set a new password for "${name}". The account is signed out on each device.`);
      return 0;
    }
    case 'list-users': {
      const users = listUsers(db);
      for (const user of users) console.log(`${user.id}  ${user.name}`);
      if (users.length === 0) console.log('No accounts');
      return 0;
    }
    case 'seed': {
      const users = seed({ db, accounts: await readSeedAccounts(), now: Date.now() });
      console.log(`Made the test accounts ${users.map((u) => `"${u.name}"`).join(' and ')} with sample lists`);
      return 0;
    }
  }
  console.error(USAGE);
  return 2;
}

const db = openDb(dbPath(loadConfig().dataDir));
let code = 1;
try {
  code = await run(db, process.argv.slice(2));
} catch (error) {
  // An error with a status is a message for the person, for example "This name is in use".
  console.error(error instanceof HttpError || error instanceof Error ? error.message : error);
} finally {
  db.close();
}
process.exit(code);
