import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import FieldRow from '../components/common/FieldRow';
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useApplicationStore } from '../stores/applicationStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTargetStore } from '../stores/targetStore';
import { APPLICATION_PROGRESS_COLORS } from '../types';
import { applicationProgress } from '../utils/reconcile';
import { formatMinutes } from '../utils/astro';

interface ApplicationFormState {
  code: string;
  targetId: string;
  requestedMinutes: number;
  deadline: string;
  applicant: string;
  note: string;
}

/** 新增时按当天日期生成默认编号（SQ-YYYYMMDD-三位序号） */
function nextCode(existing: string[]): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let seq = 1;
  while (existing.includes(`SQ-${stamp}-${String(seq).padStart(3, '0')}`)) seq += 1;
  return `SQ-${stamp}-${String(seq).padStart(3, '0')}`;
}

/** 申请台：只维护观测申请单（编号 / 目标 / 想拍时长 / 期限），排程段归编排台管理，两边互不改写 */
export default function ApplicationsPage() {
  usePersistentStore();
  const applications = useApplicationStore((s) => s.applications);
  const saveApplication = useApplicationStore((s) => s.saveApplication);
  const removeApplication = useApplicationStore((s) => s.removeApplication);
  const sessions = useSessionStore((s) => s.sessions);
  const targets = useTargetStore((s) => s.targets);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [warning, setWarning] = useState('');
  const [form, setForm] = useState<ApplicationFormState>({ code: '', targetId: '', requestedMinutes: 60, deadline: '', applicant: '', note: '' });

  const targetById = (id: string) => targets.find((target) => target.id === id);
  const editingOriginal = useMemo(() => applications.find((app) => app.id === editingId), [applications, editingId]);
  const minutesWillChange = Boolean(editingOriginal) && editingOriginal?.requestedMinutes !== Number(form.requestedMinutes);

  function openCreate() {
    setEditingId('');
    setError('');
    setForm({
      code: nextCode(applications.map((app) => app.code)),
      targetId: targets[0]?.id ?? '',
      requestedMinutes: 60,
      deadline: new Date().toISOString().slice(0, 10),
      applicant: '',
      note: '',
    });
    setDialogOpen(true);
  }

  function openEdit(id: string) {
    const app = applications.find((item) => item.id === id);
    if (!app) return;
    setEditingId(id);
    setError('');
    setForm({
      code: app.code,
      targetId: app.targetId,
      requestedMinutes: app.requestedMinutes,
      deadline: app.deadline,
      applicant: app.applicant,
      note: app.note ?? '',
    });
    setDialogOpen(true);
  }

  /** 保存失败（如本地库写坏）时表单原样保留，直接再点保存即按同一张单重试（幂等 upsert，不产生重复单） */
  async function submit() {
    if (!form.code.trim() || !form.targetId || !form.deadline || !form.applicant.trim()) {
      setError('编号、目标、期限与申请人均为必填');
      return;
    }
    if (Number(form.requestedMinutes) <= 0) {
      setError('想拍曝光时长必须大于 0 分钟');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await saveApplication({ ...form, requestedMinutes: Number(form.requestedMinutes), id: editingId || undefined });
      if (result.rescheduleError) {
        setWarning(result.rescheduleError);
        setNotice(`申请单 ${result.application.code} 已保存`);
      } else if (result.reschedule) {
        const { invalidated, created, queued } = result.reschedule;
        const queuedText = queued.length > 0 ? `；${queued.length} 张单容量不足排队顺延` : '';
        setNotice(`申请单 ${result.application.code} 已保存，时长改动已联动重排：失效 ${invalidated} 段、新排 ${created} 段${queuedText}`);
      } else {
        setNotice(`申请单 ${result.application.code} 已保存`);
      }
      setDialogOpen(false);
    } catch (reason) {
      setError(`保存失败：${(reason as Error).message}。可直接重试，重试仍写同一张单`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        观测申请单（申请台）
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        申请台只维护申请单：编号、目标、想拍的曝光时长与期限；排程段与望远镜空档归编排台管理，两边各留一份、互不改写，按申请编号对账。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}
      {warning ? (
        <Alert severity="warning" sx={{ mb: 2 }} onClose={() => setWarning('')}>
          {warning}
        </Alert>
      ) : null}

      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }} alignItems="center">
        <Button variant="contained" onClick={openCreate}>
          新增申请单
        </Button>
        <Chip size="small" label={`共 ${applications.length} 张单`} />
      </Stack>

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>申请编号</TableCell>
              <TableCell>目标</TableCell>
              <TableCell align="right">想拍时长</TableCell>
              <TableCell>期限</TableCell>
              <TableCell>申请人</TableCell>
              <TableCell>编排进度（编排台侧派生）</TableCell>
              <TableCell>备注</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {applications.map((app) => {
              const target = targetById(app.targetId);
              const info = applicationProgress(app, sessions);
              return (
                <TableRow key={app.id} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'Menlo, Consolas, monospace' }}>
                      {app.code}
                    </Typography>
                  </TableCell>
                  <TableCell>{target ? `${target.name}（${target.catalog}）` : '未知目标'}</TableCell>
                  <TableCell align="right">{formatMinutes(app.requestedMinutes)}</TableCell>
                  <TableCell>{app.deadline}</TableCell>
                  <TableCell>{app.applicant}</TableCell>
                  <TableCell>
                    <Chip size="small" color={APPLICATION_PROGRESS_COLORS[info.progress]} variant={info.progress === '待编排' ? 'outlined' : 'filled'} label={info.progress} />
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      有效段 {info.effective} / {app.requestedMinutes} 分钟
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {app.note ?? '-'}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Button size="small" onClick={() => openEdit(app.id)}>
                      编辑
                    </Button>
                    <Button size="small" color="error" onClick={() => void removeApplication(app.id)}>
                      删除
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {applications.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} align="center">
                  <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>
                    暂无申请单，点击「新增申请单」登记观测需求
                  </Typography>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingId ? '编辑申请单' : '新增申请单'}</DialogTitle>
        <DialogContent>
          {error ? (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              {error}
            </Alert>
          ) : null}
          {minutesWillChange ? (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              想拍时长从 {editingOriginal?.requestedMinutes} 分钟改为 {form.requestedMinutes} 分钟：保存后该单未确认的待执行段将失效等重排；已确认的段不挤掉，已完成的照旧留档。
            </Alert>
          ) : null}
          <FieldRow label="申请编号" required hint="两边对账的唯一键；保存失败重试仍写同一张单">
            <TextField size="small" fullWidth value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
          </FieldRow>
          <FieldRow label="观测目标" required>
            <TextField select size="small" fullWidth value={form.targetId} onChange={(event) => setForm({ ...form, targetId: event.target.value })}>
              {targets.map((target) => (
                <MenuItem key={target.id} value={target.id}>
                  {`${target.name}（${target.catalog}）· ${target.magnitude} 等`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="想拍时长" required hint="累计曝光分钟数；改动会触发编排台重排">
            <TextField size="small" type="number" fullWidth value={form.requestedMinutes} onChange={(event) => setForm({ ...form, requestedMinutes: Number(event.target.value) })} />
          </FieldRow>
          <FieldRow label="期限" required hint="编排台只把段排进期限内的观测夜">
            <TextField size="small" type="date" fullWidth value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })} />
          </FieldRow>
          <FieldRow label="申请人" required>
            <TextField size="small" fullWidth value={form.applicant} onChange={(event) => setForm({ ...form, applicant: event.target.value })} />
          </FieldRow>
          <FieldRow label="备注">
            <TextField size="small" fullWidth multiline minRows={2} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
          </FieldRow>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button variant="contained" disabled={saving} onClick={() => void submit()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
