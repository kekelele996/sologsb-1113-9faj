import Dexie, { type Table } from 'dexie';
import { useEffect, useState } from 'react';
import type { Instrument, ObsApplication, ObsNight, ObsSession, ObsTarget, ReconcileHold, Telescope } from '../types';
import { durationMinutes } from '../utils/astro';
import { uid } from '../utils/id';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbobsplan-db';

/** 当前数据结构版本，写入每条记录并用于升级迁移判定 */
export const SCHEMA_VERSION = 3;

class ObsPlanDB extends Dexie {
  targets!: Table<ObsTarget, string>;
  sessions!: Table<ObsSession, string>;
  telescopes!: Table<Telescope, string>;
  instruments!: Table<Instrument, string>;
  nights!: Table<ObsNight, string>;
  applications!: Table<ObsApplication, string>;
  reconcileHolds!: Table<ReconcileHold, string>;
  meta!: Table<{ key: string; value: string }, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      targets: 'id, name, catalog, type, priority, magnitude',
      sessions: 'id, nightId, targetId, telescopeId, instrumentId, startTime, status',
      telescopes: 'id, code, status',
      instruments: 'id, model, telescopeCode, terminalType',
      nights: 'id, date, siteName, primary, backup',
      meta: 'key',
    });

    // v2：排程段增加 backupNightId 索引；旧版本数据升级时补齐 backupNightId 与 schemaVersion
    // （因云取消且未指定替补夜的排程段，自动挂到最近的备用观测夜）
    this.version(2)
      .stores({
        targets: 'id, name, catalog, type, priority, magnitude',
        sessions: 'id, nightId, targetId, telescopeId, instrumentId, startTime, status, backupNightId',
        telescopes: 'id, code, status',
        instruments: 'id, model, telescopeCode, terminalType',
        nights: 'id, date, siteName, primary, backup',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        const nights = (await tx.table('nights').toArray()) as ObsNight[];
        const backupNight = nights.find((night) => night.backup);
        await tx
          .table('sessions')
          .toCollection()
          .modify((row: ObsSession) => {
            if (row.schemaVersion !== 2) {
              row.schemaVersion = 2;
            }
            if (!row.backupNightId && row.status === '因云取消' && backupNight) {
              row.backupNightId = backupNight.id;
            }
          });
      });

    // v3：双台账 —— 新增申请台（applications）与对账挂起（reconcileHolds）两表，排程段增加 applicationId 索引。
    // 旧数据的段没有编号：升级时先按「目标 + 观测夜」为旧段补建申请单存根（模拟申请台台账先行录入），
    // 再按目标和时段回填 applicationId（单张单回填额度不超过想拍时长）；挂不上的段保持空编号，单列待认领。
    this.version(3)
      .stores({
        targets: 'id, name, catalog, type, priority, magnitude',
        sessions: 'id, nightId, targetId, telescopeId, instrumentId, startTime, status, backupNightId, applicationId',
        telescopes: 'id, code, status',
        instruments: 'id, model, telescopeCode, terminalType',
        nights: 'id, date, siteName, primary, backup',
        applications: 'id, code, targetId, deadline',
        reconcileHolds: 'id, issueKey, kind, createdAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        const sessions = (await tx.table('sessions').toArray()) as ObsSession[];
        const nights = (await tx.table('nights').toArray()) as ObsNight[];
        const targets = (await tx.table('targets').toArray()) as ObsTarget[];
        let applications = (await tx.table('applications').toArray()) as ObsApplication[];

        // 申请台一张单都没有而编排台留有旧段：按「目标 + 观测夜」聚类补建申请单存根
        if (applications.length === 0 && sessions.length > 0) {
          const groups = new Map<string, ObsSession[]>();
          sessions
            .filter((session) => !session.applicationId && targets.some((target) => target.id === session.targetId))
            .forEach((session) => {
              const key = `${session.targetId}__${session.nightId}`;
              groups.set(key, [...(groups.get(key) ?? []), session]);
            });
          const stubs: ObsApplication[] = [];
          let seq = 1;
          groups.forEach((list, key) => {
            const [targetId, nightId] = key.split('__');
            const night = nights.find((item) => item.id === nightId);
            const minutes = list.reduce((sum, session) => sum + durationMinutes(session.startTime, session.endTime), 0);
            stubs.push({
              id: uid('app'),
              code: `SQ-MIG-${String(seq++).padStart(3, '0')}`,
              targetId,
              requestedMinutes: minutes,
              deadline: night?.date ?? '',
              applicant: '历史数据迁移',
              submittedAt: new Date().toISOString(),
              note: '升级时按目标与时段回填生成',
              schemaVersion: SCHEMA_VERSION,
            });
          });
          if (stubs.length > 0) {
            await tx.table('applications').bulkPut(stubs);
            applications = stubs;
          }
        }

        // 按目标和时段回填：同目标、期限不早于段所在夜日期、剩余额度够装下该段的最早一张单
        const remaining = new Map(applications.map((app) => [app.code, app.requestedMinutes]));
        const nightDate = new Map(nights.map((night) => [night.id, night.date]));
        await tx
          .table('sessions')
          .toCollection()
          .modify((row: ObsSession) => {
            row.schemaVersion = SCHEMA_VERSION;
            if (row.applicationId) return;
            const date = nightDate.get(row.nightId) ?? '';
            const minutes = durationMinutes(row.startTime, row.endTime);
            const hit = applications
              .filter((app) => app.targetId === row.targetId && app.deadline >= date && (remaining.get(app.code) ?? 0) >= minutes)
              .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))[0];
            if (hit) {
              row.applicationId = hit.code;
              remaining.set(hit.code, (remaining.get(hit.code) ?? 0) - minutes);
            }
            // 挂不上的保持空编号 → 待认领列表
          });
      });
  }
}

export const db = new ObsPlanDB();

export type TableName = 'targets' | 'sessions' | 'telescopes' | 'instruments' | 'nights' | 'applications' | 'reconcileHolds';

/** 写入单条记录（Dexie 读写封装，store 的增删改统一走这里） */
export async function persistRow(table: TableName, row: unknown): Promise<void> {
  await db.table(table).put(row as never);
}

/** 批量写入 */
export async function persistRows(table: TableName, rows: unknown[]): Promise<void> {
  await db.table(table).bulkPut(rows as never[]);
}

/** 删除记录 */
export async function deleteRow(table: TableName, id: string): Promise<void> {
  await db.table(table).delete(id);
}

/* ------------------------------- 示例数据 ------------------------------- */

const SEED_TARGETS: ObsTarget[] = [
  { id: 'target-001', name: 'M31', catalog: 'NGC 224', raHours: 0.712, decDeg: 41.27, magnitude: 3.4, type: '星系', filter: 'L', exposureSec: 120, totalMinutes: 90, priority: 'P1', minAltitude: 25, remark: '仙女座大星系，需大视场' },
  { id: 'target-002', name: 'M42', catalog: 'NGC 1976', raHours: 5.588, decDeg: -5.39, magnitude: 4, type: '星云', filter: 'L', exposureSec: 60, totalMinutes: 60, priority: 'P1', minAltitude: 20, remark: '猎户座大星云，核心易过曝' },
  { id: 'target-003', name: 'M45', catalog: 'Mel 22', raHours: 3.79, decDeg: 24.11, magnitude: 1.6, type: '疏散星团', filter: '无滤镜', exposureSec: 30, totalMinutes: 30, priority: 'P2', minAltitude: 25 },
  { id: 'target-004', name: 'NGC 7000', catalog: 'C20', raHours: 20.98, decDeg: 44.52, magnitude: 4, type: '星云', filter: 'Ha', exposureSec: 300, totalMinutes: 180, priority: 'P1', minAltitude: 35, remark: '北美洲星云，窄带优先' },
  { id: 'target-005', name: 'NGC 869', catalog: 'C14', raHours: 2.32, decDeg: 57.13, magnitude: 4.3, type: '疏散星团', filter: 'L', exposureSec: 60, totalMinutes: 45, priority: 'P2', minAltitude: 30, remark: '英仙双星团之一' },
  { id: 'target-006', name: 'M13', catalog: 'NGC 6205', raHours: 16.695, decDeg: 36.46, magnitude: 5.8, type: '疏散星团', filter: 'L', exposureSec: 90, totalMinutes: 60, priority: 'P2', minAltitude: 30, remark: '球状星团，暂归入星团类统计' },
  { id: 'target-007', name: 'M51', catalog: 'NGC 5194', raHours: 13.498, decDeg: 47.2, magnitude: 8.4, type: '星系', filter: 'L', exposureSec: 180, totalMinutes: 120, priority: 'P2', minAltitude: 40, remark: '涡状星系，暗目标' },
  { id: 'target-008', name: 'NGC 2237', catalog: 'C49', raHours: 6.52, decDeg: 4.95, magnitude: 9, type: '星云', filter: 'Ha', exposureSec: 300, totalMinutes: 150, priority: 'P2', minAltitude: 30, remark: '玫瑰星云' },
  { id: 'target-009', name: 'M27', catalog: 'NGC 6853', raHours: 19.99, decDeg: 22.72, magnitude: 7.4, type: '星云', filter: 'OIII', exposureSec: 180, totalMinutes: 90, priority: 'P2', minAltitude: 30, remark: '哑铃星云' },
  { id: 'target-010', name: '木星', catalog: 'Jupiter', raHours: 2.5, decDeg: 12.5, magnitude: -2.2, type: '行星', filter: '无滤镜', exposureSec: 0.02, totalMinutes: 20, priority: 'P1', minAltitude: 20, remark: '行星视频叠加' },
  { id: 'target-011', name: '月面', catalog: 'Moon', raHours: 0, decDeg: 0, magnitude: -12.7, type: '月面', filter: '无滤镜', exposureSec: 0.005, totalMinutes: 15, priority: 'P1', minAltitude: 15, remark: '月面细节拼接' },
  { id: 'target-012', name: 'IC 1396', catalog: 'C33', raHours: 21.65, decDeg: 57.5, magnitude: 3.5, type: '星云', filter: 'SII', exposureSec: 300, totalMinutes: 180, priority: 'P3', minAltitude: 40, remark: '象鼻星云' },
];

const SEED_NIGHTS: ObsNight[] = [
  { id: 'night-001', date: '2025-10-11', siteName: '兴隆观测站', siteLat: 40.3958, siteLng: 117.5772, moonPhasePct: 18, moonrise: '08:40', moonset: '19:05', sunset: '17:42', sunrise: '05:26', cloudText: '晴', primary: true, backup: false, dutyOfficer: '林一舟' },
  { id: 'night-002', date: '2025-10-12', siteName: '兴隆观测站', siteLat: 40.3958, siteLng: 117.5772, moonPhasePct: 26, moonrise: '09:35', moonset: '19:40', sunset: '17:41', sunrise: '05:27', cloudText: '少云', primary: true, backup: false, dutyOfficer: '林一舟' },
  { id: 'night-003', date: '2025-10-13', siteName: '兴隆观测站', siteLat: 40.3958, siteLng: 117.5772, moonPhasePct: 35, moonrise: '10:32', moonset: '20:18', sunset: '17:39', sunrise: '05:28', cloudText: '多云', primary: false, backup: true, dutyOfficer: '沈知远', remark: '备用观测夜' },
  { id: 'night-004', date: '2025-10-14', siteName: '兴隆观测站', siteLat: 40.3958, siteLng: 117.5772, moonPhasePct: 45, moonrise: '11:30', moonset: '21:00', sunset: '17:38', sunrise: '05:29', cloudText: '晴', primary: false, backup: true, dutyOfficer: '沈知远', remark: '备用观测夜' },
  { id: 'night-005', date: '2025-10-15', siteName: '兴隆观测站', siteLat: 40.3958, siteLng: 117.5772, moonPhasePct: 55, moonrise: '12:28', moonset: '21:46', sunset: '17:36', sunrise: '05:30', cloudText: '有雨', primary: false, backup: true, dutyOfficer: '苏晚', remark: '预报有雨，预留备用' },
];

const SEED_TELESCOPES: Telescope[] = [
  { id: 'tel-001', code: 'T-01', apertureMm: 150, focalLengthMm: 900, mount: 'EQ6-R Pro', terminals: ['CMOS 相机', '导星相机'], maxPayloadKg: 12, status: '可用' },
  { id: 'tel-002', code: 'T-02', apertureMm: 200, focalLengthMm: 1000, mount: 'CEM70', terminals: ['CMOS 相机', '导星相机', '光谱仪'], maxPayloadKg: 15, status: '可用' },
  { id: 'tel-003', code: 'T-03', apertureMm: 280, focalLengthMm: 2800, mount: 'CEM120', terminals: ['CMOS 相机', '光谱仪'], maxPayloadKg: 25, status: '维护中', },
  { id: 'tel-004', code: 'T-04', apertureMm: 80, focalLengthMm: 480, mount: 'Star Adventurer GTi', terminals: ['导星相机'], maxPayloadKg: 5, status: '外出' },
];

const SEED_INSTRUMENTS: Instrument[] = [
  { id: 'ins-001', model: 'ASI2600MC Pro', terminalType: 'CMOS 相机', pixelSizeUm: 3.76, sensorWidthMm: 23.5, sensorHeightMm: 15.7, readNoiseE: 1.2, telescopeCode: 'T-02' },
  { id: 'ins-002', model: 'ASI294MC Pro', terminalType: 'CMOS 相机', pixelSizeUm: 4.63, sensorWidthMm: 19.1, sensorHeightMm: 13, readNoiseE: 1.4, telescopeCode: 'T-01' },
  { id: 'ins-003', model: 'ASI174MM Mini', terminalType: '导星相机', pixelSizeUm: 5.86, sensorWidthMm: 11.3, sensorHeightMm: 7.1, readNoiseE: 3.5, telescopeCode: 'T-01' },
  { id: 'ins-004', model: 'Shelyak Lhires III', terminalType: '光谱仪', pixelSizeUm: 9, sensorWidthMm: 8, sensorHeightMm: 6, readNoiseE: 4, telescopeCode: 'T-03' },
];

/** 申请台台账示例：想拍时长与下方排程段一一对账；SQ-20251009-001/002 暂无排程段，演示排队待编排 */
const SEED_APPLICATIONS: ObsApplication[] = [
  { id: 'app-001', code: 'SQ-20251006-001', targetId: 'target-001', requestedMinutes: 120, deadline: '2025-10-15', applicant: '陈望', submittedAt: '2025-10-06T09:00:00', note: 'M31 两片拼接', schemaVersion: SCHEMA_VERSION },
  { id: 'app-002', code: 'SQ-20251006-002', targetId: 'target-002', requestedMinutes: 60, deadline: '2025-10-13', applicant: '陈望', submittedAt: '2025-10-06T09:05:00', schemaVersion: SCHEMA_VERSION },
  { id: 'app-003', code: 'SQ-20251006-003', targetId: 'target-004', requestedMinutes: 90, deadline: '2025-10-14', applicant: '李青禾', submittedAt: '2025-10-06T10:20:00', note: '窄带 Ha 优先', schemaVersion: SCHEMA_VERSION },
  { id: 'app-004', code: 'SQ-20251007-001', targetId: 'target-007', requestedMinutes: 90, deadline: '2025-10-12', applicant: '李青禾', submittedAt: '2025-10-07T08:40:00', schemaVersion: SCHEMA_VERSION },
  { id: 'app-005', code: 'SQ-20251007-002', targetId: 'target-009', requestedMinutes: 70, deadline: '2025-10-12', applicant: '赵铭', submittedAt: '2025-10-07T09:15:00', schemaVersion: SCHEMA_VERSION },
  { id: 'app-006', code: 'SQ-20251007-003', targetId: 'target-008', requestedMinutes: 90, deadline: '2025-10-12', applicant: '赵铭', submittedAt: '2025-10-07T09:16:00', schemaVersion: SCHEMA_VERSION },
  { id: 'app-007', code: 'SQ-20251007-004', targetId: 'target-011', requestedMinutes: 50, deadline: '2025-10-12', applicant: '苏晚', submittedAt: '2025-10-07T13:00:00', schemaVersion: SCHEMA_VERSION },
  { id: 'app-008', code: 'SQ-20251007-005', targetId: 'target-010', requestedMinutes: 100, deadline: '2025-10-13', applicant: '苏晚', submittedAt: '2025-10-07T13:02:00', schemaVersion: SCHEMA_VERSION },
  { id: 'app-009', code: 'SQ-20251008-001', targetId: 'target-003', requestedMinutes: 70, deadline: '2025-10-13', applicant: '林一舟', submittedAt: '2025-10-08T08:30:00', schemaVersion: SCHEMA_VERSION },
  { id: 'app-010', code: 'SQ-20251008-002', targetId: 'target-005', requestedMinutes: 110, deadline: '2025-10-13', applicant: '林一舟', submittedAt: '2025-10-08T08:31:00', schemaVersion: SCHEMA_VERSION },
  { id: 'app-011', code: 'SQ-20251009-001', targetId: 'target-006', requestedMinutes: 60, deadline: '2025-10-15', applicant: '陈望', submittedAt: '2025-10-09T10:00:00', note: '排队等编排', schemaVersion: SCHEMA_VERSION },
  { id: 'app-012', code: 'SQ-20251009-002', targetId: 'target-012', requestedMinutes: 80, deadline: '2025-10-15', applicant: '李青禾', submittedAt: '2025-10-09T11:00:00', note: '窄带 SII，等编排', schemaVersion: SCHEMA_VERSION },
];

/**
 * 含一处同望远镜时段冲突（s-03 与 s-04 在 T-02 上重叠）与一条因云取消已改期记录；
 * s-04 已确认（自动编排与重排不挤掉）；s-12 无申请编号，演示迁移挂不上的待认领段
 */
const SEED_SESSIONS: ObsSession[] = [
  { id: 's-01', nightId: 'night-001', targetId: 'target-001', startTime: '18:20', endTime: '19:20', telescopeId: 'tel-002', instrumentId: 'ins-001', filterSlot: 'L', plannedFrames: 40, status: '已完成', applicationId: 'SQ-20251006-001', schemaVersion: SCHEMA_VERSION },
  { id: 's-02', nightId: 'night-001', targetId: 'target-002', startTime: '19:30', endTime: '20:30', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: 'L', plannedFrames: 45, status: '已完成', applicationId: 'SQ-20251006-002', schemaVersion: SCHEMA_VERSION },
  { id: 's-03', nightId: 'night-001', targetId: 'target-004', startTime: '20:40', endTime: '22:10', telescopeId: 'tel-002', instrumentId: 'ins-001', filterSlot: 'Ha', plannedFrames: 30, status: '待执行', applicationId: 'SQ-20251006-003', schemaVersion: SCHEMA_VERSION },
  { id: 's-04', nightId: 'night-001', targetId: 'target-007', startTime: '21:30', endTime: '23:00', telescopeId: 'tel-002', instrumentId: 'ins-001', filterSlot: 'L', plannedFrames: 35, status: '待执行', applicationId: 'SQ-20251007-001', confirmed: true, schemaVersion: SCHEMA_VERSION, rescheduleReason: '与窄带目标争用 T-02，待改期' },
  { id: 's-05', nightId: 'night-001', targetId: 'target-009', startTime: '23:10', endTime: '00:20', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: 'OIII', plannedFrames: 28, status: '待执行', applicationId: 'SQ-20251007-002', schemaVersion: SCHEMA_VERSION },
  { id: 's-06', nightId: 'night-001', targetId: 'target-008', startTime: '00:30', endTime: '02:00', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: 'Ha', plannedFrames: 30, status: '待执行', applicationId: 'SQ-20251007-003', schemaVersion: SCHEMA_VERSION },
  { id: 's-07', nightId: 'night-001', targetId: 'target-011', startTime: '02:10', endTime: '03:00', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: '无滤镜', plannedFrames: 120, status: '待执行', applicationId: 'SQ-20251007-004', schemaVersion: SCHEMA_VERSION },
  { id: 's-08', nightId: 'night-001', targetId: 'target-010', startTime: '03:10', endTime: '04:00', telescopeId: 'tel-002', instrumentId: 'ins-001', filterSlot: '无滤镜', plannedFrames: 300, status: '待执行', applicationId: 'SQ-20251007-005', schemaVersion: SCHEMA_VERSION },
  { id: 's-09', nightId: 'night-002', targetId: 'target-003', startTime: '18:30', endTime: '19:40', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: '无滤镜', plannedFrames: 40, status: '已完成', applicationId: 'SQ-20251008-001', schemaVersion: SCHEMA_VERSION },
  { id: 's-10', nightId: 'night-002', targetId: 'target-005', startTime: '19:50', endTime: '21:40', telescopeId: 'tel-002', instrumentId: 'ins-001', filterSlot: 'L', plannedFrames: 50, status: '待执行', applicationId: 'SQ-20251008-002', schemaVersion: SCHEMA_VERSION },
  { id: 's-11', nightId: 'night-002', targetId: 'target-004', startTime: '21:50', endTime: '23:30', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: 'Ha', plannedFrames: 30, status: '因云取消', applicationId: 'SQ-20251006-003', schemaVersion: SCHEMA_VERSION, rescheduleReason: '夜间云量转多云，目标被云遮挡，改期至备用夜', backupNightId: 'night-003' },
  { id: 's-12', nightId: 'night-002', targetId: 'target-012', startTime: '23:40', endTime: '01:00', telescopeId: 'tel-002', instrumentId: 'ins-001', filterSlot: 'SII', plannedFrames: 30, status: '待执行', schemaVersion: SCHEMA_VERSION, rescheduleReason: '目标地平高度偏低，视情况顺延' },
  { id: 's-13', nightId: 'night-002', targetId: 'target-010', startTime: '01:10', endTime: '02:00', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: '无滤镜', plannedFrames: 240, status: '待执行', applicationId: 'SQ-20251007-005', schemaVersion: SCHEMA_VERSION },
  { id: 's-14', nightId: 'night-002', targetId: 'target-001', startTime: '02:10', endTime: '03:10', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: 'L', plannedFrames: 30, status: '待执行', applicationId: 'SQ-20251006-001', schemaVersion: SCHEMA_VERSION },
];

/** 首次打开（表内无数据）时写入示例数据 */
export async function seedIfEmpty(): Promise<void> {
  const flag = await db.meta.get('seeded');
  if (flag) return;
  const [targetCount, sessionCount, telescopeCount, instrumentCount, nightCount, applicationCount] = await Promise.all([
    db.targets.count(),
    db.sessions.count(),
    db.telescopes.count(),
    db.instruments.count(),
    db.nights.count(),
    db.applications.count(),
  ]);
  // 表数量超过 Dexie 事务的位置参数写法，改用表数组传参；meta 标记在事务外写入
  await db.transaction('rw', [db.targets, db.sessions, db.telescopes, db.instruments, db.nights, db.applications], async () => {
    if (targetCount === 0) await db.targets.bulkPut(SEED_TARGETS);
    if (nightCount === 0) await db.nights.bulkPut(SEED_NIGHTS);
    if (telescopeCount === 0) await db.telescopes.bulkPut(SEED_TELESCOPES);
    if (instrumentCount === 0) await db.instruments.bulkPut(SEED_INSTRUMENTS);
    if (sessionCount === 0) await db.sessions.bulkPut(SEED_SESSIONS);
    if (applicationCount === 0) await db.applications.bulkPut(SEED_APPLICATIONS);
  });
  await db.meta.put({ key: 'seeded', value: new Date().toISOString() });
}

/** 把 Dexie 数据同步到各 Zustand store（动态 import 规避模块循环依赖） */
export async function hydrateAllStores(): Promise<void> {
  const [{ useTargetStore }, { useSessionStore }, { useEquipmentStore }, { useNightStore }, { useApplicationStore }, { useReconcileStore }] =
    await Promise.all([
      import('../stores/targetStore'),
      import('../stores/sessionStore'),
      import('../stores/equipmentStore'),
      import('../stores/nightStore'),
      import('../stores/applicationStore'),
      import('../stores/reconcileStore'),
    ]);
  await Promise.all([
    useTargetStore.getState().hydrate(),
    useSessionStore.getState().hydrate(),
    useEquipmentStore.getState().hydrate(),
    useNightStore.getState().hydrate(),
    useApplicationStore.getState().hydrate(),
    useReconcileStore.getState().hydrate(),
  ]);
}

let bootstrap: Promise<void> | null = null;

/**
 * 封装 Dexie 表读写与 Zustand 同步：首次调用时打开数据库、写入示例数据并把表数据灌入 store，
 * 各页面用它判断数据是否就绪（多次调用复用同一 bootstrap，不重复装载）。
 */
export function usePersistentStore(): { ready: boolean; error: string } {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    if (!bootstrap) {
      bootstrap = (async () => {
        await db.open();
        await seedIfEmpty();
        await hydrateAllStores();
      })();
    }
    bootstrap
      .then(() => {
        if (alive) setReady(true);
      })
      .catch((reason: unknown) => {
        if (alive) {
          setError((reason as Error).message);
          setReady(true);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  return { ready, error };
}
