/**
 * Creates the first Super Admin from environment variables — and only when no admin exists yet.
 *
 *   BOOTSTRAP_ADMIN_EMAIL=owner@example.com \
 *   BOOTSTRAP_ADMIN_PASSWORD='<strong temporary password>' \
 *   BOOTSTRAP_ADMIN_NAME='Store Owner' \
 *   npm run admin:bootstrap
 *
 * The account must change its password at first sign-in. Remove BOOTSTRAP_ADMIN_PASSWORD from
 * the environment/secret store afterwards. The password is never printed or logged.
 */
import { checkPasswordStrength, emailSchema } from '@jmh/shared';
import { connect } from '../src/bootstrap';
import { getConfig } from '../src/config/env';
import { disconnectDatabase } from '../src/db/connection';
import { AdminUserModel } from '../src/db/models';
import { hashPassword } from '../src/modules/auth/auth.service';
import { runMigrations } from '../src/migrations';

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

const rawEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Store Owner';

if (!rawEmail || !password) {
  fail(
    'Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (for example in .env) and run again.',
  );
}
const parsedEmail = emailSchema.safeParse(rawEmail);
if (!parsedEmail.success) fail('BOOTSTRAP_ADMIN_EMAIL is not a valid email address.');
const email = parsedEmail.data;
const problems = checkPasswordStrength(password, { email, name });
if (problems.length) fail(`BOOTSTRAP_ADMIN_PASSWORD is too weak:\n  - ${problems.join('\n  - ')}`);

const config = getConfig();
await connect(config);
try {
  await runMigrations(config);
  const existing = await AdminUserModel.countDocuments();
  if (existing > 0) {
    const same = await AdminUserModel.exists({ email });
    console.log(
      same
        ? `ℹ An admin account for ${email} already exists. Nothing was changed.`
        : 'ℹ Admin accounts already exist, so bootstrap is disabled. Create further accounts from Admin → Users.',
    );
  } else {
    await AdminUserModel.create({
      email,
      name,
      role: 'super_admin',
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
    });
    console.log(`✔ Created Super Admin ${email}.`);
    console.log(
      '  Sign in at /admin/login — you will be asked to choose a new password immediately.',
    );
    console.log('  Now remove BOOTSTRAP_ADMIN_PASSWORD from your environment or secret store.');
  }
} finally {
  await disconnectDatabase();
}
