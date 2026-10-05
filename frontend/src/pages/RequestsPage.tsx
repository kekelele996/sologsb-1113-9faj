import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
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
import { useRequestStore } from '../stores/requestStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTargetStore } from '../stores/targetStore';
import { REQUEST_STATUSES, REQUEST_STATUS_COLOR, type RequestStatus } from '../types';
import { durationMinutes } from '../utils/astro';

interface RequestFormState {
  targetId: string;
  exposureMinutes: number;
  deadline: string;
  remark: string;
}

/** 申请台：管观测申请单、编号、想拍的曝光时长与期限；编排台按单排段，失败重试这张单 */
export default function RequestsPage() {
  usePersistentStore();
  const requests = useRequestStore((s) => s.requests);
  const addRequest = useRequestStore((s) => s.addRequest);
  const updateRequest = useRequestStore((s) => s.updateRequest);
  const removeRequest = useRequestStore((s) => s.removeRequest);
  const scheduleRequest = useRequestStore((s) => s.scheduleRequest);
  const retrySchedule = useRequestStore((s) => s.retrySchedule);
  const suspendRequest = useRequestStore((s) => s.suspendRequest);
  const resumeRequest = useRequestStore((s) => s.resumeRequest);
  const sessions = useSessionStore((s) => s.sessions);
  const targets = useTargetStore((s) => s.targets);

  const [statusFilter, setStatusFilter] = useState<RequestStatus | '全部'>('全部');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState('');
  const [form, setForm] = useState<RequestFormState>({
    targetId: '',
    exposureMinutes: 60,
    deadline: '2025-10-15',
    remark: '',
  });

  const targetById = (id: string) => targets.find((target) => target.id === id);

  /** 每张申请单的已排 / 已完成 / 失效分钟 */
  const usageByRequest = useMemo(() => {
    const map = new Map<string, { scheduled: number; completed: number; invalidated: number }>();
    for (const request of requests) {
      const linked = sessions.filter((session) => session.requestId === request.id);
      const valid = linked.filter((session) => !session.invalidated);
      map.set(request.id, {
        scheduled: valid.reduce((sum, session) => sum + durationMinutes(session.startTime, session.endTime), 0),
        completed: valid.filter((session) => session.status === '已完成').reduce((sum, session) => sum + durationMinutes(session.startTime, session.endTime), 0),
        invalidated: linked.filter((session) => session.invalidated).reduce((sum, session) => sum + durationMinutes(session.startTime, session.endTime), 0),
      });
    }
    return map;
  }, [requests, sessions]);

  const visible = useMemo(() => {
    return [...requests]
      .filter((request) => (statusFilter === '全部' ? true : request.status === statusFilter))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [requests, statusFilter]);

  function openCreate() {
    setEditingId('');
    setError('');
    setForm({
      targetId: targets[0]?.id ?? '',
      exposureMinutes: 60,
      deadline: '2025-10-15',
      remark: '',
    });
    setDialogOpen(true);
  }

  function openEdit(id: string) {
    const request = requests.find((item) => item.id === id);
    if (!request) return;
    setEditingId(id);
    setError('');
    setForm({
      targetId: request.targetId,
      exposureMinutes: request.exposureMinutes,
      deadline: request.deadline,
      remark: request.remark ?? '',
    });
    setDialogOpen(true);
  }

  async function submit() {
    if (!form.targetId) {
      setError('请选择观测目标');
      return;
    }
    if (form.exposureMinutes <= 0) {
      setError('曝光时长必须大于 0');
      return;
    }
    if (!form.deadline) {
      setError('请选择期限');
      return;
    }
    if (editingId) {
      await updateRequest(editingId, {
        targetId: form.targetId,
        exposureMinutes: form.exposureMinutes,
        deadline: form.deadline,
        remark: form.remark,
      });
      setNotice('已更新申请单；若时长改动，没执行的段已失效等重排');
    } else {
      await addRequest({
        targetId: form.targetId,
        exposureMinutes: form.exposureMinutes,
        deadline: form.deadline,
        remark: form.remark,
      });
      setNotice('已新增申请单');
    }
    setDialogOpen(false);
  }

  async function doSchedule(id: string) {
    setBusyId(id);
    setError('');
    try {
      const result = await scheduleRequest(id);
      if (result.remainder > 0) {
        setNotice(`已排 ${result.scheduled} 分钟；${result.remainder} 分钟因期限前暗时段容量不足排队未排上`);
      } else {
        setNotice(`已按单排段 ${result.scheduled} 分钟`);
      }
    } catch (e) {
      setError(`排段失败，已重试：${(e as Error).message}`);
    } finally {
      setBusyId('');
    }
  }

  async function doRetry(id: string) {
    setBusyId(id);
    setError('');
    try {
      await retrySchedule(id);
      setNotice('重试排段成功');
    } catch (e) {
      setError(`重试仍失败：${(e as Error).message}`);
    } finally {
      setBusyId('');
    }
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        申请台
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        管观测申请单、编号、想拍的曝光时长与期限。编排台按单排段，每夜暗时段容量有限，满了排队顺到后面的夜，不挤掉已确认的段；申请单时长一改动，没执行的段失效等重排，拍完的照旧留档。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}
      {error ? (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      ) : null}

      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }} alignItems="center">
        <Button variant="contained" onClick={openCreate}>
          新增申请单
        </Button>
        <TextField select size="small" label="状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as RequestStatus | '全部')} sx={{ minWidth: 140 }}>
          {['全部', ...REQUEST_STATUSES].map((status) => (
            <MenuItem key={status} value={status}>
              {status}
            </MenuItem>
          ))}
        </TextField>
        <Chip size="small" label={`共 ${visible.length} 张申请单`} />
      </Stack>

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>申请编号</TableCell>
              <TableCell>目标</TableCell>
              <TableCell align="right">想拍时长</TableCell>
              <TableCell>期限</TableCell>
              <TableCell>排段进度</TableCell>
              <TableCell>状态</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map((request) => {
              const target = targetById(request.targetId);
              const usage = usageByRequest.get(request.id) ?? { scheduled: 0, completed: 0, invalidated: 0 };
              const pct = request.exposureMinutes > 0 ? Math.min(100, Math.round((usage.scheduled / request.exposureMinutes) * 100)) : 0;
              return (
                <TableRow key={request.id} hover>
                  <TableCell>
                    <Typography variant="body2">{request.code}</Typography>
                    {request.retryCount > 0 ? (
                      <Typography variant="caption" color="text.secondary">
                        已重试 {request.retryCount} 次
                      </Typography>
                    ) : null}
                  </TableCell>
                  <TableCell>{target?.name ?? '未知目标'}</TableCell>
                  <TableCell align="right">{request.exposureMinutes} 分钟</TableCell>
                  <TableCell>{request.deadline}</TableCell>
                  <TableCell sx={{ minWidth: 180 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <LinearProgress variant="determinate" value={pct} sx={{ flex: 1, height: 6, borderRadius: 3 }} />
                      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                        {usage.scheduled}/{request.exposureMinutes} 分
                      </Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary">
                      已完成 {usage.completed} 分
                      {usage.invalidated > 0 ? ` · 失效 ${usage.invalidated} 分` : ''}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" label={request.status} color={REQUEST_STATUS_COLOR[request.status]} variant={request.status === '待排段' ? 'outlined' : 'filled'} />
                  </TableCell>
                  <TableCell align="right">
                    {request.status === '排段失败' ? (
                      <Button size="small" color="error" disabled={busyId === request.id} onClick={() => void doRetry(request.id)}>
                        重试
                      </Button>
                    ) : (
                      <Button size="small" disabled={busyId === request.id || request.status === '已挂起'} onClick={() => void doSchedule(request.id)}>
                        排段
                      </Button>
                    )}
                    {request.status === '已挂起' ? (
                      <Button size="small" onClick={() => void resumeRequest(request.id)}>
                        恢复
                      </Button>
                    ) : (
                      <Button size="small" color="warning" onClick={() => void suspendRequest(request.id)}>
                        挂起
                      </Button>
                    )}
                    <Button size="small" onClick={() => openEdit(request.id)}>
                      编辑
                    </Button>
                    <Button size="small" color="error" onClick={() => void removeRequest(request.id)}>
                      删除
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} align="center">
                  <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>
                    暂无申请单
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
          <FieldRow label="观测目标" required>
            <TextField select size="small" fullWidth value={form.targetId} onChange={(event) => setForm({ ...form, targetId: event.target.value })}>
              {targets.map((target) => (
                <MenuItem key={target.id} value={target.id}>
                  {`${target.name}（${target.catalog}）· ${target.magnitude} 等`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="想拍曝光时长" required hint="单位分钟；改动后没执行的段失效等重排">
            <TextField size="small" type="number" fullWidth value={form.exposureMinutes} onChange={(event) => setForm({ ...form, exposureMinutes: Number(event.target.value) })} />
          </FieldRow>
          <FieldRow label="期限" required hint="YYYY-MM-DD，排段不晚于该夜">
            <TextField size="small" type="date" fullWidth value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })} InputLabelProps={{ shrink: true }} />
          </FieldRow>
          <FieldRow label="备注">
            <TextField size="small" fullWidth multiline minRows={2} value={form.remark} onChange={(event) => setForm({ ...form, remark: event.target.value })} />
          </FieldRow>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button variant="contained" onClick={() => void submit()}>
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
