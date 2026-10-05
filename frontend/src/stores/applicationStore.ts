import { create } from 'zustand';
import { db, deleteRow, persistRow, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import type { ObsApplication } from '../types';
import type { QueueItem } from '../utils/scheduler';

export interface ApplicationInput {
  code: string;
  targetId: string;
  requestedMinutes: number;
  deadline: string;
  applicant: string;
  note?: string;
}

export interface RescheduleResult {
  /** 失效的未确认待执行段数量 */
  invalidated: number;
  /** 新排入的段数量 */
  created: number;
  /** 排不下、排队顺延的申请 */
  queued: QueueItem[];
}

export interface SaveApplicationResult {
  application: ObsApplication;
  /** 时长改动触发的编排台重排结果（未改动时长则无） */
  reschedule?: RescheduleResult;
  /** 编排台重排写坏时的提示（编排台侧已整体回滚，申请单不受影响） */
  rescheduleError?: string;
}

interface ApplicationState {
  applications: ObsApplication[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /**
   * 保存申请单（新增或更新）：按 id upsert，失败重试同一表单不会产生重复单。
   * 想拍时长改动时联动编排台重排；编排台写坏只退本侧，申请单照常保存。
   */
  saveApplication: (input: ApplicationInput & { id?: string }) => Promise<SaveApplicationResult>;
  removeApplication: (id: string) => Promise<void>;
}

/** 申请台台账：只维护申请单（编号 / 目标 / 想拍时长 / 期限），不触碰编排台的排程段 */
export const useApplicationStore = create<ApplicationState>()((set, get) => ({
  applications: [],
  hydrated: false,

  hydrate: async () => {
    const applications = await db.applications.orderBy('code').toArray();
    set({ applications, hydrated: true });
  },

  saveApplication: async (input) => {
    const existing = input.id ? get().applications.find((app) => app.id === input.id) : undefined;
    const codeClash = get().applications.find((app) => app.code === input.code.trim() && app.id !== existing?.id);
    if (codeClash) {
      throw new Error(`申请编号 ${input.code} 已存在，请更换编号`);
    }
    const minutesChanged = existing ? existing.requestedMinutes !== Number(input.requestedMinutes) : false;
    const application: ObsApplication = {
      id: existing?.id ?? uid('app'),
      code: input.code.trim(),
      targetId: input.targetId,
      requestedMinutes: Number(input.requestedMinutes) || 0,
      deadline: input.deadline,
      applicant: input.applicant.trim(),
      submittedAt: existing?.submittedAt ?? new Date().toISOString(),
      note: input.note?.trim() || undefined,
      schemaVersion: SCHEMA_VERSION,
    };
    // 申请台侧写入（upsert 幂等：写坏后重试同一张单不会生成重复记录）
    await persistRow('applications', application);
    set({ applications: [...get().applications.filter((app) => app.id !== application.id), application].sort((a, b) => a.code.localeCompare(b.code)) });

    const result: SaveApplicationResult = { application };
    if (minutesChanged) {
      // 时长改动 → 编排台把该单未确认的待执行段失效并重排；编排台写坏只退本侧，申请单保持已保存
      try {
        const { useSessionStore } = await import('./sessionStore');
        result.reschedule = await useSessionStore.getState().rescheduleForApplication(application);
      } catch {
        result.rescheduleError = '编排台重排写入失败，编排台侧已回滚；申请单已保存，可稍后在对账页重试重排';
      }
    }
    return result;
  },

  removeApplication: async (id) => {
    await deleteRow('applications', id);
    set({ applications: get().applications.filter((app) => app.id !== id) });
  },
}));
