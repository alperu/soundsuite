/**
 * Manual mock for `@/lib/db/prisma`, opted into with `jest.mock('@/lib/db/prisma')`.
 *
 * The real module builds a better-sqlite3 driver-adapter client AT MODULE SCOPE
 * and chains two `$extends` onto it. Jest can't construct that, so any suite
 * whose import graph reaches this module died before its first test with
 * `PrismaClientInitializationError`, `$extends is not a function`, or
 * `Cannot read properties of undefined (reading '$disconnect')` — four suites
 * did (task #83).
 *
 * Deliberately opt-in rather than a global `moduleNameMapper`: suites that
 * currently pass with the real module keep it, so this can't silently change
 * behaviour under tests nobody is looking at.
 *
 * Every model is served by a Proxy, so a suite never has to enumerate the
 * delegates its code path happens to touch — hand-listing them just moves
 * "cannot read properties of undefined" to whichever model gets added next.
 * Override per test where a specific return matters:
 *
 *     (prisma.case.findUnique as jest.Mock).mockResolvedValue({ id: 'c1' });
 */

/** The shape a Prisma model delegate presents to calling code. */
function makeDelegate() {
  return {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    upsert: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockResolvedValue({}),
    groupBy: jest.fn().mockResolvedValue([]),
  };
}

type Delegate = ReturnType<typeof makeDelegate>;

const delegates = new Map<string, Delegate>();

const clientLevel: Record<string, unknown> = {
  $connect: jest.fn().mockResolvedValue(undefined),
  $disconnect: jest.fn().mockResolvedValue(undefined),
  $on: jest.fn(),
  $queryRaw: jest.fn().mockResolvedValue([]),
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  $executeRaw: jest.fn().mockResolvedValue(0),
  $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  // Callback form is what the app uses; hand it this same client so writes
  // inside a transaction land on the same jest.fn()s the test can assert on.
  $transaction: jest.fn(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(proxy) : [],
  ),
};

const proxy: Record<string, unknown> = new Proxy(clientLevel, {
  get(target, prop: string | symbol) {
    if (typeof prop !== 'string') return undefined;
    if (prop in target) return target[prop];
    // `then` must stay undefined or `await prisma` would treat it as a thenable.
    if (prop.startsWith('$') || prop === 'then') return undefined;
    let d = delegates.get(prop);
    if (!d) {
      d = makeDelegate();
      delegates.set(prop, d);
    }
    return d;
  },
});

/** Drop every recorded call and re-seed default returns (use in `beforeEach`). */
export function __resetPrismaMock(): void {
  delegates.clear();
  for (const v of Object.values(clientLevel)) {
    if (typeof v === 'function' && 'mockClear' in v) (v as jest.Mock).mockClear();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const prisma = proxy as any;
export default prisma;
