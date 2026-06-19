import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

/** Fixed employee accounts — passwords stored in Mongo (CdcBillsUserPasswords). */
export const CDC_BILLS_EMPLOYEES = [
  { userKey: 'emp1', displayName: 'Employee 1' },
  { userKey: 'emp2', displayName: 'Employee 2' },
  { userKey: 'emp3', displayName: 'Employee 3' },
];

const JWT_EXPIRY = '24h';

function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || !String(s).trim()) {
    throw new Error('JWT_SECRET is not configured');
  }
  return String(s).trim();
}

function adminAccountsFromEnv() {
  const accounts = [];
  const pairs = [
    ['CDC_BILLS_ADMIN1_USER', 'CDC_BILLS_ADMIN1_PASSWORD'],
    ['CDC_BILLS_ADMIN2_USER', 'CDC_BILLS_ADMIN2_PASSWORD'],
  ];
  for (const [userVar, passVar] of pairs) {
    const username = process.env[userVar]?.trim();
    const password = process.env[passVar];
    if (username && password) {
      accounts.push({ userKey: username, displayName: username, password: String(password) });
    }
  }
  return accounts;
}

/** Public roster for login dropdown (no passwords). */
export function listLoginUsers() {
  const users = [];
  for (const admin of adminAccountsFromEnv()) {
    users.push({
      username: admin.userKey,
      displayName: admin.displayName,
      role: 'admin',
    });
  }
  for (const emp of CDC_BILLS_EMPLOYEES) {
    users.push({
      username: emp.userKey,
      displayName: emp.displayName,
      role: 'employee',
    });
  }
  return users;
}

export function findEmployee(userKeyOrUsername) {
  const key = String(userKeyOrUsername || '').trim().toLowerCase();
  return CDC_BILLS_EMPLOYEES.find(
    (e) => e.userKey.toLowerCase() === key || e.displayName.toLowerCase() === key,
  ) || null;
}

export function verifyAdminCredentials(username, password) {
  const u = String(username || '').trim();
  const p = String(password ?? '');
  if (!u || !p) return null;

  for (const admin of adminAccountsFromEnv()) {
    if (admin.userKey === u && admin.password === p) {
      return { userKey: admin.userKey, displayName: admin.displayName, role: 'admin' };
    }
  }
  return null;
}

export async function verifyEmployeeCredentials(userKeyOrUsername, password, UserPasswordModel) {
  const employee = findEmployee(userKeyOrUsername);
  if (!employee || !UserPasswordModel) return null;

  const doc = await UserPasswordModel.findOne({ userKey: employee.userKey }).lean();
  if (!doc?.passwordHash) return null;

  const ok = await bcrypt.compare(String(password ?? ''), doc.passwordHash);
  if (!ok) return null;

  return { userKey: employee.userKey, displayName: employee.displayName, role: 'employee' };
}

export function issueToken(user) {
  return jwt.sign(
    {
      userKey: user.userKey,
      displayName: user.displayName,
      role: user.role,
    },
    jwtSecret(),
    { expiresIn: JWT_EXPIRY },
  );
}

export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, jwtSecret());
    if (!payload?.userKey || !payload?.role) return null;
    return {
      userKey: String(payload.userKey),
      displayName: String(payload.displayName || payload.userKey),
      role: payload.role === 'admin' ? 'admin' : 'employee',
    };
  } catch {
    return null;
  }
}

export async function hashPassword(password) {
  return bcrypt.hash(String(password), 10);
}
