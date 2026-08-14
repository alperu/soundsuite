#!/usr/bin/env node
/**
 * Canvas geometry assertion, run against the live editor over CDP.
 *
 *   node scripts/verify-canvas-geometry.mjs            # default 0.45 + zoomed
 *   node scripts/verify-canvas-geometry.mjs --port 9222
 *
 * Checks four things that have each broken silently at least once:
 *   1. circle CENTRES sit on the block edge they anchor to (±1px)
 *   2. circle WIDTHS are full — a clipped circle keeps its centre, so the
 *      centre check passed for a whole round while every circle was halved
 *   3. no socket sits inside the title bar
 *   4. a case block shows exactly one affordance (its id tag)
 *
 * Requires the dev server on :3000 and Chrome started with
 * --remote-debugging-port (see scripts/chromeMcpRun.sh).
 */

const port = (() => {
  const i = process.argv.indexOf('--port');
  return i > -1 ? Number(process.argv[i + 1]) : 9222;
})();

const PROBE = `(async () => {
  const scaleOf = el => {
    let p = el;
    while (p && !/scale\\(/.test(p.style?.transform || '')) p = p.parentElement;
    return p ? Number(p.style.transform.match(/scale\\(([\\d.]+)\\)/)[1]) : 1;
  };
  const blocks = Array.from(document.querySelectorAll('[data-block-kind="filing"]'));
  if (blocks.length === 0) return { error: 'no filing blocks — is the editor open?' };
  const k = scaleOf(blocks[0]);
  let clipped = 0, inTitle = 0, worstRight = 0, worstLeft = 0, circles = 0;
  for (const b of blocks) {
    const br = b.getBoundingClientRect();
    const title = b.querySelector('[data-block-title]')?.getBoundingClientRect();
    for (const h of b.querySelectorAll('[data-slot]')) {
      const c = h.querySelector('span[style]');
      if (!c) continue;
      circles++;
      const cr = c.getBoundingClientRect();
      if (cr.width / k < 13) clipped++;
      if (title && cr.top + cr.height / 2 < title.bottom - 0.5) inTitle++;
      const mid = cr.left + cr.width / 2;
      if (h.getAttribute('data-slot-edge') === 'left') worstLeft = Math.max(worstLeft, Math.abs(mid - br.left));
      else worstRight = Math.max(worstRight, Math.abs(mid - br.right));
    }
  }
  const caseExtras = Array.from(document.querySelectorAll('[data-block-kind="case"]'))
    .filter(c => c.querySelectorAll('[data-slot="id"]').length !== 1 || c.querySelectorAll('[data-hub-side]').length !== 0).length;
  return {
    scale: Math.round(k * 100) / 100,
    circles,
    clippedCircles: clipped,
    circlesInTitle: inTitle,
    rightEdgeMaxDevPx: Math.round((worstRight / k) * 10) / 10,
    leftEdgeMaxDevPx: Math.round((worstLeft / k) * 10) / 10,
    caseBlocksWithWrongAffordances: caseExtras,
  };
})()`;

async function main() {
  const targets = await (await fetch(`http://localhost:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page' && t.url.includes('/scope'));
  if (!page) {
    console.error('No /scope page open in the debug browser.');
    process.exit(2);
  }

  const { default: WebSocket } = await import('ws').catch(() => ({ default: null }));
  if (!WebSocket) {
    console.error('This script needs the `ws` package: npm i -D ws');
    process.exit(2);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const result = await new Promise((resolve, reject) => {
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: PROBE, awaitPromise: true, returnByValue: true },
        }),
      ),
    );
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id === 1) resolve(msg.result?.result?.value);
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timed out')), 15000);
  });
  ws.close();

  console.log(JSON.stringify(result, null, 2));
  const failures = [];
  if (result?.error) failures.push(result.error);
  if (result?.clippedCircles > 0) failures.push(`${result.clippedCircles} circles rendered clipped`);
  if (result?.circlesInTitle > 0) failures.push(`${result.circlesInTitle} sockets inside the title bar`);
  if (result?.rightEdgeMaxDevPx > 1.5) failures.push(`right-edge drift ${result.rightEdgeMaxDevPx}px`);
  if (result?.leftEdgeMaxDevPx > 1.5) failures.push(`left-edge drift ${result.leftEdgeMaxDevPx}px`);
  if (result?.caseBlocksWithWrongAffordances > 0) {
    failures.push(`${result.caseBlocksWithWrongAffordances} case blocks show something other than one id tag`);
  }
  if (failures.length > 0) {
    console.error('\nFAILED:\n- ' + failures.join('\n- '));
    process.exit(1);
  }
  console.log('\nOK — centres, widths, title clearance and case affordances all pass.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(2);
});
