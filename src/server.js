'use strict';
const path = require('path');
const express = require('express');
const { openDb, verifyPassword } = require('./db');
const { currentUser, requireAuth, requireRole, createSession, destroySession } = require('./auth');
const store = require('./store');
const { startScheduler } = require('./scheduler');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const db = openDb();
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(currentUser(db));

function publicUser(u) {
  return u ? { id: u.id, username: u.username, displayName: u.displayName, role: u.role } : null;
}

// 统一错误出口：业务错误须写明原因且不改变状态（错误在事务中抛出即回滚）
function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// ---------- 认证 ----------
app.post('/api/login', wrap((req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  const row = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误', code: 'BAD_CREDENTIALS' });
  }
  const token = createSession(db, row.id);
  res.setHeader(
    'Set-Cookie',
    `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 12}`
  );
  res.json({
    user: { id: row.id, username: row.username, displayName: row.display_name, role: row.role },
  });
}));

app.post('/api/logout', wrap((req, res) => {
  destroySession(db, req.sessionToken);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
}));

app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- 校订台总览 ----------
app.get('/api/booth', requireAuth, wrap((_req, res) => {
  res.json(store.boothView(db));
}));

// ---------- 导入（记录员，仅一次） ----------
app.post('/api/doc/import', requireRole('recordist'), wrap((req, res) => {
  const { title, text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: '缺少 text（UTF-8 逐字稿全文）' });
  const versionId = store.importTranscript(db, req.user, title, text);
  res.status(201).json({ ok: true, baseVersionId: versionId });
}));

// ---------- 提议（记录员） ----------
app.post('/api/proposals', requireRole('recordist'), wrap((req, res) => {
  const id = store.createProposal(db, req.user, req.body || {});
  res.status(201).json({ ok: true, id });
}));

app.post('/api/proposals/:id/adopt', requireRole('reviewer'), wrap((req, res) => {
  const result = store.adoptProposal(db, req.user, parseInt(req.params.id, 10));
  res.json({ ok: true, ...result });
}));

app.post('/api/proposals/:id/reject', requireRole('reviewer'), wrap((req, res) => {
  const { reason } = req.body || {};
  store.rejectProposal(db, req.user, parseInt(req.params.id, 10), reason);
  res.json({ ok: true });
}));

// ---------- 续提（记录员；仅限本人的“基版已过期”冲突提议，归属校验在 store 内） ----------
app.post('/api/proposals/:id/rebase-preview', requireRole('recordist'), wrap((req, res) => {
  res.json(store.rebasePreview(db, req.user, parseInt(req.params.id, 10)));
}));

app.post('/api/proposals/:id/rebase-confirm', requireRole('recordist'), wrap((req, res) => {
  const id = store.confirmRebase(db, req.user, parseInt(req.params.id, 10), req.body || {});
  res.status(201).json({ ok: true, id });
}));

// ---------- 发布（复核员） ----------
app.post('/api/publish', requireRole('reviewer'), wrap((req, res) => {
  const { note } = req.body || {};
  const versionId = store.publish(db, req.user, note);
  res.status(201).json({ ok: true, versionId });
}));

// ---------- 预约发布（复核员） ----------
// 预约：把当前暂存修订预约到未来某个带 UTC 偏移的时刻发布，并填写版本说明。
// 预约时按现有规则确认可发布；未导入正文、暂存区为空、时间无效/非未来、已有待执行预约均拒绝。
app.post('/api/publish-schedules', requireRole('reviewer'), wrap((req, res) => {
  const id = store.createSchedule(db, req.user, req.body || {});
  res.status(201).json({ ok: true, id });
}));

// 待执行预约与最近记录：展示预约时间、创建人、状态及未发布原因
app.get('/api/publish-schedules', requireAuth, wrap((_req, res) => {
  res.json(store.schedulePanel(db));
}));

// 执行前取消待执行预约
app.post('/api/publish-schedules/:id/cancel', requireRole('reviewer'), wrap((req, res) => {
  const { reason } = req.body || {};
  store.cancelSchedule(db, req.user, parseInt(req.params.id, 10), reason);
  res.json({ ok: true });
}));

// ---------- 异议（全部登录用户可提出；重新定位限提出者/复核员，在 store 内校验） ----------
app.post('/api/objections', requireAuth, wrap((req, res) => {
  const id = store.createObjection(db, req.user, req.body || {});
  res.status(201).json({ ok: true, id });
}));

app.post('/api/objections/:id/relocate', requireAuth, wrap((req, res) => {
  store.relocateObjection(db, req.user, parseInt(req.params.id, 10), req.body || {});
  res.json({ ok: true });
}));

// ---------- 发布前异议回应（复核员） ----------
// GET：查看当前版本待回应异议清单（任何登录用户可读；仅复核员可操作）
app.get('/api/review-checklist', requireAuth, wrap((_req, res) => {
  res.json(store.reviewChecklist(db));
}));

// 填写/更新对被暂存修订触及异议的回应（非空说明，自动关联异议/采纳提议/版本/暂存快照）
app.post('/api/objections/:id/respond', requireRole('reviewer'), wrap((req, res) => {
  const responseId = store.respondToObjection(db, req.user, parseInt(req.params.id, 10), req.body || {});
  res.status(201).json({ ok: true, responseId });
}));

// 撤回回应草稿（已随版本发布的回应只读，不可撤回）
app.delete('/api/objections/:id/response', requireRole('reviewer'), wrap((req, res) => {
  store.withdrawObjectionResponse(db, req.user, parseInt(req.params.id, 10));
  res.json({ ok: true });
}));

// ---------- 不可变版本视图 ----------
app.get('/api/versions/:id', requireAuth, wrap((req, res) => {
  res.json(store.versionView(db, parseInt(req.params.id, 10)));
}));

// ---------- 静态前端 ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 错误处理 ----------
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: err.message || '服务器内部错误',
    code: err.code || (status === 500 ? 'INTERNAL' : 'ERROR'),
    ...(err.details ? { details: err.details } : {}),
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`听证会校订台已启动：http://localhost:${PORT}`);
});

// 重启后继续处理未到时预约，并立即核查已逾期预约；之后周期性到点执行/失效核对
startScheduler(db, { executeNow: true });

module.exports = { app, server, db };
