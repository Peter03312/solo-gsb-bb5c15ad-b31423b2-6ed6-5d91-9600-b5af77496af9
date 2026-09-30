'use strict';
// 业务核心：导入、提议、采纳/驳回、冲突标记、发布合版、版本视图、异议引用、基版过期提议的续提、
// 发布前异议回应闸门（被暂存修订触及的异议须逐条回应，回应失效/缺失时拒绝发布）
const { codeLength, sliceCP, validateRange, overlaps, applyEdits, transformRange, transformRangeRebase, touchesAnchor } = require('./text');

// ---------- 解析 ----------
// 行首段号格式： 12. 文字 / 12、文字 / 12 制表符或空格 + 文字；单独一行 "12" 视为空文段。
function parseTranscript(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw badRequest('逐字稿内容为空（须为 UTF-8 文本）');
  }
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const segments = [];
  const used = new Set();
  let auto = 1;
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    let m = raw.match(/^(\d+)[.、．]\s?(.*)$/) || raw.match(/^(\d+)[\t 　]+(.*)$/) || raw.match(/^(\d+)$/);
    if (m) {
      const seg = parseInt(m[1], 10);
      if (used.has(seg)) throw badRequest(`第 ${lineNo} 行：段号 ${seg} 重复，无法导入`);
      used.add(seg);
      segments.push({ seg, text: (m[2] || '').trim() });
    } else {
      const body = raw.trim();
      if (body === '') return; // 无段号空行：跳过
      while (used.has(auto)) auto++;
      used.add(auto);
      segments.push({ seg: auto, text: body });
      auto++;
    }
  });
  if (segments.length === 0) throw badRequest('未解析出任何段落：请使用“段号. 正文”格式或直接粘贴正文');
  return segments;
}

function badRequest(msg, code = 'BAD_REQUEST') {
  return Object.assign(new Error(msg), { status: 400, code });
}
function conflict(msg, code = 'CONFLICT') {
  return Object.assign(new Error(msg), { status: 409, code });
}
function notFound(msg) {
  return Object.assign(new Error(msg), { status: 404, code: 'NOT_FOUND' });
}
function forbidden(msg) {
  return Object.assign(new Error(msg), { status: 403, code: 'FORBIDDEN' });
}

// ---------- 读取辅助 ----------
function getDoc(db) {
  return db.prepare('SELECT * FROM doc_meta WHERE id = 1').get() || null;
}
function latestVersion(db) {
  return db.prepare('SELECT * FROM versions ORDER BY id DESC LIMIT 1').get() || null;
}
function segmentsOf(version) {
  return JSON.parse(version.segments_json);
}
function segIndex(segments, seg) {
  return segments.findIndex((s) => s.seg === seg);
}
function userLabel(u) {
  return u ? `${u.display_name}(${u.username})` : '';
}

function addDecision(db, { type, proposalId = null, versionId = null, actorId, reason = '', detail = {} }) {
  db.prepare(
    `INSERT INTO decisions (type, proposal_id, version_id, actor_id, reason, detail_json)
     VALUES (?,?,?,?,?,?)`
  ).run(type, proposalId, versionId, actorId, reason, JSON.stringify(detail));
}

// ---------- 导入 ----------
function importTranscript(db, actor, title, text) {
  if (getDoc(db)) throw conflict('逐字稿已导入并已发布初始版本，不能重复导入', 'ALREADY_INITIALIZED');
  const segments = parseTranscript(text);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO doc_meta (id, title, initialized) VALUES (1,?,1)').run(title || '未命名听证会');
    const r = db.prepare(
      'INSERT INTO versions (note, segments_json, created_by, decision_watermark) VALUES (?,?,?,0)'
    ).run('初始导入', JSON.stringify(segments), actor.id);
    return r.lastInsertRowid;
  });
  return tx();
}

// ---------- 提议 ----------
// 替换文字禁止换行/分段符（CR、LF、U+2028、U+2029），段结构只能按既有段号修订
function replacementHasNewline(s) {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

// 共用的提议落库逻辑：与同一基版上已采纳（暂存待发布）的修订范围交叠 → 直接标记冲突，绝不覆盖
function insertProposal(db, actor, { seg, start, end, replacement, basis, excerpt, baseVersionId, rebasedFromId = null }) {
  let status = 'pending';
  let conflictReason = '';
  const clash = db
    .prepare(
      `SELECT * FROM proposals
       WHERE status = 'adopted' AND base_version_id = ? AND seg = ?
         AND start_cp < ? AND ? < end_cp`
    )
    .get(baseVersionId, seg, end, start);
  if (clash) {
    status = 'conflicted';
    conflictReason = `与已采纳提议 #${clash.id} 的范围 [${clash.start_cp},${clash.end_cp}) 交叠；不能覆盖其他修订，请改提互不重叠的范围`;
  }
  const r = db.prepare(
    `INSERT INTO proposals
      (seg, start_cp, end_cp, replacement, basis, original_excerpt, base_version_id, status, conflict_reason, conflict_kind, rebased_from_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(seg, start, end, replacement, basis, excerpt, baseVersionId, status, conflictReason,
        status === 'conflicted' ? 'overlap' : '', rebasedFromId, actor.id);
  const id = r.lastInsertRowid;
  if (status === 'conflicted') {
    addDecision(db, {
      type: 'conflict',
      proposalId: id,
      versionId: baseVersionId,
      actorId: actor.id,
      reason: conflictReason,
    });
  }
  return id;
}

function createProposal(db, actor, body) {
  const doc = getDoc(db);
  if (!doc) throw conflict('尚未导入逐字稿，无法提交提议', 'NO_DOCUMENT');
  const base = latestVersion(db);
  const segments = segmentsOf(base);

  const seg = parseInt(body.seg, 10);
  const start = parseInt(body.start, 10);
  const end = parseInt(body.end, 10);
  const replacement = typeof body.replacement === 'string' ? body.replacement : null;
  const basis = typeof body.basis === 'string' ? body.basis.trim() : '';
  if (!Number.isInteger(seg)) throw badRequest('缺少有效的段号 seg');
  if (replacement === null) throw badRequest('替换文字必须为字符串（空串表示删除该范围）');
  if (replacementHasNewline(replacement)) throw badRequest('替换文字不能包含换行，段结构只能按既有段号修订');
  if (!basis) throw badRequest('修订依据不能为空');

  const idx = segIndex(segments, seg);
  if (idx === -1) throw badRequest(`非法范围：基版 v${base.id} 中不存在段 ${seg}`);
  const vr = validateRange(segments[idx].text, start, end);

  const insert = db.transaction(() =>
    insertProposal(db, actor, {
      seg, start, end, replacement, basis, excerpt: vr.excerpt, baseVersionId: base.id,
    })
  );
  return insert();
}

// 复核：采纳。基版过期 / 与暂存区交叠 → 不改既有修订，将本提议标记为冲突并写明原因。
function adoptProposal(db, actor, id) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  if (!p) throw notFound(`提议 #${id} 不存在`);
  if (p.status === 'published') throw conflict(`提议 #${id} 已随 v${p.published_version_id} 发布，无需再采纳`, 'ALREADY_PUBLISHED');
  if (p.status === 'rejected') throw conflict(`提议 #${id} 已被驳回，不能采纳；如需修订请重新提交`, 'ALREADY_REJECTED');
  if (p.status === 'conflicted') throw conflict(`提议 #${id} 已标记冲突，不能采纳；请基于最新版本重新提交`, 'ALREADY_CONFLICTED');
  if (p.status === 'adopted') throw conflict(`提议 #${id} 已在暂存区，请勿重复采纳`, 'ALREADY_ADOPTED');

  const cur = latestVersion(db);
  const markConflict = db.transaction((reason, kind) => {
    db.prepare(`UPDATE proposals SET status='conflicted', conflict_reason=?, conflict_kind=? WHERE id=?`).run(reason, kind, id);
    addDecision(db, { type: 'conflict', proposalId: id, versionId: cur.id, actorId: actor.id, reason });
  });

  if (p.base_version_id !== cur.id) {
    const reason = `基版已过期：提议提交时绑定 v${p.base_version_id}，当前已发布版本为 v${cur.id}；请基于 v${cur.id} 重新提交`;
    markConflict(reason, 'base_expired');
    return { markedConflict: true, reason };
  }
  const clash = db
    .prepare(
      `SELECT * FROM proposals
       WHERE status='adopted' AND base_version_id=? AND seg=? AND id<>?
         AND start_cp < ? AND ? < end_cp`
    )
    .get(cur.id, p.seg, id, p.end_cp, p.start_cp);
  if (clash) {
    const reason = `范围交叠：提议 #${id} [${p.start_cp},${p.end_cp}) 与已采纳提议 #${clash.id} [${clash.start_cp},${clash.end_cp}) 冲突；不能覆盖其他修订`;
    markConflict(reason, 'overlap');
    return { markedConflict: true, reason };
  }
  db.transaction(() => {
    db.prepare(
      `UPDATE proposals SET status='adopted', decided_by=?, decided_at=datetime('now'), conflict_reason='' WHERE id=?`
    ).run(actor.id, id);
    addDecision(db, { type: 'adopt', proposalId: id, versionId: cur.id, actorId: actor.id });
  })();
  return { markedConflict: false };
}

function rejectProposal(db, actor, id, reason) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  if (!p) throw notFound(`提议 #${id} 不存在`);
  if (p.status === 'published') throw conflict(`提议 #${id} 已发布，不能驳回`, 'ALREADY_PUBLISHED');
  if (p.status === 'conflicted') throw conflict(`提议 #${id} 已标记冲突，无需驳回`, 'ALREADY_CONFLICTED');
  if (p.status === 'rejected') throw conflict(`提议 #${id} 已被驳回，请勿重复操作`, 'ALREADY_REJECTED');
  const from = p.status; // pending | adopted
  db.transaction(() => {
    db.prepare(
      `UPDATE proposals SET status='rejected', decided_by=?, decided_at=datetime('now'), conflict_reason=? WHERE id=?`
    ).run(actor.id, reason || '', id);
    addDecision(db, {
      type: 'reject',
      proposalId: id,
      versionId: latestVersion(db).id,
      actorId: actor.id,
      reason: reason || '',
      detail: { previousStatus: from },
    });
  })();
}

// ---------- 暂存预览 ----------
function stageProposals(db, versionId) {
  return db
    .prepare(`SELECT * FROM proposals WHERE status='adopted' AND base_version_id=? ORDER BY seg, start_cp`)
    .all(versionId);
}

function previewSegments(segments, stage) {
  const bySeg = new Map();
  for (const p of stage) {
    if (!bySeg.has(p.seg)) bySeg.set(p.seg, []);
    bySeg.get(p.seg).push({ start: p.start_cp, end: p.end_cp, replace: p.replacement, id: p.id });
  }
  return segments.map((s) => {
    const edits = bySeg.get(s.seg);
    return edits ? { seg: s.seg, text: applyEdits(s.text, edits) } : s;
  });
}

// ---------- 发布 ----------
function publish(db, actor, note) {
  const cur = latestVersion(db);
  if (!cur) throw conflict('尚未导入逐字稿，无可发布内容', 'NO_DOCUMENT');
  const stage = stageProposals(db, cur.id);
  if (stage.length === 0) {
    throw conflict('重复发布被拒绝：暂存区中没有已采纳修订，发布必须包含修订并形成新版本', 'EMPTY_PUBLISH');
  }
  const segments = segmentsOf(cur);
  const tx = db.transaction(() => {
    // 发布闸门在事务内确认：被暂存修订触及的异议必须已逐条有效回应
    const touched = assertObjectionsResolved(db, cur, stage);
    return commitPublish(db, actor, note, { cur, stage, segments, touched });
  });
  return tx.immediate();
}

// 发布落版主体：可在人工发布或预约到期事务中复用。调用方须已在事务内通过发布闸门。
function commitPublish(db, actor, note, { cur, stage, segments, touched }) {
  // 1) 合版：同一基版上互不重叠的采纳结果按段合并
  const newSegments = previewSegments(segments, stage);

  const vr = db.prepare(
    'INSERT INTO versions (note, segments_json, created_by, decision_watermark) VALUES (?,?,?,0)'
  ).run((note || '').trim() || '发布修订', JSON.stringify(newSegments), actor.id);
  const newId = vr.lastInsertRowid;

  // 2) 已采纳提议落版
  const markPublished = db.prepare(
    `UPDATE proposals SET status='published', published_version_id=? WHERE id=?`
  );
  for (const p of stage) {
    markPublished.run(newId, p.id);
    addDecision(db, {
      type: 'publish',
      proposalId: p.id,
      versionId: newId,
      actorId: actor.id,
      reason: `随 v${newId} 发布`,
      detail: { seg: p.seg, start: p.start_cp, end: p.end_cp },
    });
  }

  // 3) 新版本形成后，所有仍待复核的提议基版均已过期 → 标记冲突
  //    （不能悄悄失效，也不能覆盖新修订；须由记录员基于新版本重新提交）
  const stale = db.prepare(`SELECT * FROM proposals WHERE status='pending'`).all();
  for (const p of stale) {
    const reason = `基版已过期：提议提交时绑定 v${p.base_version_id}，发布后当前版本为 v${newId}；请基于新版本重新提交`;
    db.prepare(`UPDATE proposals SET status='conflicted', conflict_reason=?, conflict_kind='base_expired' WHERE id=?`).run(reason, p.id);
    addDecision(db, { type: 'conflict', proposalId: p.id, versionId: newId, actorId: null, reason });
  }

  // 4) 异议锚点映射：相交即需重新定位，保留原文快照
  mapObjectionAnchors(db, newId, stage);

  // 4.5) 回应固化：通过闸门的回应草稿绑定到本次发布版本，在该历史版本只读展示
  const publishDraft = db.prepare(
    `UPDATE objection_responses SET status='published', published_version_id=?
     WHERE objection_id=? AND status='draft' AND version_id=?`
  );
  for (const objectionId of touched.keys()) {
    const dr = publishDraft.run(newId, objectionId, cur.id);
    if (dr.changes === 0) continue; // 闸门已保证存在有效草稿；防御性跳过
    const resp = db
      .prepare('SELECT * FROM objection_responses WHERE objection_id=? AND published_version_id=?')
      .get(objectionId, newId);
    const info = touched.get(objectionId);
    addDecision(db, {
      type: 'objection_respond',
      proposalId: null,
      versionId: newId,
      actorId: actor.id,
      reason: `发布前对被触及异议 #${objectionId} 的回应`,
      detail: {
        responseId: resp.id,
        objectionId,
        touchedProposalIds: info.proposals,
        note: resp.note,
      },
    });
    db.prepare(
      `INSERT INTO objection_logs (objection_id, actor_id, action, detail_json) VALUES (?,?, 'response_published', ?)`
    ).run(objectionId, actor.id, JSON.stringify({ responseId: resp.id, version: newId }));
  }

  // 5) 决议水位线：包含本次发布产生的全部决议
  const watermark = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM decisions').get().m;
  db.prepare('UPDATE versions SET decision_watermark=? WHERE id=?').run(watermark, newId);

  return newId;
}

function editsBySegment(stage) {
  const map = new Map();
  for (const p of stage) {
    if (!map.has(p.seg)) map.set(p.seg, []);
    map.get(p.seg).push({ start: p.start_cp, end: p.end_cp, replace: p.replacement, proposalId: p.id });
  }
  return map;
}

function mapObjectionAnchors(db, newVersionId, stage) {
  const editsMap = editsBySegment(stage);
  // 以“当前最新锚点”为映射基准（异议可能已在当前版本被重新定位，旧版本锚点已过时），
  // 并以主表当前状态为准：已手动重新定位（active）的异议不得因复制旧锚点而回退为待重定位。
  const anchors = db
    .prepare(
      `SELECT a.objection_id, a.seg, a.start_cp, a.end_cp, o.status AS master_status
       FROM objection_anchors a
       JOIN objections o ON o.id = a.objection_id
       WHERE a.version_id = (
         SELECT MAX(version_id) FROM objection_anchors WHERE objection_id = a.objection_id
       )`
    )
    .all();
  const newSegments = segmentsOf(db.prepare('SELECT * FROM versions WHERE id=?').get(newVersionId));
  const lenOf = new Map(newSegments.map((s) => [s.seg, codeLength(s.text)]));

  const ins = db.prepare(
    `INSERT INTO objection_anchors (objection_id, version_id, seg, start_cp, end_cp, status)
     VALUES (?,?,?,?,?,?)`
  );
  const updMaster = db.prepare(
    `UPDATE objections SET seg=?, start_cp=?, end_cp=?, status='needs_relocation' WHERE id=?`
  );
  for (const a of anchors) {
    const edits = editsMap.get(a.seg) || [];
    const t = transformRange({ start: a.start_cp, end: a.end_cp }, edits);
    // 主表 active 说明此前已人工确认过位置：只有本次修订再次相交才重新置为待重定位
    let status = a.master_status === 'active' ? 'active' : 'needs_relocation';
    if (t.affected) status = 'needs_relocation';
    const maxEnd = lenOf.get(a.seg) ?? t.end;
    t.start = Math.max(0, Math.min(t.start, maxEnd));
    t.end = Math.max(t.start, Math.min(t.end, maxEnd));
    ins.run(a.objection_id, newVersionId, a.seg, t.start, t.end, status);
    if (t.affected) updMaster.run(a.seg, t.start, t.end, a.objection_id);
  }
}

// ---------- 发布前：受暂存修订触及的异议与回应闸门 ----------
// 以异议在“当前版本”的锚点为准（异议可能已被手动重新定位），按段内码点半开区间判断触及。
function currentObjectionAnchors(db, versionId) {
  return db
    .prepare(
      `SELECT a.objection_id AS objectionId, a.seg, a.start_cp AS start, a.end_cp AS 'end',
              a.status AS anchor_status
       FROM objection_anchors a
       WHERE a.version_id = ?
       ORDER BY a.objection_id`
    )
    .all(versionId);
}

// 计算当前暂存修订触及的异议：返回 Map(objectionId -> { anchor, proposals })
function touchedByStage(db, versionId, stage) {
  const map = new Map();
  if (!stage.length) return map;
  const editsMap = editsBySegment(stage);
  for (const a of currentObjectionAnchors(db, versionId)) {
    const edits = editsMap.get(a.seg) || [];
    if (!edits.length) continue;
    if (touchesAnchor({ start: a.start, end: a.end }, edits)) {
      map.set(a.objectionId, {
        anchor: { seg: a.seg, start: a.start, end: a.end },
        proposals: edits
          .filter((e) =>
            e.start === e.end
              ? a.start <= e.start && e.start <= a.end
              : e.start < a.end && a.start < e.end
          )
          .map((e) => e.proposalId),
      });
    }
  }
  return map;
}

function listDraftResponses(db, versionId) {
  return db
    .prepare(
      `SELECT r.*, u.display_name AS responder_name, u.username AS responder_user
       FROM objection_responses r
       JOIN users u ON u.id = r.responded_by
       WHERE r.status='draft' AND r.version_id=?`
    )
    .all(versionId);
}

// 重新核对一条回应草稿是否仍有效，并给出失效原因（数组；为空表示仍满足发布要求）
function validateResponseDraft(db, r, touched) {
  const reasons = [];
  if (r.version_id !== touched.versionId) {
    reasons.push(`回应在 v${r.version_id} 填写，当前版本已为 v${touched.versionId}，请基于当前版本重新回应`);
  }
  const cur = touched.byId.get(r.objection_id);
  if (!cur) {
    reasons.push('该异议已不被当前暂存修订触及（暂存区或异议锚点已变化），此回应不再适用于本次发布');
  } else {
    const want = [...cur.proposals].sort((a, b) => a - b);
    const bound = JSON.parse(r.touched_proposal_ids_json || '[]').slice().sort((a, b) => a - b);
    if (want.length === 0) {
      reasons.push('该异议当前不与任何暂存修订相关');
    } else if (want.join(',') !== bound.join(',')) {
      reasons.push(
        `关联的采纳提议集合已变化：回应时绑定 #${bound.join(',#') || '（无）'}，` +
          `当前触及该异议的是 #${want.join(',#')}`
      );
    }
    if (r.anchor_seg !== cur.anchor.seg || r.anchor_start_cp !== cur.anchor.start || r.anchor_end_cp !== cur.anchor.end) {
      reasons.push(
        `异议锚点已变化：回应时为第 ${r.anchor_seg} 段 [${r.anchor_start_cp},${r.anchor_end_cp})，` +
          `当前为第 ${cur.anchor.seg} 段 [${cur.anchor.start},${cur.anchor.end})（异议可能已被重新定位）`
      );
    }
  }
  if (!(typeof r.note === 'string' && r.note.trim())) {
    reasons.push('回应说明为空');
  }
  return reasons;
}

// 复核清单：受影响异议 + 各自回应绑定状态（待回应 / 已回应 / 回应失效 / 无需回应）
function reviewChecklist(db, versionId = null) {
  const cur = versionId ? db.prepare('SELECT * FROM versions WHERE id=?').get(versionId) : latestVersion(db);
  if (!cur) return { versionId: 0, stageCount: 0, items: [], counts: {} };
  const stage = stageProposals(db, cur.id);
  const byId = touchedByStage(db, cur.id, stage);
  const drafts = new Map(listDraftResponses(db, cur.id).map((r) => [r.objection_id, r]));

  const items = [];
  for (const [objectionId, info] of byId) {
    const o = db.prepare('SELECT * FROM objections WHERE id=?').get(objectionId);
    const r = drafts.get(objectionId) || null;
    let state;
    let invalidReasons = [];
    if (!r) {
      state = 'missing'; // 尚无回应
    } else {
      invalidReasons = validateResponseDraft(db, r, { versionId: cur.id, byId });
      state = invalidReasons.length ? 'invalid' : 'responded';
    }
    items.push({
      objectionId,
      note: o.note,
      quotedText: o.quoted_text,
      anchor: info.anchor,
      touchedProposalIds: info.proposals,
      state,
      invalidReasons,
      response: r
        ? {
            id: r.id,
            note: r.note,
            responderName: r.responder_name,
            responderUser: r.responder_user,
            boundProposalIds: JSON.parse(r.touched_proposal_ids_json || '[]'),
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          }
        : null,
    });
  }
  // 已不被触及但仍留着的回应草稿（失效但不阻塞，可撤回或改作他用）
  for (const r of drafts.values()) {
    if (byId.has(r.objection_id)) continue;
    const o = db.prepare('SELECT * FROM objections WHERE id=?').get(r.objection_id);
    items.push({
      objectionId: r.objection_id,
      note: o ? o.note : '',
      quotedText: o ? o.quoted_text : '',
      anchor: { seg: r.anchor_seg, start: r.anchor_start_cp, end: r.anchor_end_cp },
      touchedProposalIds: [],
      state: 'orphan',
      invalidReasons: ['该异议已不被当前暂存修订触及，回应草稿不会随本次发布；可撤回后待下次发布重新回应'],
      response: {
        id: r.id,
        note: r.note,
        responderName: r.responder_name,
        responderUser: r.responder_user,
        boundProposalIds: JSON.parse(r.touched_proposal_ids_json || '[]'),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      },
    });
  }
  items.sort((a, b) => a.objectionId - b.objectionId);
  const counts = { missing: 0, invalid: 0, responded: 0, orphan: 0 };
  for (const it of items) counts[it.state]++;
  return { versionId: cur.id, stageCount: stage.length, items, counts };
}

// 发布闸门：存在缺失/失效回应时抛 409（结构化携带清单）；返回受影响映射供发布事务复用
function assertObjectionsResolved(db, cur, stage) {
  const byId = touchedByStage(db, cur.id, stage);
  const drafts = new Map(listDraftResponses(db, cur.id).map((r) => [r.objection_id, r]));
  const blocking = [];
  for (const [objectionId, info] of byId) {
    const r = drafts.get(objectionId);
    if (!r) {
      blocking.push({ objectionId, state: 'missing', invalidReasons: ['尚未回应'] });
      continue;
    }
    const invalidReasons = validateResponseDraft(db, r, { versionId: cur.id, byId });
    if (invalidReasons.length) blocking.push({ objectionId, state: 'invalid', invalidReasons });
  }
  if (blocking.length) {
    const ids = blocking.map((b) => `#${b.objectionId}`).join('、');
    throw Object.assign(
      conflict(
        `发布被拒绝：以下被暂存修订触及的异议尚有 ${blocking.length} 条未逐条回应或回应已失效：${ids}；` +
          '请在异议面板逐条回应后重新发布（版本、提议与决议均未改变）',
        'PENDING_OBJECTION_RESPONSES'
      ),
      { details: { versionId: cur.id, blocking } }
    );
  }
  return byId;
}

// ---------- 续提（基版已过期冲突提议的换算重提） ----------
function conflictKindOf(p) {
  if (p.conflict_kind) return p.conflict_kind;
  // 兼容迁移前的旧数据：按冲突原因文本推断
  return (p.conflict_reason || '').startsWith('基版已过期') ? 'base_expired' : 'overlap';
}

// 前置校验：提议存在、本人提交、处于冲突状态、且为“基版已过期”类冲突
function rebaseTarget(db, actor, id) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  if (!p) throw notFound(`提议 #${id} 不存在`);
  if (p.created_by !== actor.id) {
    throw forbidden(`无权操作：只能续提本人提交的提议（#${id} 由他人提交）`);
  }
  if (p.status !== 'conflicted') {
    throw conflict(`提议 #${id} 当前状态为“${p.status}”，只有被标记为冲突的提议才能续提`, 'NOT_CONFLICTED');
  }
  if (conflictKindOf(p) !== 'base_expired') {
    throw conflict(`提议 #${id} 的冲突原因不是“基版已过期”，不能续提；请在当前正文中手工选区重新提交`, 'NOT_BASE_EXPIRED');
  }
  return p;
}

// 把提议的段内选区按从基版到当前版本逐次发布的修订换算。
// 任一中途修订触及选区（或零长度选区的插入点）、目标段缺失、换算结果越界 → 抛出 409；
// 绝不凭同文搜索猜测位置。
function computeRebaseMapping(db, p, cur) {
  const published = db
    .prepare(
      `SELECT published_version_id AS ver, id, start_cp, end_cp, replacement
       FROM proposals
       WHERE status='published' AND published_version_id > ? AND published_version_id <= ? AND seg = ?
       ORDER BY published_version_id, start_cp`
    )
    .all(p.base_version_id, cur.id, p.seg);
  const byVer = new Map();
  for (const r of published) {
    if (!byVer.has(r.ver)) byVer.set(r.ver, []);
    byVer.get(r.ver).push({ start: r.start_cp, end: r.end_cp, replace: r.replacement, proposalId: r.id });
  }
  let range = { start: p.start_cp, end: p.end_cp };
  const point = range.start === range.end;
  const steps = [];
  for (let v = p.base_version_id + 1; v <= cur.id; v++) {
    const edits = byVer.get(v) || [];
    const t = transformRangeRebase(range, edits);
    if (t.affected) {
      const hit = edits.find((e) =>
        point ? e.start <= range.start && range.start <= e.end : e.start < range.end && range.start < e.end
      );
      throw conflict(
        `中途发布的修订触及${point ? '零长度选区的插入点' : '原选区'}：` +
          `v${v} 合并的修订（提议 #${hit ? hit.proposalId : '?'}）改动了该范围，无法可靠换算到当前正文；` +
          `请在当前版本中手工选区重新提交`,
        'REBASE_TOUCHED'
      );
    }
    range = { start: t.start, end: t.end };
    steps.push({ version: v, edits: edits.length });
  }
  const segments = segmentsOf(cur);
  const idx = segIndex(segments, p.seg);
  if (idx === -1) {
    throw conflict(
      `目标段缺失：第 ${p.seg} 段在当前版本 v${cur.id} 中不存在，无法续提；请在当前正文手工选区重新提交`,
      'SEGMENT_MISSING'
    );
  }
  const text = segments[idx].text;
  const len = codeLength(text);
  if (range.start < 0 || range.start > range.end || range.end > len) {
    throw conflict(
      `换算结果越界：[${range.start},${range.end}) 超出第 ${p.seg} 段当前长度 ${len}，无法续提；请在当前正文手工选区重新提交`,
      'REBASE_OUT_OF_RANGE'
    );
  }
  return { seg: p.seg, start: range.start, end: range.end, excerpt: sliceCP(text, range.start, range.end), steps };
}

// 暂存区指纹：预览后任何采纳/驳回导致暂存区变化都会使指纹改变
function stageFingerprint(stage) {
  return JSON.stringify(stage.map((p) => [p.id, p.seg, p.start_cp, p.end_cp, p.replacement]));
}

function stageClash(db, versionId, seg, start, end) {
  return db
    .prepare(
      `SELECT * FROM proposals
       WHERE status='adopted' AND base_version_id=? AND seg=? AND start_cp < ? AND ? < end_cp`
    )
    .get(versionId, seg, end, start);
}

// 续提预览：返回目标选区、摘录、原替换文字与依据，以及确认时须回传的凭证
function rebasePreview(db, actor, id) {
  const p = rebaseTarget(db, actor, id);
  const cur = latestVersion(db);
  const mapped = computeRebaseMapping(db, p, cur);
  const stage = stageProposals(db, cur.id);
  const clash = stageClash(db, cur.id, mapped.seg, mapped.start, mapped.end);
  return {
    proposalId: p.id,
    fromVersion: p.base_version_id,
    toVersion: cur.id,
    seg: mapped.seg,
    start: mapped.start,
    end: mapped.end,
    excerpt: mapped.excerpt,
    originalExcerpt: p.original_excerpt,
    replacement: p.replacement,
    basis: p.basis,
    steps: mapped.steps,
    stageOverlap: clash ? { id: clash.id, start: clash.start_cp, end: clash.end_cp } : null,
    token: {
      p: p.id,
      from: p.base_version_id,
      v: cur.id,
      seg: mapped.seg,
      s: mapped.start,
      e: mapped.end,
      stg: stageFingerprint(stage),
    },
  };
}

// 续提确认：全部校验在事务内完成，任一不满足即回滚、不改变任何状态
function confirmRebase(db, actor, id, body) {
  const p = rebaseTarget(db, actor, id);
  const token = body && body.token;
  if (!token || typeof token !== 'object') {
    throw badRequest('缺少预览凭证：续提前必须先发起预览，确认时需回传预览返回的 token');
  }
  if (token.p !== p.id || token.from !== p.base_version_id) {
    throw conflict('预览凭证与原提议不匹配，请重新预览', 'STALE_PREVIEW');
  }
  const tx = db.transaction(() => {
    const cur = latestVersion(db);
    if (token.v !== cur.id) {
      throw conflict(
        `预览后已发布新版本（当前 v${cur.id}），换算结果已失效，请重新预览或在当前正文手工选区提交`,
        'STALE_PREVIEW'
      );
    }
    const stage = stageProposals(db, cur.id);
    if (token.stg !== stageFingerprint(stage)) {
      throw conflict('预览后暂存区已变化，换算结果可能不再适用，请重新预览', 'STALE_STAGE');
    }
    const mapped = computeRebaseMapping(db, p, cur);
    if (mapped.seg !== token.seg || mapped.start !== token.s || mapped.end !== token.e) {
      throw conflict('换算结果与预览不一致，请重新预览', 'STALE_PREVIEW');
    }
    const clash = stageClash(db, cur.id, mapped.seg, mapped.start, mapped.end);
    if (clash) {
      throw conflict(
        `目标选区 [${mapped.start},${mapped.end}) 与当前已采纳提议 #${clash.id} 的范围 ` +
          `[${clash.start_cp},${clash.end_cp}) 交叠，不能续提；请在当前正文手工选区提交`,
        'STAGE_OVERLAP'
      );
    }
    const newId = insertProposal(db, actor, {
      seg: mapped.seg,
      start: mapped.start,
      end: mapped.end,
      replacement: p.replacement,
      basis: p.basis,
      excerpt: mapped.excerpt,
      baseVersionId: cur.id,
      rebasedFromId: p.id,
    });
    addDecision(db, {
      type: 'rebase',
      proposalId: newId,
      versionId: cur.id,
      actorId: actor.id,
      reason:
        `续提自冲突提议 #${p.id}（基版 v${p.base_version_id} → v${cur.id}，` +
        `原范围 [${p.start_cp},${p.end_cp}) 换算为 [${mapped.start},${mapped.end})）`,
      detail: {
        fromProposalId: p.id,
        fromVersion: p.base_version_id,
        toVersion: cur.id,
        seg: mapped.seg,
        start: mapped.start,
        end: mapped.end,
      },
    });
    return newId;
  });
  return tx();
}

// ---------- 异议 ----------
function createObjection(db, actor, body) {
  const doc = getDoc(db);
  if (!doc) throw conflict('尚未导入逐字稿，无法添加异议', 'NO_DOCUMENT');
  const ver = latestVersion(db);
  const segments = segmentsOf(ver);

  const seg = parseInt(body.seg, 10);
  const start = parseInt(body.start, 10);
  const end = parseInt(body.end, 10);
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!Number.isInteger(seg)) throw badRequest('缺少有效的段号 seg');
  if (!note) throw badRequest('异议说明不能为空');
  const idx = segIndex(segments, seg);
  if (idx === -1) throw badRequest(`非法范围：当前版本 v${ver.id} 中不存在段 ${seg}`);
  const vr = validateRange(segments[idx].text, start, end);
  if (vr.start === vr.end) throw badRequest('异议必须引用非空的原文范围');

  return db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO objections (seg, start_cp, end_cp, quoted_text, note, status, created_by, created_in_version)
       VALUES (?,?,?,?,?,'active',?,?)`
    ).run(seg, start, end, vr.excerpt, note, actor.id, ver.id);
    const id = r.lastInsertRowid;
    db.prepare(
      `INSERT INTO objection_anchors (objection_id, version_id, seg, start_cp, end_cp, status)
       VALUES (?,?,?,?,?,'active')`
    ).run(id, ver.id, seg, start, end);
    db.prepare(
      `INSERT INTO objection_logs (objection_id, actor_id, action, detail_json) VALUES (?,?, 'create', '{}')`
    ).run(id, actor.id);
    return id;
  })();
}

function relocateObjection(db, actor, id, body) {
  const o = db.prepare('SELECT * FROM objections WHERE id=?').get(id);
  if (!o) throw notFound(`异议 #${id} 不存在`);
  if (actor.role !== 'reviewer' && o.created_by !== actor.id) {
    const err = new Error('无权操作：只有异议提出者或复核员可以重新定位该异议');
    err.status = 403; err.code = 'FORBIDDEN'; throw err;
  }
  if (o.status !== 'needs_relocation') {
    throw conflict(`异议 #${id} 当前仍有效，无需重新定位`, 'NOT_DANGLING');
  }
  const ver = latestVersion(db);
  const segments = segmentsOf(ver);
  const seg = parseInt(body.seg, 10);
  const start = parseInt(body.start, 10);
  const end = parseInt(body.end, 10);
  if (!Number.isInteger(seg)) throw badRequest('缺少有效的段号 seg');
  const idx = segIndex(segments, seg);
  if (idx === -1) throw badRequest(`非法范围：当前版本 v${ver.id} 中不存在段 ${seg}`);
  const vr = validateRange(segments[idx].text, start, end);
  if (vr.start === vr.end) throw badRequest('重新定位必须选择非空范围');

  db.transaction(() => {
    db.prepare(
      `UPDATE objections SET seg=?, start_cp=?, end_cp=?, status='active' WHERE id=?`
    ).run(seg, start, end, id);
    db.prepare(
      `INSERT INTO objection_anchors (objection_id, version_id, seg, start_cp, end_cp, status)
       VALUES (?,?,?,?,?,'active')
       ON CONFLICT(objection_id, version_id) DO UPDATE SET
         seg=excluded.seg, start_cp=excluded.start_cp, end_cp=excluded.end_cp, status='active'`
    ).run(id, ver.id, seg, start, end);
    db.prepare(
      `INSERT INTO objection_logs (objection_id, actor_id, action, detail_json)
       VALUES (?,?, 'relocate', ?)`
    ).run(id, actor.id, JSON.stringify({ seg, start, end, version: ver.id, newExcerpt: vr.excerpt }));
  })();
}

// ---------- 异议回应（复核员，发布前填写） ----------
// 仅允许对“当前版本暂存修订实际触及”的异议回应；回应自动关联当前触及它的采纳提议、
// 当前版本与暂存指纹，并记录异议当前锚点，供发布时重新核对。
function respondToObjection(db, actor, id, body) {
  const o = db.prepare('SELECT * FROM objections WHERE id=?').get(id);
  if (!o) throw notFound(`异议 #${id} 不存在`);
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!note) throw badRequest('回应说明不能为空：发布前须对被触及异议逐条填写非空说明');

  const cur = latestVersion(db);
  const stage = stageProposals(db, cur.id);
  const touched = touchedByStage(db, cur.id, stage).get(id);
  if (!touched) {
    throw conflict(
      `异议 #${id} 当前未被暂存区中的采纳修订触及，无需在本次发布前回应；` +
        '采纳相关修订进入暂存区后才能填写回应',
      'NOT_TOUCHED'
    );
  }
  const fp = stageFingerprint(stage);
  const existing = db
    .prepare(`SELECT * FROM objection_responses WHERE objection_id=? AND status='draft'`)
    .get(id);

  return db.transaction(() => {
    let responseId;
    if (existing) {
      db.prepare(
        `UPDATE objection_responses
         SET note=?, touched_proposal_ids_json=?, stage_fingerprint=?,
             anchor_seg=?, anchor_start_cp=?, anchor_end_cp=?, responded_by=?, updated_at=datetime('now')
         WHERE id=?`
      ).run(
        note, JSON.stringify(touched.proposals), fp,
        touched.anchor.seg, touched.anchor.start, touched.anchor.end, actor.id, existing.id
      );
      responseId = existing.id;
      db.prepare(
        `INSERT INTO objection_logs (objection_id, actor_id, action, detail_json) VALUES (?,?, 'respond', ?)`
      ).run(id, actor.id, JSON.stringify({
        responseId, version: cur.id, updated: true,
        touchedProposalIds: touched.proposals, anchor: touched.anchor,
      }));
    } else {
      const r = db.prepare(
        `INSERT INTO objection_responses
          (objection_id, version_id, note, status, touched_proposal_ids_json, stage_fingerprint,
           anchor_seg, anchor_start_cp, anchor_end_cp, responded_by)
         VALUES (?,?,?, 'draft', ?,?,?,?,?,?)`
      ).run(
        id, cur.id, note, JSON.stringify(touched.proposals), fp,
        touched.anchor.seg, touched.anchor.start, touched.anchor.end, actor.id
      );
      responseId = r.lastInsertRowid;
      db.prepare(
        `INSERT INTO objection_logs (objection_id, actor_id, action, detail_json) VALUES (?,?, 'respond', ?)`
      ).run(id, actor.id, JSON.stringify({
        responseId, version: cur.id, updated: false,
        touchedProposalIds: touched.proposals, anchor: touched.anchor,
      }));
    }
    return responseId;
  })();
}

function withdrawObjectionResponse(db, actor, id) {
  const o = db.prepare('SELECT * FROM objections WHERE id=?').get(id);
  if (!o) throw notFound(`异议 #${id} 不存在`);
  const r = db
    .prepare(`SELECT * FROM objection_responses WHERE objection_id=? AND status='draft'`)
    .get(id);
  if (!r) throw conflict(`异议 #${id} 没有可撤回的回应草稿（已发布的回应不可更改）`, 'NO_DRAFT_RESPONSE');
  db.transaction(() => {
    db.prepare(`DELETE FROM objection_responses WHERE id=?`).run(r.id);
    db.prepare(
      `INSERT INTO objection_logs (objection_id, actor_id, action, detail_json) VALUES (?,?, 'withdraw', ?)`
    ).run(id, actor.id, JSON.stringify({ responseId: r.id, version: r.version_id, note: r.note }));
  })();
}

// ---------- 预约发布（复核员：未来时刻自动发布当前暂存修订） ----------
// 预约时按现有规则确认可发布，并固化快照：基版、采纳提议集合与内容、受影响异议及其有效回应。
// 到期在同一事务中重新核对：快照与现状一致才生成不可变新版本；任一关联已变化则仅标记预约失效，
// 不改动版本、提议与决议，须重新预约。

// 解析“含 UTC 偏移”的时间：支持 ISO 8601（如 2026-10-01T09:30:00+08:00 / ...Z）
// 与数字 epoch 毫秒；无偏移、日期/时间非法均拒绝。返回 {ms, input, iso(UTC)}。
function parseScheduleTime(input) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    if (!Number.isInteger(input)) throw badRequest('预约时间无效：epoch 毫秒必须为整数', 'INVALID_SCHEDULE_TIME');
    return { ms: input, input: String(input), iso: new Date(input).toISOString() };
  }
  if (typeof input !== 'string') {
    throw badRequest('预约时间无效：须提供带 UTC 偏移的 ISO 8601 字符串（如 2026-10-01T09:30:00+08:00）或 epoch 毫秒数', 'INVALID_SCHEDULE_TIME');
  }
  const s = input.trim();
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/
  );
  if (!m) {
    throw badRequest('预约时间无效：须为带 UTC 偏移的 ISO 8601 时间（如 2026-10-01T09:30:00+08:00 或 2026-10-01T01:30:00Z）', 'INVALID_SCHEDULE_TIME');
  }
  const year = +m[1], mon = +m[2], day = +m[3];
  const hour = +m[4], min = +m[5], sec = m[6] === undefined ? 0 : +m[6];
  const fracStr = m[7] || '';
  const ms = fracStr ? Math.floor(+`0.${fracStr}` * 1000) : 0;
  const tz = m[8];
  const offsetMin = tz === 'Z'
    ? 0
    : (() => {
        const sign = tz[0] === '-' ? -1 : 1;
        const tzm = tz.slice(1).replace(':', '');
        const oh = +tzm.slice(0, 2), om = +tzm.slice(2, 4);
        if (oh > 23 || om > 59) throw badRequest('预约时间无效：UTC 偏移超出范围', 'INVALID_SCHEDULE_TIME');
        return sign * (oh * 60 + om);
      })();
  if (mon < 1 || mon > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) {
    throw badRequest('预约时间无效：日期或时间分量超出范围', 'INVALID_SCHEDULE_TIME');
  }
  const asUTC = Date.UTC(year, mon - 1, day, hour, min, sec, ms) - offsetMin * 60000;
  const d = new Date(asUTC);
  // 往返校验：捕获 2 月 30 日等 JS 自动进位的非法日期（与偏移无关，只校验本地分量能否落回同一日历日）
  const localParts = new Date(Date.UTC(year, mon - 1, day, hour, min, sec, ms));
  if (localParts.getUTCFullYear() !== year || localParts.getUTCMonth() !== mon - 1 ||
      localParts.getUTCDate() !== day || localParts.getUTCHours() !== hour ||
      localParts.getUTCMinutes() !== min || localParts.getUTCSeconds() !== sec) {
    throw badRequest('预约时间无效：日期不存在（如 2 月 30 日）', 'INVALID_SCHEDULE_TIME');
  }
  const canonical = `${s.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')}`;
  return { ms: asUTC, input: canonical, iso: d.toISOString() };
}

// 暂存区内容快照：预约记录“采纳提议集合 + 内容”，到期逐项比对
function stageSnapshot(stage) {
  return stage.map((p) => ({
    id: p.id, seg: p.seg, start: p.start_cp, end: p.end_cp, replacement: p.replacement,
  }));
}

function snapshotStageMismatch(snapIds, snapItems, stage) {
  const curIds = stage.map((p) => p.id).sort((a, b) => a - b);
  const wantIds = [...snapIds].sort((a, b) => a - b);
  if (curIds.join(',') !== wantIds.join(',')) {
    return `采纳提议集合已变化：预约时为 #${wantIds.join(',#') || '（无）'}，当前为 #${curIds.join(',#') || '（无）'}`;
  }
  const byId = new Map(stage.map((p) => [p.id, p]));
  for (const it of snapItems) {
    const p = byId.get(it.id);
    if (!p) return `采纳提议 #${it.id} 已不在暂存区`;
    if (p.seg !== it.seg || p.start_cp !== it.start || p.end_cp !== it.end || p.replacement !== it.replacement) {
      return `采纳提议 #${it.id} 的内容已变化（预约时为第 ${it.seg} 段 [${it.start},${it.end})「${it.replacement}」）`;
    }
  }
  return '';
}

// 受影响异议及有效回应关联快照的重核对：返回失效原因数组（空数组表示一致且可发布）
function snapshotObjectionsMismatch(touched, touchedSnap, drafts) {
  const reasons = [];
  const wantIds = [...touched.keys()].sort((a, b) => a - b);
  const snapIds = touchedSnap.map((t) => t.objectionId).sort((a, b) => a - b);
  if (wantIds.join(',') !== snapIds.join(',')) {
    reasons.push(
      `受影响异议集合已变化：预约时为 #${snapIds.join(',#') || '（无）'}，当前为 #${wantIds.join(',#') || '（无）'}`
    );
  }
  for (const snap of touchedSnap) {
    const info = touched.get(snap.objectionId);
    if (!info) {
      reasons.push(`异议 #${snap.objectionId} 当前不再被暂存修订触及`);
      continue;
    }
    const curProps = [...info.proposals].sort((a, b) => a - b);
    const snapProps = [...snap.proposalIds].sort((a, b) => a - b);
    if (curProps.join(',') !== snapProps.join(',')) {
      reasons.push(
        `异议 #${snap.objectionId} 的关联采纳提议集合已变化：预约时为 #${snapProps.join(',#') || '（无）'}，当前为 #${curProps.join(',#')}`
      );
    }
    if (info.anchor.seg !== snap.anchor.seg || info.anchor.start !== snap.anchor.start || info.anchor.end !== snap.anchor.end) {
      reasons.push(
        `异议 #${snap.objectionId} 的当前锚点已变化：预约时为第 ${snap.anchor.seg} 段 [${snap.anchor.start},${snap.anchor.end})，当前为第 ${info.anchor.seg} 段 [${info.anchor.start},${info.anchor.end})`
      );
    }
    const r = drafts.get(snap.objectionId);
    if (!r) {
      reasons.push(`异议 #${snap.objectionId} 的发布前回应已不存在（草稿可能已撤回）`);
    } else if (r.id !== snap.responseId || r.note !== snap.responseNote) {
      reasons.push(`异议 #${snap.objectionId} 的有效回应关联已变化（回应已被修改或替换）`);
    }
  }
  return reasons;
}

// 创建预约：与人工发布相同的可发布确认（暂存区非空 + 异议回应闸门），通过后写入快照
function createSchedule(db, actor, body) {
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!note) throw badRequest('版本说明不能为空：预约发布须填写本次版本说明');

  const parsed = parseScheduleTime(body.scheduledAt);
  if (!(parsed.ms > Date.now())) {
    throw badRequest('预约时间必须是严格晚于当前时刻的未来时间', 'TIME_NOT_FUTURE');
  }

  const cur = latestVersion(db);
  if (!cur) throw conflict('尚未导入逐字稿，无法预约发布', 'NO_DOCUMENT');
  const stage = stageProposals(db, cur.id);
  if (stage.length === 0) {
    throw conflict('预约被拒绝：暂存区中没有已采纳修订，发布必须包含修订并形成新版本', 'EMPTY_PUBLISH');
  }

  const tx = db.transaction(() => {
    // 唯一待执行预约约束在事务内确认（避免并发创建出两条 pending）
    const existing = db.prepare(`SELECT id FROM publish_schedules WHERE status='pending'`).get();
    if (existing) {
      throw conflict(
        `已存在待执行预约 #${existing.id}，同一时刻仅允许一个待执行预约；请先取消后再重新预约`,
        'SCHEDULE_EXISTS'
      );
    }
    // 预约时即按现有规则确认可发布：缺失/失效回应 → 409，不写入任何预约
    const touched = assertObjectionsResolved(db, cur, stage);
    const drafts = new Map(listDraftResponses(db, cur.id).map((r) => [r.objection_id, r]));
    const touchedSnap = [...touched.entries()].map(([objectionId, info]) => {
      const r = drafts.get(objectionId);
      return {
        objectionId,
        anchor: info.anchor,
        proposalIds: info.proposals,
        responseId: r ? r.id : null,
        responseNote: r ? r.note : '',
      };
    });

    const r = db.prepare(
      `INSERT INTO publish_schedules
        (scheduled_at_ms, scheduled_at_input, note, base_version_id, stage_fingerprint,
         stage_snapshot_json, touched_snapshot_json, created_by, status)
       VALUES (?,?,?,?,?,?,?,?,'pending')`
    ).run(
      parsed.ms, parsed.input, note, cur.id, stageFingerprint(stage),
      JSON.stringify({ proposalIds: stage.map((p) => p.id), items: stageSnapshot(stage) }),
      JSON.stringify(touchedSnap), actor.id
    );
    return r.lastInsertRowid;
  });
  return { id: tx.immediate(), scheduledAtMs: parsed.ms };
}

function cancelSchedule(db, actor, id) {
  const sId = id == null
    ? (db.prepare(`SELECT id FROM publish_schedules WHERE status='pending' ORDER BY id LIMIT 1`).get() || {}).id
    : id;
  if (sId == null) throw notFound('没有待执行的预约可取消');
  const s = db.prepare('SELECT * FROM publish_schedules WHERE id=?').get(sId);
  if (!s) throw notFound(`预约 #${sId} 不存在`);
  if (s.status !== 'pending') {
    throw conflict(`预约 #${s.id} 当前状态为“${scheduleStatusLabel(s.status)}”，只能取消待执行预约`, 'SCHEDULE_NOT_PENDING');
  }
  db.transaction(() => {
    const r = db.prepare(
      `UPDATE publish_schedules SET status='cancelled', cancelled_at_ms=?, cancelled_by=?
       WHERE id=? AND status='pending'`
    ).run(Date.now(), actor.id, s.id);
    if (r.changes === 0) throw conflict(`预约 #${s.id} 已被处理，无法取消`, 'SCHEDULE_NOT_PENDING');
  }).immediate();
  return s.id;
}

function scheduleStatusLabel(status) {
  return { pending: '待执行', published: '已发布', invalid: '已失效', cancelled: '已取消' }[status] || status;
}

function scheduleView(db, s) {
  let notPublishedReason = null;
  if (s.status === 'pending') {
    notPublishedReason = s.scheduled_at_ms > Date.now()
      ? `等待到达预约时间（${s.scheduled_at_iso}）`
      : '已到预约时间，等待服务处理';
  } else if (s.status === 'invalid') {
    notPublishedReason = (() => {
      try { return JSON.parse(s.invalid_details_json || '[]').join('；') || s.invalid_reason; }
      catch (_) { return s.invalid_reason; }
    })();
  } else if (s.status === 'cancelled') {
    notPublishedReason = '预约已在执行前取消';
  }
  return {
    id: s.id,
    status: s.status,
    statusLabel: scheduleStatusLabel(s.status),
    scheduledAtMs: s.scheduled_at_ms,
    scheduledAtUtc: new Date(s.scheduled_at_ms).toISOString(),
    scheduledAtInput: s.scheduled_at_input,
    note: s.note,
    baseVersionId: s.base_version_id,
    publishedVersionId: s.published_version_id,
    stageProposalIds: JSON.parse(s.stage_snapshot_json || '{}').proposalIds || [],
    createdBy: s.creator_name,
    createdByUser: s.creator_user,
    createdAt: s.created_at,
    firedAtMs: s.fired_at_ms,
    firedAt: s.fired_at_ms ? new Date(s.fired_at_ms).toISOString() : null,
    cancelledAtMs: s.cancelled_at_ms,
    invalidReason: s.status === 'invalid' ? s.invalid_reason : '',
    notPublishedReason,
  };
}

function listSchedules(db, { limit = 20 } = {}) {
  const rows = db
    .prepare(
      `SELECT s.*, u.display_name AS creator_name, u.username AS creator_user
       FROM publish_schedules s LEFT JOIN users u ON u.id = s.created_by
       ORDER BY s.id DESC LIMIT ?`
    )
    .all(limit);
  return rows.map((r) => scheduleView(db, r));
}

function pendingSchedule(db) {
  const s = db
    .prepare(
      `SELECT s.*, u.display_name AS creator_name, u.username AS creator_user
       FROM publish_schedules s LEFT JOIN users u ON u.id = s.created_by
       WHERE s.status='pending' ORDER BY s.id LIMIT 1`
    )
    .get();
  return s ? scheduleView(db, s) : null;
}

// 标记预约失效：仅改预约自身，不触碰版本、提议、决议与回应
function markScheduleInvalid(db, s, reasons, nowMs) {
  const list = (reasons || []).filter(Boolean);
  const reason = list[0] || '预约快照与当前发布条件不一致';
  db.prepare(
    `UPDATE publish_schedules
     SET status='invalid', invalid_reason=?, invalid_details_json=?, fired_at_ms=?
     WHERE id=? AND status='pending'`
  ).run(reason, JSON.stringify(list), nowMs, s.id);
}

// 到期处理：在同一事务中重新核对预约快照与当前发布条件。
// 一致 → 生成一个不可变新版本并固化回应；不一致 → 仅标记预约失效。
// 供调度器（重启后立即核查逾期项）调用；与人工发布并发或重复触发时至多生成一个新版本。
function runDueSchedules(db, nowMs = Date.now()) {
  const results = [];
  const due = db
    .prepare(`SELECT * FROM publish_schedules WHERE status='pending' AND scheduled_at_ms <= ? ORDER BY id`)
    .all(nowMs);
  for (const s of due) {
    const run = db.transaction((sched) => {
      const cur0 = db.prepare('SELECT * FROM publish_schedules WHERE id=?').get(sched.id);
      if (!cur0 || cur0.status !== 'pending') return { id: sched.id, status: cur0 ? cur0.status : 'missing' };

      const actor = db.prepare('SELECT * FROM users WHERE id=?').get(cur0.created_by);
      const cur = latestVersion(db);
      const reasons = [];

      if (!actor) reasons.push(`预约创建人（用户 #${cur0.created_by}）已不存在，无法代为发布`);
      if (!cur) {
        reasons.push('逐字稿尚未导入，无可发布内容');
      } else if (cur.id !== cur0.base_version_id) {
        reasons.push(`当前版本已变化：预约基于 v${cur0.base_version_id}，当前已为 v${cur.id}（可能已人工发布）`);
      }

      let stage = [];
      let touched = new Map();
      if (cur && cur.id === cur0.base_version_id) {
        stage = stageProposals(db, cur.id);
        let snap;
        try { snap = JSON.parse(cur0.stage_snapshot_json || '{}'); }
        catch (_) { snap = {}; }
        const mm = snapshotStageMismatch(snap.proposalIds || [], snap.items || [], stage);
        if (mm) reasons.push(mm);
        if (stage.length === 0) reasons.push('暂存区已为空（采纳提议可能已被驳回）');

        let touchedSnap = [];
        try { touchedSnap = JSON.parse(cur0.touched_snapshot_json || '[]'); }
        catch (_) { touchedSnap = []; }
        touched = touchedByStage(db, cur.id, stage);
        const drafts = new Map(listDraftResponses(db, cur.id).map((r) => [r.objection_id, r]));
        for (const r of snapshotObjectionsMismatch(touched, touchedSnap, drafts)) reasons.push(r);

        // 现有发布条件再确认：即便快照恰好一致，也按当下状态完整走一遍闸门
        if (stage.length > 0) {
          try {
            touched = assertObjectionsResolved(db, cur, stage);
          } catch (e) {
            reasons.push(`当前发布条件不再满足：${e.message}`);
          }
        }
      }

      if (reasons.length) {
        markScheduleInvalid(db, cur0, reasons, nowMs);
        return { id: cur0.id, status: 'invalid', reasons };
      }

      const newId = commitPublish(db, actor, cur0.note, { cur, stage, segments: segmentsOf(cur), touched });
      const r = db.prepare(
        `UPDATE publish_schedules SET status='published', published_version_id=?, fired_at_ms=?
         WHERE id=? AND status='pending'`
      ).run(newId, nowMs, cur0.id);
      if (r.changes === 0) {
        // 极端竞态下被取消/并发处理：抛出使整个事务回滚，绝不重复落版
        throw conflict(`预约 #${cur0.id} 状态已变化，本次执行回滚`, 'SCHEDULE_RACE');
      }
      return { id: cur0.id, status: 'published', versionId: newId };
    });
    results.push(run.immediate(s));
  }
  return results;
}

// ---------- 视图组装 ----------
function listProposals(db) {
  return db
    .prepare(
      `SELECT p.*, u.display_name AS creator_name, u.username AS creator_user,
              b.id AS base_ver,
              (SELECT MIN(r.id) FROM proposals r WHERE r.rebased_from_id = p.id) AS continued_by_id
       FROM proposals p
       JOIN users u ON u.id = p.created_by
       JOIN versions b ON b.id = p.base_version_id
       ORDER BY p.id DESC`
    )
    .all();
}

function listObjections(db) {
  const ver = latestVersion(db);
  if (!ver) return [];
  return db
    .prepare(
      `SELECT o.id, o.seg, o.start_cp, o.end_cp, o.quoted_text, o.note, o.status,
              o.created_in_version, o.created_at,
              u.display_name AS creator_name, u.username AS creator_user,
              a.status AS anchor_status,
              dr.id AS response_id, dr.note AS response_note,
              dr.touched_proposal_ids_json AS response_proposal_ids_json,
              dr.updated_at AS response_updated_at,
              ru.display_name AS responder_name, ru.username AS responder_user
       FROM objections o
       JOIN users u ON u.id = o.created_by
       JOIN objection_anchors a ON a.objection_id = o.id AND a.version_id = ?
       LEFT JOIN objection_responses dr ON dr.objection_id = o.id AND dr.status = 'draft' AND dr.version_id = ?
       LEFT JOIN users ru ON ru.id = dr.responded_by
       ORDER BY o.id DESC`
    )
    .all(ver.id, ver.id);
}

function boothView(db) {
  const doc = getDoc(db);
  if (!doc) return { initialized: false };
  const ver = latestVersion(db);
  const segments = segmentsOf(ver);
  const stage = stageProposals(db, ver.id);
  return {
    initialized: true,
    title: doc.title,
    currentVersion: { id: ver.id, note: ver.note, createdAt: ver.created_at },
    segments,
    stage: stage.map((p) => ({ id: p.id, seg: p.seg, start: p.start_cp, end: p.end_cp, replacement: p.replacement })),
    previewSegments: previewSegments(segments, stage),
    proposals: listProposals(db),
    objections: listObjections(db),
    reviewChecklist: reviewChecklist(db, ver.id),
    schedule: pendingSchedule(db),
    recentSchedules: listSchedules(db, { limit: 5 }),
    versions: db
      .prepare(
        `SELECT v.id, v.note, v.created_at, u.display_name AS creator_name
         FROM versions v LEFT JOIN users u ON u.id = v.created_by ORDER BY v.id`
      )
      .all(),
  };
}

function versionView(db, id) {
  const v = db.prepare('SELECT * FROM versions WHERE id=?').get(id);
  if (!v) throw notFound(`版本 v${id} 不存在`);
  const decisions = db
    .prepare(
      `SELECT d.id, d.type, d.reason, d.created_at, d.proposal_id, d.version_id,
              u.display_name AS actor_name,
              p.seg, p.start_cp, p.end_cp, p.replacement, p.basis, p.original_excerpt,
              pu.display_name AS proposal_creator
       FROM decisions d
       LEFT JOIN users u ON u.id = d.actor_id
       LEFT JOIN proposals p ON p.id = d.proposal_id
       LEFT JOIN users pu ON pu.id = p.created_by
       WHERE d.id <= ?
       ORDER BY d.id`
    )
    .all(v.decision_watermark);
  const objections = db
    .prepare(
      `SELECT a.objection_id AS id, a.seg, a.start_cp, a.end_cp, a.status,
              o.quoted_text, o.note, o.created_in_version, o.created_at,
              u.display_name AS creator_name
       FROM objection_anchors a
       JOIN objections o ON o.id = a.objection_id
       JOIN users u ON u.id = o.created_by
       WHERE a.version_id = ?
       ORDER BY a.objection_id`
    )
    .all(v.id);
  // 随该版本发布固化的异议回应：只读快照，保留异议原文快照与既有重定位展示规则
  const responses = db
    .prepare(
      `SELECT r.id, r.objection_id AS objectionId, r.note,
              r.touched_proposal_ids_json, r.anchor_seg, r.anchor_start_cp, r.anchor_end_cp,
              r.created_at, r.updated_at,
              u.display_name AS responder_name, u.username AS responder_user
       FROM objection_responses r
       JOIN users u ON u.id = r.responded_by
       WHERE r.published_version_id = ?
       ORDER BY r.id`
    )
    .all(v.id)
    .map((r) => ({
      id: r.id,
      objectionId: r.objectionId,
      note: r.note,
      touchedProposalIds: JSON.parse(r.touched_proposal_ids_json || '[]'),
      anchorSeg: r.anchor_seg,
      anchorStart: r.anchor_start_cp,
      anchorEnd: r.anchor_end_cp,
      responderName: r.responder_name,
      responderUser: r.responder_user,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  return {
    id: v.id,
    note: v.note,
    createdAt: v.created_at,
    immutable: true,
    segments: segmentsOf(v),
    decisions,
    objections,
    responses,
  };
}

module.exports = {
  parseTranscript,
  importTranscript,
  createProposal,
  adoptProposal,
  rejectProposal,
  publish,
  createSchedule,
  cancelSchedule,
  runDueSchedules,
  parseScheduleTime,
  pendingSchedule,
  listSchedules,
  createObjection,
  relocateObjection,
  respondToObjection,
  withdrawObjectionResponse,
  reviewChecklist,
  rebasePreview,
  confirmRebase,
  boothView,
  versionView,
  stageProposals,
  previewSegments,
  getDoc,
  latestVersion,
  segmentsOf,
};
