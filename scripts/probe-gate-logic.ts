/** Does a validation miss block the write? Drives the gate directly, no DB. */
import { validateWriteOperation } from '../src/lib/legal/prisma-extensions/validate';

async function run(label: string, args: unknown, model = 'Case') {
  let called = false;
  let threw: string | null = null;
  try {
    await validateWriteOperation({
      model, operation: 'update', args,
      query: async () => { called = true; return { ok: true }; },
    });
  } catch (e) {
    threw = e instanceof Error ? e.message.slice(0, 80) : String(e);
  }
  console.log(`  ${label.padEnd(34)} write ran: ${String(called).padEnd(5)} threw: ${threw ?? 'no'}`);
}

async function main() {
  console.log(`XETO_VALIDATION_ENFORCE=${process.env.XETO_VALIDATION_ENFORCE ?? '(unset)'}`);
  // Empty tags on a Case = the one failing shape in the corpus (no `case` marker).
  await run('failing dict (empty Case tags)', { data: { tags: {} } });
  await run('passing dict (case marker set)', { data: { tags: { case: { _kind: 'marker' } } } });
}
main().catch(e => { console.error(e); process.exit(1); });
