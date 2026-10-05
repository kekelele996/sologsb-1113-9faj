import { create } from 'zustand';
import { db, deleteRow, persistRow, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import type { ReconcileHold, ReconcileIssue } from '../types';

interface ReconcileState {
  holds: ReconcileHold[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 把对不上的差异挂起，等值班人裁定 */
  holdIssue: (issue: ReconcileIssue, note: string) => Promise<ReconcileHold>;
  /** 人定之后解除挂起 */
  releaseHold: (id: string) => Promise<void>;
}

/** 对账挂起记录（差异项本身由两边台账派生，只有挂起动作落库） */
export const useReconcileStore = create<ReconcileState>()((set, get) => ({
  holds: [],
  hydrated: false,

  hydrate: async () => {
    const holds = await db.reconcileHolds.toArray();
    set({ holds: holds.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), hydrated: true });
  },

  holdIssue: async (issue, note) => {
    const hold: ReconcileHold = {
      id: uid('hold'),
      issueKey: issue.key,
      kind: issue.kind,
      applicationCode: issue.applicationCode,
      detail: issue.detail,
      note: note.trim() || '待值班人裁定',
      createdAt: new Date().toISOString(),
    };
    await persistRow('reconcileHolds', hold);
    set({ holds: [hold, ...get().holds] });
    return hold;
  },

  releaseHold: async (id) => {
    await deleteRow('reconcileHolds', id);
    set({ holds: get().holds.filter((hold) => hold.id !== id) });
  },
}));
