'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'hearing.sqlite');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  initSchema(db);
  seed(db);
  return db;
}

function initSchema(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,
    username    TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('recordist','reviewer','participant')),
    password_hash TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 全局只有一份文档（一场听证会）；导入后创建第 1 个已发布版本
  CREATE TABLE IF NOT EXISTS doc_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    title TEXT NOT NULL,
    initialized INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    expires_at  INTEGER NOT NULL
  );

  -- 不可变版本：segments_json 为该版本全文快照 [{seg,text}]
  CREATE TABLE IF NOT EXISTS versions (
    id          INTEGER PRIMARY KEY,
    note        TEXT NOT NULL DEFAULT '',
    segments_json TEXT NOT NULL,
    created_by  INTEGER REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    -- 该版本决议水位线：本版本可见 id <= decision_watermark 的决议
    decision_watermark INTEGER NOT NULL DEFAULT 0
  );

  -- 修订提议：绑定提交时的已发布版本 base_version_id
  CREATE TABLE IF NOT EXISTS proposals (
    id          INTEGER PRIMARY KEY,
    seg         INTEGER NOT NULL,
    start_cp    INTEGER NOT NULL,   -- 码点偏移，半开区间 [start,end)
    end_cp      INTEGER NOT NULL,
    replacement TEXT NOT NULL,      -- 允许空串（删除）
    basis       TEXT NOT NULL,
    original_excerpt TEXT NOT NULL, -- 基版原文快照
    base_version_id INTEGER NOT NULL REFERENCES versions(id),
    status      TEXT NOT NULL CHECK (status IN ('pending','adopted','rejected','conflicted','published')),
    conflict_reason TEXT NOT NULL DEFAULT '',
    conflict_kind TEXT NOT NULL DEFAULT '',  -- 冲突类别：base_expired（基版已过期）| overlap（范围交叠）
    rebased_from_id INTEGER REFERENCES proposals(id), -- 续提来源：本提议由哪个冲突提议换算重提而来
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    decided_by  INTEGER REFERENCES users(id),
    decided_at  TEXT,
    published_version_id INTEGER REFERENCES versions(id)
  );

  -- 决议（不可变审计流；驳回/采纳/冲突/发布均留痕）
  CREATE TABLE IF NOT EXISTS decisions (
    id          INTEGER PRIMARY KEY,
    type        TEXT NOT NULL,           -- adopt | reject | conflict | publish
    proposal_id INTEGER REFERENCES proposals(id),
    version_id  INTEGER REFERENCES versions(id),
    actor_id    INTEGER REFERENCES users(id),
    reason      TEXT NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 异议引用：锚定到某段字符范围，保存原文快照
  CREATE TABLE IF NOT EXISTS objections (
    id          INTEGER PRIMARY KEY,
    seg         INTEGER NOT NULL,
    start_cp    INTEGER NOT NULL,
    end_cp      INTEGER NOT NULL,
    quoted_text TEXT NOT NULL,           -- 提交时被引原文快照
    note        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_relocation')),
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_in_version INTEGER NOT NULL REFERENCES versions(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 每个异议在每个已发布版本下的锚点（发布时从旧版本映射生成）
  CREATE TABLE IF NOT EXISTS objection_anchors (
    objection_id INTEGER NOT NULL REFERENCES objections(id),
    version_id   INTEGER NOT NULL REFERENCES versions(id),
    seg          INTEGER NOT NULL,
    start_cp     INTEGER NOT NULL,
    end_cp       INTEGER NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('active','needs_relocation')),
    PRIMARY KEY (objection_id, version_id)
  );

  CREATE TABLE IF NOT EXISTS objection_logs (
    id INTEGER PRIMARY KEY,
    objection_id INTEGER NOT NULL REFERENCES objections(id),
    actor_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,                -- create | relocate | respond | withdraw | response_published
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 发布前复核回应：复核员须逐条回应被“当前暂存修订”触及的异议。
  -- 草稿唯一（同一异议同时只允许一条 draft）；发布成功后草稿置为 published 并绑定新版本，
  -- 在对应历史版本只读展示。touched_proposal_ids_json / stage_fingerprint / anchor_*
  -- 记录回应时关联的采纳提议、暂存状态与异议当前锚点，发布时据此重新核对。
  CREATE TABLE IF NOT EXISTS objection_responses (
    id          INTEGER PRIMARY KEY,
    objection_id INTEGER NOT NULL REFERENCES objections(id),
    version_id  INTEGER NOT NULL REFERENCES versions(id),  -- 回应创建时的当前版本（复核上下文）
    note        TEXT NOT NULL,                           -- 非空回应说明
    status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
    touched_proposal_ids_json TEXT NOT NULL DEFAULT '[]', -- 回应绑定的相关采纳提议 id 列表
    stage_fingerprint TEXT NOT NULL DEFAULT '',           -- 回应时暂存区快照（留痕）
    anchor_seg  INTEGER NOT NULL,
    anchor_start_cp INTEGER NOT NULL,
    anchor_end_cp INTEGER NOT NULL,
    responded_by INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    published_version_id INTEGER REFERENCES versions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_proposals_base ON proposals(base_version_id, status);
  CREATE INDEX IF NOT EXISTS idx_decisions_version ON decisions(version_id);
  CREATE INDEX IF NOT EXISTS idx_anchors_version ON objection_anchors(version_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_one_draft
    ON objection_responses(objection_id) WHERE status = 'draft';
  CREATE INDEX IF NOT EXISTS idx_responses_published ON objection_responses(published_version_id);

  -- 预约发布：复核员把当前暂存修订预约到未来某个带 UTC 偏移的时刻发布。
  -- 同一时刻只允许一个 pending 预约（部分唯一索引保证）；status 流转：
  --   pending（待执行）→ executing（到点领取，事务内瞬时态）→ published（已执行，生成不可变版本）
  --   pending → cancelled（执行前取消）/ invalidated（到点核对快照不一致，失效）
  -- base_version_id / base_stage_json / touched_snapshot_json 固化预约时的版本、暂存修订集合
  -- 与受影响异议、回应关联状态；到点在同一事务内重新核对，一致才发布，否则置 invalidated。
  -- 失效处理不改动版本、提议与决议，须重新预约。
  CREATE TABLE IF NOT EXISTS publish_schedules (
    id          INTEGER PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','executing','published','cancelled','invalidated')),
    scheduled_at INTEGER NOT NULL,                         -- 预约时刻（epoch 毫秒，UTC 绝对时间）
    utc_offset_minutes INTEGER NOT NULL DEFAULT 0,         -- 提交时的 UTC 偏移（分钟），用于展示
    time_input  TEXT NOT NULL DEFAULT '',                  -- 原始时间输入（留痕）
    note        TEXT NOT NULL DEFAULT '',                  -- 预约时填写的版本说明
    base_version_id INTEGER NOT NULL REFERENCES versions(id),
    base_stage_json TEXT NOT NULL DEFAULT '[]',            -- 预约时采纳提议快照（id/段/范围/替换文字）
    stage_fingerprint TEXT NOT NULL DEFAULT '',            -- 预约时暂存区指纹
    touched_snapshot_json TEXT NOT NULL DEFAULT '[]',      -- 受影响异议及回应关联状态快照
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    invalid_reason TEXT NOT NULL DEFAULT '',               -- 未发布原因（失效原因；待执行时为空）
    invalidated_at TEXT,
    cancelled_at TEXT,
    executed_at  TEXT,
    published_version_id INTEGER REFERENCES versions(id)
  );

  -- 同一时刻仅允许一个待执行（或执行中）预约：部分唯一索引以常量为键
  CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_one_pending
    ON publish_schedules((1)) WHERE status IN ('pending','executing');
  CREATE INDEX IF NOT EXISTS idx_schedules_status ON publish_schedules(status, scheduled_at);
  `);

  // 既有数据库的轻量迁移：补充续提所需列，并按冲突原因文本回填类别
  const pcols = db.prepare('PRAGMA table_info(proposals)').all().map((c) => c.name);
  if (!pcols.includes('conflict_kind')) {
    db.exec(`ALTER TABLE proposals ADD COLUMN conflict_kind TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE proposals SET conflict_kind='base_expired' WHERE status='conflicted' AND conflict_reason LIKE '基版已过期%'`);
    db.exec(`UPDATE proposals SET conflict_kind='overlap' WHERE status='conflicted' AND conflict_kind='' AND conflict_reason<>''`);
  }
  if (!pcols.includes('rebased_from_id')) {
    db.exec(`ALTER TABLE proposals ADD COLUMN rebased_from_id INTEGER REFERENCES proposals(id)`);
  }
}

function seed(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  const accounts = [
    { username: process.env.SEED_RECORDIST_USER || 'recorder', password: process.env.SEED_RECORDIST_PASS || 'recorder123', role: 'recordist', display: '记录员' },
    { username: process.env.SEED_REVIEWER_USER || 'reviewer', password: process.env.SEED_REVIEWER_PASS || 'reviewer123', role: 'reviewer', display: '复核员' },
    { username: process.env.SEED_PARTICIPANT_USER || 'participant', password: process.env.SEED_PARTICIPANT_PASS || 'participant123', role: 'participant', display: '参与者' },
  ];
  const stmt = db.prepare('INSERT INTO users (username, display_name, role, password_hash) VALUES (?,?,?,?)');
  for (const a of accounts) stmt.run(a.username, a.display, a.role, hashPassword(a.password));
  console.log('[db] 已创建种子账户：', accounts.map((a) => `${a.username}/${a.password}(${a.role})`).join('  '));
}

if (require.main === module) {
  const db = openDb();
  console.log('[db] 初始化完成：', DB_PATH);
  db.close();
}

module.exports = { openDb, hashPassword, verifyPassword, DB_PATH };
