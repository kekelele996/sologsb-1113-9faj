import { create } from 'zustand';
import { db, deleteRow, persistRow, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import { planRequest } from '../utils/scheduler';
import type { ObsRequest, RequestStatus } from '../types';

export interface RequestInput {
  targetId: string;
  exposureMinutes: number;
  deadline: string;
  remark?: string;
}

interface RequestState {
  requests: ObsRequest[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addRequest: (input: RequestInput) => Promise<ObsRequest>;
  updateRequest: (id: string, patch: Partial<RequestInput> & { status?: RequestStatus }) => Promise<void>;
  removeRequest: (id: string) => Promise<void>;
  /** 编排台按单排段：容量有限、排队顺到后面的夜，不挤掉已确认的段；失败自动重试这张单 */
  scheduleRequest: (id: string) => Promise<{ scheduled: number; remainder: number }>;
  /** 失败后手动重试这张单 */
  retrySchedule: (id: string) => Promise<void>;
  /** 对账对不上：先挂起等人定 */
  suspendRequest: (id: string) => Promise<void>;
  /** 挂起解除，回到待排段 */
  resumeRequest: (id: string) => Promise<void>;
}

/** 异步重试：失败后重试这张单，最多 attempts 次 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
    }
  }
  throw lastError;
}

/** 申请台：管观测申请单、编号、想拍的曝光时长与期限；与编排台各留一份，按申请编号对账 */
export const useRequestStore = create<RequestState>()((set, get) => ({
  requests: [],
  hydrated: false,

  hydrate: async () => {
    const requests = await db.requests.orderBy('createdAt').toArray();
    set({ requests, hydrated: true });
  },

  addRequest: async (input) => {
    const request: ObsRequest = {
      id: uid('req'),
      code: `SQ-${new Date().getFullYear()}-${String(get().requests.length + 1).padStart(3, '0')}`,
      targetId: input.targetId,
      exposureMinutes: Number(input.exposureMinutes) || 0,
      deadline: input.deadline,
      status: '待排段',
      retryCount: 0,
      createdAt: new Date().toISOString(),
      remark: input.remark?.trim() || undefined,
      schemaVersion: SCHEMA_VERSION,
    };
    await persistRow('requests', request);
    set({ requests: [...get().requests, request] });
    return request;
  },

  updateRequest: async (id, patch) => {
    const current = get().requests.find((request) => request.id === id);
    if (!current) return;
    const next: ObsRequest = { ...current, ...patch, schemaVersion: SCHEMA_VERSION };

    // 申请单时长改动：没执行的段失效等重排，拍完的照旧留档
    if (patch.exposureMinutes !== undefined && patch.exposureMinutes !== current.exposureMinutes) {
      const { useSessionStore } = await import('./sessionStore');
      const sessions = useSessionStore.getState().sessions;
      const unexecuted = sessions.filter(
        (session) => session.requestId === id && (session.status === '待执行' || session.status === '进行中') && !session.invalidated,
      );
      for (const session of unexecuted) {
        await persistRow('sessions', { ...session, invalidated: true });
      }
      await useSessionStore.getState().hydrate();
      const hasCompleted = sessions.some((session) => session.requestId === id && session.status === '已完成');
      next.status = hasCompleted ? '排段中' : '待排段';
    }

    await persistRow('requests', next);
    set({ requests: get().requests.map((request) => (request.id === id ? next : request)) });
  },

  removeRequest: async (id) => {
    await deleteRow('requests', id);
    set({ requests: get().requests.filter((request) => request.id !== id) });
  },

  scheduleRequest: async (id) => {
    const request = get().requests.find((item) => item.id === id);
    if (!request) return { scheduled: 0, remainder: 0 };

    // 只读编排台侧数据（夜、段、望远镜），不改对面那份
    const [{ useSessionStore }, { useNightStore }, { useEquipmentStore }, { useTargetStore }] = await Promise.all([
      import('./sessionStore'),
      import('./nightStore'),
      import('./equipmentStore'),
      import('./targetStore'),
    ]);
    const sessions = useSessionStore.getState().sessions;
    const nights = useNightStore.getState().nights;
    const telescopes = useEquipmentStore.getState().telescopes;
    const instruments = useEquipmentStore.getState().instruments;
    const target = useTargetStore.getState().targets.find((item) => item.id === request.targetId);

    const plan = planRequest(request, nights, sessions, telescopes, target, instruments);

    // 编排台写坏只退本侧：段写入在一个 Dexie 事务里，失败自动回滚，申请单不动
    try {
      await withRetry(async () => {
        await db.transaction('rw', db.sessions, async () => {
          for (const session of plan.sessions) {
            await db.sessions.put(session);
          }
        });
      });
    } catch (error) {
      // 申请台失败后重试这张单：多次仍失败则置为排段失败，留待人工重试
      const failed: ObsRequest = {
        ...request,
        status: '排段失败',
        retryCount: request.retryCount + 1,
        lastError: (error as Error).message,
        schemaVersion: SCHEMA_VERSION,
      };
      await persistRow('requests', failed);
      set({ requests: get().requests.map((item) => (item.id === id ? failed : item)) });
      throw error;
    }

    // 段提交成功后才更新申请单状态（两侧各自落库，不互相改写）
    const nextStatus: RequestStatus = plan.remainderMinutes > 0 ? '排段中' : '已排段';
    const updated: ObsRequest = { ...request, status: nextStatus, lastError: undefined, schemaVersion: SCHEMA_VERSION };
    await persistRow('requests', updated);
    await useSessionStore.getState().hydrate();
    set({ requests: get().requests.map((item) => (item.id === id ? updated : item)) });
    return { scheduled: plan.scheduledMinutes, remainder: plan.remainderMinutes };
  },

  retrySchedule: async (id) => {
    const current = get().requests.find((request) => request.id === id);
    if (!current) return;
    await get().scheduleRequest(id);
  },

  suspendRequest: async (id) => {
    const current = get().requests.find((request) => request.id === id);
    if (!current) return;
    const next: ObsRequest = { ...current, status: '已挂起', schemaVersion: SCHEMA_VERSION };
    await persistRow('requests', next);
    set({ requests: get().requests.map((request) => (request.id === id ? next : request)) });
  },

  resumeRequest: async (id) => {
    const current = get().requests.find((request) => request.id === id);
    if (!current) return;
    const next: ObsRequest = { ...current, status: '待排段', schemaVersion: SCHEMA_VERSION };
    await persistRow('requests', next);
    set({ requests: get().requests.map((request) => (request.id === id ? next : request)) });
  },
}));
