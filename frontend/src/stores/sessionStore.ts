import { create } from 'zustand';
import { db, deleteRow, persistRow, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import type { ObsApplication, ObsSession, SessionStatus } from '../types';
import { buildSchedulePlan, type QueueItem, type SchedulePlan } from '../utils/scheduler';
import { useApplicationStore } from './applicationStore';
import { useEquipmentStore } from './equipmentStore';
import { useNightStore } from './nightStore';
import { useTargetStore } from './targetStore';

export interface SessionInput {
  nightId: string;
  targetId: string;
  startTime: string;
  endTime: string;
  telescopeId: string;
  instrumentId: string;
  filterSlot: string;
  plannedFrames: number;
  status: SessionStatus;
  applicationId?: string;
  confirmed?: boolean;
  rescheduleReason?: string;
  backupNightId?: string;
}

export interface RescheduleOutcome {
  /** 失效的未确认待执行段数量 */
  invalidated: number;
  /** 新排入的段数量 */
  created: number;
  /** 排不下、排队顺延的申请 */
  queued: QueueItem[];
}

interface SessionState {
  sessions: ObsSession[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addSession: (input: SessionInput) => Promise<ObsSession>;
  updateSession: (id: string, patch: Partial<SessionInput>) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  /** 批量改期到备用观测夜并填写改期原因 */
  rescheduleToBackup: (ids: string[], backupNightId: string, reason: string) => Promise<number>;
  updateStatus: (id: string, status: SessionStatus) => Promise<void>;
  /** 确认 / 取消确认：已确认的段不被自动编排与申请单重排挤掉 */
  setConfirmed: (id: string, confirmed: boolean) => Promise<void>;
  /** 申请单时长改动后的重排：未确认的待执行段失效，按新时长重新找空档（编排台侧单事务，写坏只退本侧） */
  rescheduleForApplication: (app: ObsApplication) => Promise<RescheduleOutcome>;
  /** 编排台按单排段：暗时段容量有限，当夜放不下顺到后面的夜，不挤掉已确认的段 */
  applyAutoSchedule: () => Promise<SchedulePlan>;
  /** 待认领段挂上申请编号（传空串则解除关联、转回待认领） */
  claimSession: (sessionId: string, applicationCode: string) => Promise<void>;
}

/** 编排台台账：观测夜内的排程段与望远镜空档，只读引用申请台的申请编号 */
export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  hydrated: false,

  hydrate: async () => {
    const sessions = await db.sessions.orderBy('startTime').toArray();
    set({ sessions, hydrated: true });
  },

  addSession: async (input) => {
    const session: ObsSession = {
      id: uid('s'),
      nightId: input.nightId,
      targetId: input.targetId,
      startTime: input.startTime,
      endTime: input.endTime,
      telescopeId: input.telescopeId,
      instrumentId: input.instrumentId,
      filterSlot: input.filterSlot,
      plannedFrames: Number(input.plannedFrames) || 0,
      status: input.status,
      applicationId: input.applicationId?.trim() || undefined,
      confirmed: input.confirmed ?? false,
      rescheduleReason: input.rescheduleReason?.trim() || undefined,
      backupNightId: input.backupNightId,
      schemaVersion: SCHEMA_VERSION,
    };
    await persistRow('sessions', session);
    set({ sessions: [...get().sessions, session] });
    return session;
  },

  updateSession: async (id, patch) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) return;
    const next: ObsSession = { ...current, ...patch, schemaVersion: SCHEMA_VERSION };
    await persistRow('sessions', next);
    set({ sessions: get().sessions.map((session) => (session.id === id ? next : session)) });
  },

  removeSession: async (id) => {
    await deleteRow('sessions', id);
    set({ sessions: get().sessions.filter((session) => session.id !== id) });
  },

  rescheduleToBackup: async (ids, backupNightId, reason) => {
    const targets = get().sessions.filter((session) => ids.includes(session.id));
    const updated = targets.map((session) => ({
      ...session,
      backupNightId,
      status: '因云取消' as SessionStatus,
      rescheduleReason: reason.trim() || '改期至备用观测夜',
      schemaVersion: SCHEMA_VERSION,
    }));
    for (const session of updated) {
      await persistRow('sessions', session);
    }
    set({ sessions: get().sessions.map((session) => updated.find((item) => item.id === session.id) ?? session) });
    return updated.length;
  },

  updateStatus: async (id, status) => {
    await get().updateSession(id, { status });
  },

  setConfirmed: async (id, confirmed) => {
    await get().updateSession(id, { confirmed });
  },

  rescheduleForApplication: async (app) => {
    const current = get().sessions;
    // 未确认的待执行段失效等重排；已确认段不挤掉，已完成的照旧留档
    const invalidated = current
      .filter((session) => session.applicationId === app.code && session.status === '待执行' && !session.confirmed)
      .map((session) => ({ ...session, status: '已失效' as SessionStatus, schemaVersion: SCHEMA_VERSION }));
    const remaining = current.map((session) => invalidated.find((item) => item.id === session.id) ?? session);

    const plan = buildSchedulePlan({
      applications: [app],
      sessions: remaining,
      nights: useNightStore.getState().nights,
      telescopes: useEquipmentStore.getState().telescopes,
      instruments: useEquipmentStore.getState().instruments,
      targets: useTargetStore.getState().targets,
    });

    // 编排台侧单事务：失效与重排一起落库，任一步写坏整体回滚，不波及申请台台账
    const writes = [...invalidated, ...plan.created];
    if (writes.length > 0) {
      await db.transaction('rw', db.sessions, async () => {
        await db.sessions.bulkPut(writes);
      });
    }
    set({ sessions: [...remaining, ...plan.created] });
    return { invalidated: invalidated.length, created: plan.created.length, queued: plan.queued };
  },

  applyAutoSchedule: async () => {
    const plan = buildSchedulePlan({
      applications: useApplicationStore.getState().applications,
      sessions: get().sessions,
      nights: useNightStore.getState().nights,
      telescopes: useEquipmentStore.getState().telescopes,
      instruments: useEquipmentStore.getState().instruments,
      targets: useTargetStore.getState().targets,
    });
    if (plan.created.length > 0) {
      // 编排台侧单事务落库，写坏整体回滚（只退本侧）
      await db.transaction('rw', db.sessions, async () => {
        await db.sessions.bulkPut(plan.created);
      });
      set({ sessions: [...get().sessions, ...plan.created] });
    }
    return plan;
  },

  claimSession: async (sessionId, applicationCode) => {
    const current = get().sessions.find((session) => session.id === sessionId);
    if (!current) return;
    const next: ObsSession = {
      ...current,
      applicationId: applicationCode.trim() || undefined,
      schemaVersion: SCHEMA_VERSION,
    };
    await persistRow('sessions', next);
    set({ sessions: get().sessions.map((session) => (session.id === sessionId ? next : session)) });
  },
}));
