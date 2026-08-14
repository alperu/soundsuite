import { useCallback, useMemo, useState } from 'react';
import {
  caseTriState,
  compileSelection,
  refCascade,
  type EntityKey,
  type ScopeGraph,
} from './scope-graph';

/**
 * Cascade selection as domain state. Rete never holds selection — it only
 * paints what this store says, so the plugin and the store can't disagree.
 *
 * The set holds both case keys and filing keys. A case key present means
 * "whole case", which is what compiles to a `caseId` clause (and therefore
 * also covers that case's unfiled documents).
 */

/** Keep a case key in step with its children: present iff all are selected. */
function syncCases(graph: ScopeGraph, next: Set<EntityKey>): Set<EntityKey> {
  for (const c of graph.cases) {
    const children = graph.childrenByCase.get(c.key) ?? [];
    if (children.length === 0) continue;
    const all = children.every(child => next.has(child));
    if (all) next.add(c.key);
    else next.delete(c.key);
  }
  return next;
}

export function useScopeSelection(graph: ScopeGraph) {
  const [selected, setSelected] = useState<Set<EntityKey>>(() => new Set());

  const toggleCase = useCallback(
    (key: EntityKey) => {
      setSelected(prev => {
        const children = graph.childrenByCase.get(key) ?? [];
        const on = caseTriState(graph, prev, key) !== 'all';
        const next = new Set(prev);
        if (on) {
          next.add(key);
          for (const child of children) next.add(child);
        } else {
          next.delete(key);
          for (const child of children) next.delete(child);
        }
        return syncCases(graph, next);
      });
    },
    [graph],
  );

  const toggleFiling = useCallback(
    (key: EntityKey) => {
      setSelected(prev => {
        const next = new Set(prev);
        const on = !prev.has(key);
        // Refs travel together in both directions: a reply is only meaningful
        // in scope alongside what it replies to.
        for (const reached of refCascade(graph, key)) {
          if (on) next.add(reached);
          else next.delete(reached);
        }
        return syncCases(graph, next);
      });
    },
    [graph],
  );

  /**
   * Toggle exactly one filing, without the ref cascade.
   *
   * Deliberate divergence from the CAD/sedona convention where a plain click
   * REPLACES the selection and a modifier accumulates: this canvas is a scope
   * builder, closer to a grid of checkboxes than to a drawing, and a click that
   * threw the selection away would destroy real work. So plain click keeps
   * accumulating and the modifier NARROWS instead — it takes the one block you
   * aimed at and leaves its ref chain alone.
   *
   * The case rollup still runs afterwards, so bare-adding a case's last
   * unselected child WILL light the case block. That is not the cascade leaking
   * back in: a case key is a derived "all children selected" rollup that
   * `compileSelection` reads as one `caseId` clause, not an independent choice.
   * For the same reason a modified click on a CASE block stays the ordinary
   * cascade toggle — a case key with no children selected has nothing to mean.
   */
  const toggleFilingBare = useCallback(
    (key: EntityKey) => {
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return syncCases(graph, next);
      });
    },
    [graph],
  );

  /**
   * Apply a marquee's hit set — exactly the blocks the box caught, no cascade.
   * The user drew a boundary; pulling in refs it deliberately excluded would be
   * the tool arguing with them. Single click still cascades, because there the
   * ref chain IS the intent.
   *
   * Case keys in the hit set are dropped: a case key means "the whole case", so
   * catching one in a box would silently add children the box never touched.
   * The rollup puts it back if the box did catch them all.
   */
  const selectArea = useCallback(
    (keys: string[], subtract: boolean) => {
      setSelected(prev => {
        const next = new Set(prev);
        for (const key of keys) {
          if (key.startsWith('case:')) continue;
          if (subtract) next.delete(key);
          else next.add(key);
        }
        return syncCases(graph, next);
      });
    },
    [graph],
  );

  const selectAll = useCallback(() => {
    setSelected(() => {
      const next = new Set<EntityKey>();
      for (const c of graph.cases) next.add(c.key);
      for (const f of graph.filings) next.add(f.key);
      return next;
    });
  }, [graph]);

  const clear = useCallback(() => setSelected(new Set()), []);

  const compiled = useMemo(() => compileSelection(graph, selected), [graph, selected]);

  return {
    selected,
    toggleCase,
    toggleFiling,
    toggleFilingBare,
    selectArea,
    selectAll,
    clear,
    selection: compiled.selection,
    totals: compiled.totals,
  };
}
