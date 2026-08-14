#!/usr/bin/env node
/**
 * Canvas geometry assertion, run against the live editor over CDP.
 *
 *   node scripts/verify-canvas-geometry.mjs            # default 0.45 + zoomed
 *   node scripts/verify-canvas-geometry.mjs --port 9222
 *
 * Checks six things that have each broken silently at least once:
 *   1. circle CENTRES sit on the block edge they anchor to (±1px)
 *   2. circle WIDTHS are full — a clipped circle keeps its centre, so the
 *      centre check passed for a whole round while every circle was halved
 *   3. no socket sits inside the title bar OR the footer band
 *   4. no socket hangs below the block's bottom edge — the other end of the
 *      body, and the next place a handle count bump will push one out
 *   5. SEPARATION: no two handles on the same edge closer than 16px centre to
 *      centre. Handles are counted WITHOUT deduping identical rects: #65 was
 *      the input hub sitting exactly on top of the first slot, and two
 *      detectors missed it because they merged coincident boxes. The hub is
 *      included on purpose — it is a circle on the same edge as the slots, and
 *      leaving it out is why checks 1-4 passed while it overlapped.
 *   6. a case block shows exactly one affordance (its id tag)
 *   7. EVERY VISIBLE EDGE terminates on a circle (≤1.5 SCREEN px, both ends). The old
 *      suite never looked at edges at all, which is how the containment fan
 *      came to converge 12px below the case's id circle (#77) while all six
 *      other checks passed. The probe reveals the edges itself — "Show all
 *      links" for refs, a hover for the block's contains edge — and puts the
 *      toggle back the way it found it.
 *
 * Requires the dev server on :3000 and Chrome started with
 * --remote-debugging-port (see scripts/chromeMcpRun.sh).
 */

const port = (() => {
  const i = process.argv.indexOf('--port');
  return i > -1 ? Number(process.argv[i + 1]) : 9222;
})();

const PROBE = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const scaleOf = el => {
    let p = el;
    while (p && !/scale\\(/.test(p.style?.transform || '')) p = p.parentElement;
    return p ? Number(p.style.transform.match(/scale\\(([\\d.]+)\\)/)[1]) : 1;
  };
  const blocks = Array.from(document.querySelectorAll('[data-block-kind="filing"]'));
  if (blocks.length === 0) return { error: 'no filing blocks — is the editor open?' };
  const k = scaleOf(blocks[0]);
  let clipped = 0, inTitle = 0, inFooter = 0, belowBlock = 0, worstRight = 0, worstLeft = 0, circles = 0;
  let minSeparation = Infinity, tooClose = 0;
  for (const b of blocks) {
    const br = b.getBoundingClientRect();
    const title = b.querySelector('[data-block-title]')?.getBoundingClientRect();
    const footer = b.querySelector('[data-block-footer]')?.getBoundingClientRect();
    // Every handle on the block, hub included. No Set, no rect dedupe: two
    // handles at the same coordinates are exactly what this is looking for.
    const handles = Array.from(b.querySelectorAll('[data-slot],[data-hub-side]'));
    const byEdge = { left: [], right: [] };
    for (const h of handles) {
      // The socket circle only. Link badges (#61) are also styled spans, and
      // they sit OFF the block edge by design — measuring them as sockets would
      // read as drift and as clipping.
      const c = h.querySelector('span[style]:not([data-link-badge]):not([data-link-badge] *)');
      if (!c) continue;
      circles++;
      const cr = c.getBoundingClientRect();
      if (cr.width / k < 13) clipped++;
      const cy = cr.top + cr.height / 2;
      if (title && cy < title.bottom - 0.5) inTitle++;
      // The footer is the other band a handle must stay out of (#72).
      if (footer && cy > footer.top + 0.5) inFooter++;
      if (cr.bottom > br.bottom + 0.5) belowBlock++;
      const mid = cr.left + cr.width / 2;
      const edge = h.getAttribute('data-slot-edge') || h.getAttribute('data-hub-side') || 'right';
      if (edge === 'left') worstLeft = Math.max(worstLeft, Math.abs(mid - br.left));
      else worstRight = Math.max(worstRight, Math.abs(mid - br.right));
      byEdge[edge === 'left' ? 'left' : 'right'].push(cy);
    }
    for (const edge of ['left', 'right']) {
      const ys = byEdge[edge].slice().sort((a, z) => a - z);
      for (let i = 1; i < ys.length; i++) {
        const gap = (ys[i] - ys[i - 1]) / k;
        minSeparation = Math.min(minSeparation, gap);
        if (gap < 16 - 0.5) tooClose++;
      }
    }
  }
  // --- edge endpoints -------------------------------------------------------
  const toggle = Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent || '').trim() === 'Show all links');
  const toggleWasOn = toggle ? toggle.getAttribute('aria-pressed') === 'true' : false;
  if (toggle && !toggleWasOn) { toggle.click(); await sleep(400); }
  // A contains edge is only drawn while one of its blocks is hovered.
  const hovered = document.querySelector('[data-block-kind="filing"]');
  if (hovered) hovered.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  await sleep(400);

  const centres = [];
  for (const b of document.querySelectorAll('[data-block-id]')) {
    for (const h of b.querySelectorAll('[data-slot],[data-hub-side]')) {
      const c = h.querySelector('span[style]:not([data-link-badge]):not([data-link-badge] *)');
      if (!c) continue;
      const cr = c.getBoundingClientRect();
      centres.push({ x: cr.left + cr.width / 2, y: cr.top + cr.height / 2 });
    }
  }
  const atClient = (path, len) => {
    const p = path.getPointAtLength(len);
    const m = path.getScreenCTM();
    return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
  };
  // SCREEN pixels, not editor units. The error being bounded here is rendering
  // rounding, which is a screen-space quantity — dividing by the zoom turned a
  // half-pixel at k=0.21 into a 2.2 "editor px" failure that meant nothing.
  const nearestPx = pt => {
    let best = Infinity;
    for (const c of centres) best = Math.min(best, Math.hypot(c.x - pt.x, c.y - pt.y));
    return best;
  };
  let edgesMeasured = 0, worstEdgeGapPx = 0, edgeEndsAdrift = 0;
  for (const wrapper of document.querySelectorAll('[data-edge-kind]')) {
    const path = wrapper.querySelector('path');
    if (!path || typeof path.getTotalLength !== 'function') continue;
    edgesMeasured++;
    const total = path.getTotalLength();
    for (const gap of [nearestPx(atClient(path, 0)), nearestPx(atClient(path, total))]) {
      worstEdgeGapPx = Math.max(worstEdgeGapPx, gap);
      if (gap > 1.5) edgeEndsAdrift++;
    }
  }
  if (hovered) hovered.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
  if (toggle && !toggleWasOn) { toggle.click(); await sleep(200); }

  const caseExtras = Array.from(document.querySelectorAll('[data-block-kind="case"]'))
    .filter(c => c.querySelectorAll('[data-slot="id"]').length !== 1 || c.querySelectorAll('[data-hub-side]').length !== 0).length;
  return {
    scale: Math.round(k * 100) / 100,
    circles,
    clippedCircles: clipped,
    circlesInTitle: inTitle,
    circlesInFooter: inFooter,
    circlesBelowBlock: belowBlock,
    minEdgeSeparationPx: minSeparation === Infinity ? null : Math.round(minSeparation * 10) / 10,
    handlePairsTooClose: tooClose,
    rightEdgeMaxDevPx: Math.round((worstRight / k) * 10) / 10,
    leftEdgeMaxDevPx: Math.round((worstLeft / k) * 10) / 10,
    caseBlocksWithWrongAffordances: caseExtras,
    edgesMeasured,
    worstEdgeGapScreenPx: Math.round(worstEdgeGapPx * 10) / 10,
    edgeEndsAdrift,
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
  if (result?.circlesInFooter > 0) failures.push(`${result.circlesInFooter} sockets inside the footer`);
  if (result?.circlesBelowBlock > 0) failures.push(`${result.circlesBelowBlock} sockets hanging below the block`);
  if (result?.handlePairsTooClose > 0) {
    failures.push(
      `${result.handlePairsTooClose} handle pairs closer than 16px (worst ${result.minEdgeSeparationPx}px)`,
    );
  }
  if (result?.rightEdgeMaxDevPx > 1.5) failures.push(`right-edge drift ${result.rightEdgeMaxDevPx}px`);
  if (result?.leftEdgeMaxDevPx > 1.5) failures.push(`left-edge drift ${result.leftEdgeMaxDevPx}px`);
  if (result?.edgeEndsAdrift > 0) {
    failures.push(
      `${result.edgeEndsAdrift} edge ends miss their circle (worst ${result.worstEdgeGapScreenPx}px on screen)`,
    );
  }
  if (result?.edgesMeasured === 0) {
    failures.push('no edges were visible to measure — the endpoint check proved nothing');
  }
  if (result?.caseBlocksWithWrongAffordances > 0) {
    failures.push(`${result.caseBlocksWithWrongAffordances} case blocks show something other than one id tag`);
  }
  if (failures.length > 0) {
    console.error('\nFAILED:\n- ' + failures.join('\n- '));
    process.exit(1);
  }
  console.log(
    '\nOK — centres, widths, title/bottom clearance, separation, case affordances and edge endpoints all pass.',
  );
}

main().catch(err => {
  console.error(err.message);
  process.exit(2);
});
