/**
 * Teaching Log → Google Sheet + สรุปเนื้อหาการสอนเข้า LINE ทุกเช้า 07:00
 *
 * ผูกสคริปต์นี้กับ Google Sheet (Extensions → Apps Script) แล้ววางโค้ดนี้ทั้งไฟล์
 * ขั้นตอนตั้งค่าเต็มดูที่ gas/README.md
 *
 * Script properties ที่ต้องตั้ง (Project Settings → Script properties):
 *   LINE_TOKEN     Channel access token (long-lived) ของ LINE Official Account
 *   LINE_USER_ID   User ID ของผู้รับ (ครูนนท์) — ดูที่ LINE Developers → Basic settings → Your user ID
 *   SECRET         (ไม่บังคับ) รหัสลับ ต้องตรงกับช่อง “รหัสลับ” ในหน้าตั้งค่าของ Teaching Log
 *   SEND_EMPTY     (ไม่บังคับ) ตั้งเป็น true ถ้าอยากให้ส่งข้อความ “วันนี้ไม่มีสอน” ด้วย
 *
 * ชีตที่สร้างให้อัตโนมัติ:  Subjects (ตารางสอนภาคเรียนปัจจุบัน) · Notes (บันทึกช่วยจำทุกภาคเรียน) · Log
 */

const TZ = 'Asia/Bangkok';
const DAY_CODES = ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'];           // 1=จันทร์ … 7=อาทิตย์ (รูปแบบ 'u' ของ Utilities.formatDate)
const DAY_FULL = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'];
const MONTHS_TH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const SHEETS = {
  Subjects: ['id', 'semester', 'code', 'name', 'room', 'days', 'period', 'credits', 'color'],
  Notes: ['id', 'semester', 'subjectId', 'subjectCode', 'subjectName', 'room', 'date', 'text', 'updatedAt'],
  Log: ['time', 'event', 'detail']
};
const NOTE_MAX_CHARS = 380;       // ตัดข้อความยาวในการ์ดไลน์
const BUBBLES_PER_CAROUSEL = 12;  // ข้อจำกัดของ LINE

/* ═════════════ Web App (Teaching Log เรียกเข้ามา) ═════════════ */

function doGet() {
  return json_({ ok: true, msg: 'teachinglog gas ready' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const secret = prop_('SECRET');
    if (secret && b.key !== secret) return json_({ ok: false, error: 'unauthorized' });
    switch (b.action) {
      case 'ping':
        log_('ping', 'เชื่อมต่อจาก Teaching Log');
        return json_({ ok: true, pong: true });
      case 'upsertSubjects':
        upsertSubjects_(b.subjects || [], !!b.replace);
        return json_({ ok: true, count: (b.subjects || []).length });
      case 'resetTerm':
        clearData_('Subjects');
        log_('resetTerm', 'ล้างตารางสอน ภาคเรียนใหม่ ' + (b.semester || ''));
        return json_({ ok: true });
      case 'upsertNote':
        upsertRows_('Notes', [b.note]);
        return json_({ ok: true });
      case 'upsertNotes':
        upsertRows_('Notes', b.notes || []);
        return json_({ ok: true, count: (b.notes || []).length });
      case 'deleteNote':
        deleteRow_('Notes', b.id);
        return json_({ ok: true });
      default:
        return json_({ ok: false, error: 'unknown action: ' + b.action });
    }
  } catch (err) {
    log_('error', String(err));
    return json_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* ignore */ }
  }
}

/* ═════════════ สรุปเข้า LINE ทุกเช้า ═════════════ */

/** ทริกเกอร์รายวัน 07:00 เรียกฟังก์ชันนี้ */
function sendDailyBrief() {
  const now = nowInfo_();
  const subjects = readRows_('Subjects');
  const notes = readRows_('Notes');
  const today = pickToday_(subjects, now.dayCode);
  if (!today.length) {
    if (prop_('SEND_EMPTY') === 'true') pushLine_([{ type: 'text', text: '☀️ ' + thaiDateLong_(now.iso) + '\nวันนี้ไม่มีคาบสอนตามตารางครับ' }]);
    log_('brief', 'ไม่มีวิชาสอนวัน' + now.dayFull);
    return;
  }
  const messages = buildMessages_(today, notes, now);
  // ส่งเป็นชุดละไม่เกิน 5 ข้อความต่อครั้ง (ปกติวิชาต่อวันไม่เกิน 12 → 1 ข้อความ)
  for (let i = 0; i < messages.length; i += 5) pushLine_(messages.slice(i, i + 5));
  log_('brief', 'ส่งสรุป ' + today.length + ' วิชา ของวัน' + now.dayFull);
}

/** ทดสอบทันที: sendBriefForDay('พ') จะจำลองว่าวันนี้เป็นวันพุธ (ไม่ระบุ = ใช้วันจริง) */
function sendBriefForDay(dayCode) {
  const now = nowInfo_();
  if (dayCode) { now.dayCode = dayCode; now.dayFull = DAY_FULL[DAY_CODES.indexOf(dayCode)] || dayCode; }
  const today = pickToday_(readRows_('Subjects'), now.dayCode);
  if (!today.length) { Logger.log('ไม่มีวิชาสอนวัน' + now.dayFull); return; }
  const messages = buildMessages_(today, readRows_('Notes'), now);
  for (let i = 0; i < messages.length; i += 5) pushLine_(messages.slice(i, i + 5));
  Logger.log('ส่งแล้ว ' + today.length + ' วิชา');
}

function testPush() {
  pushLine_([{ type: 'text', text: '✅ ทดสอบ: Teaching Log เชื่อมต่อ LINE สำเร็จ' }]);
}

/** วิชาที่สอนวันนี้ เรียงตามคาบ/เวลา */
function pickToday_(subjects, dayCode) {
  const list = subjects.filter(function (s) { return String(s.days || '').split(/[,\s]+/).indexOf(dayCode) >= 0; });
  list.forEach(function (s, i) { s._o = i; });
  list.sort(function (a, b) { return (periodOrder_(a.period, dayCode) - periodOrder_(b.period, dayCode)) || (a._o - b._o); });
  return list;
}

/** ดึงเลขคาบแรกของวันนั้น เช่น "จ คาบ 2 / พ คาบ 5" วันพุธ → 5 ; "09:30-10:20" → 930 */
function periodOrder_(period, dayCode) {
  const p = String(period || '');
  const seg = p.split('/').map(function (x) { return x.trim(); }).filter(String);
  const mine = seg.filter(function (x) { return startsWithDay_(x, dayCode); })[0];
  const t = mine || seg[0] || p;
  const tm = t.match(/(\d{1,2})[:.](\d{2})/);
  if (tm) return Number(tm[1]) * 100 + Number(tm[2]);
  const n = t.match(/(\d+)/);
  return n ? Number(n[1]) : 9999;
}

/** ขึ้นต้นด้วยรหัสวันนั้นจริง ๆ (กัน "พ" ไปจับ "พฤ" และ "อ" ไปจับ "อา") */
function startsWithDay_(x, code) {
  if (x.indexOf(code) !== 0) return false;
  const nx = x.charAt(code.length);
  return !((code === 'พ' && nx === 'ฤ') || (code === 'อ' && nx === 'า'));
}

/** บันทึกล่าสุดของวิชา (ตามวันที่ แล้วตามเวลาที่แก้) — จับคู่ด้วย id หรือ รหัสวิชา+ห้อง+ภาคเรียน */
function latestNote_(notes, s) {
  let best = null;
  notes.forEach(function (n) {
    const same = n.subjectId === s.id || (n.subjectCode === s.code && n.room === s.room && String(n.semester) === String(s.semester));
    if (!same || !String(n.text || '').trim()) return;
    if (!best || String(n.date) > String(best.date) || (String(n.date) === String(best.date) && Number(n.updatedAt || 0) > Number(best.updatedAt || 0))) best = n;
  });
  return best;
}

function buildMessages_(subjects, notes, now) {
  const bubbles = subjects.map(function (s) { return bubble_(s, latestNote_(notes, s), now); });
  const alt = '📚 สรุปก่อนสอน ' + now.dayFull + ' · ' + subjects.length + ' วิชา: ' +
    subjects.map(function (s) { return s.name + ' ' + s.room; }).join(', ');
  const out = [];
  for (let i = 0; i < bubbles.length; i += BUBBLES_PER_CAROUSEL) {
    out.push({
      type: 'flex',
      altText: alt.length > 390 ? alt.slice(0, 387) + '…' : alt,
      contents: { type: 'carousel', contents: bubbles.slice(i, i + BUBBLES_PER_CAROUSEL) }
    });
  }
  return out;
}

function bubble_(s, note, now) {
  const color = /^#[0-9a-fA-F]{6}$/.test(String(s.color || '')) ? s.color : '#1f3a5f';
  const meta = ['ห้อง ' + s.room].concat(s.period ? [s.period] : []).concat(s.credits !== '' && s.credits != null ? [s.credits + ' นก.'] : []).join(' · ');
  const body = [];
  if (note) {
    const ago = daysBetween_(note.date, now.iso);
    body.push({
      type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: '📝 สอนครั้งล่าสุด', size: 'sm', weight: 'bold', color: '#1f3a5f', flex: 0 },
        { type: 'text', text: thaiDateShort_(note.date) + (ago > 0 ? ' · ' + ago + ' วันก่อน' : ' · วันนี้'), size: 'xs', color: '#8a94a0', align: 'end', wrap: true }
      ]
    });
    body.push({ type: 'separator', margin: 'md' });
    body.push({ type: 'text', text: clip_(note.text, NOTE_MAX_CHARS), wrap: true, size: 'md', color: '#1f2933', margin: 'md' });
  } else {
    body.push({ type: 'text', text: 'ยังไม่มีบันทึกเนื้อหาการสอนของวิชานี้', size: 'sm', color: '#8a94a0', wrap: true });
  }
  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: color, paddingAll: '14px', contents: [
        { type: 'text', text: s.code, size: 'xs', color: '#e3e9f0' },
        { type: 'text', text: s.name, size: 'lg', weight: 'bold', color: '#ffffff', wrap: true },
        { type: 'text', text: meta, size: 'xs', color: '#e3e9f0', wrap: true, margin: 'sm' }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '14px', contents: body },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: '#f7f9fb', contents: [
        { type: 'text', text: 'วัน' + now.dayFull + 'ที่ ' + thaiDateLong_(now.iso), size: 'xs', color: '#677483', align: 'center', wrap: true }
      ]
    }
  };
}

function pushLine_(messages) {
  const token = prop_('LINE_TOKEN'), to = prop_('LINE_USER_ID');
  if (!token || !to) throw new Error('ยังไม่ได้ตั้ง LINE_TOKEN / LINE_USER_ID ใน Script properties');
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: to, messages: messages }), muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200) { log_('line-error', code + ' ' + res.getContentText()); throw new Error('LINE ตอบ ' + code + ': ' + res.getContentText()); }
}

/* ═════════════ ตั้งค่าครั้งแรก ═════════════ */

/** รันครั้งเดียว: สร้างชีต + ตั้งทริกเกอร์ 07:00 ทุกวัน */
function setup() {
  Object.keys(SHEETS).forEach(function (n) { sheet_(n); });
  installTrigger();
  Logger.log('เรียบร้อย: สร้างชีตและตั้งเวลาส่งไลน์ 07:00 แล้ว — ต่อไป Deploy เป็น Web app และรัน testPush()');
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'sendDailyBrief') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendDailyBrief').timeBased().everyDays(1).atHour(7).nearMinute(0).inTimezone(TZ).create();
}

/* ═════════════ ตัวช่วยชีต ═════════════ */

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function sheet_(name) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const head = SHEETS[name];
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#1f3a5f').setFontColor('#ffffff');
    sh.getRange(2, 1, sh.getMaxRows() - 1, head.length).setNumberFormat('@');   // เก็บเป็นข้อความ กันชีตแปลงวันที่/เลข
    sh.setFrozenRows(1);
  }
  return sh;
}

function readRows_(name) {
  const sh = sheet_(name), head = SHEETS[name];
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, head.length).getValues().map(function (r) {
    const o = {};
    head.forEach(function (h, i) { o[h] = cell_(r[i]); });
    return o;
  }).filter(function (o) { return o.id || o.time; });
}

function cell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return v == null ? '' : String(v);
}

function upsertRows_(name, items) {
  items = (items || []).filter(function (x) { return x && x.id; });
  if (!items.length) return;
  const sh = sheet_(name), head = SHEETS[name];
  const last = sh.getLastRow();
  const ids = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  const index = {}; ids.forEach(function (id, i) { index[id] = i + 2; });
  const append = [];
  items.forEach(function (it) {
    const row = head.map(function (h) { return it[h] == null ? '' : String(it[h]); });
    if (index[it.id]) sh.getRange(index[it.id], 1, 1, head.length).setNumberFormat('@').setValues([row]);
    else { append.push(row); index[it.id] = -1; }
  });
  if (append.length) {
    const start = Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(start, 1, append.length, head.length).setNumberFormat('@').setValues(append);
  }
}

function deleteRow_(name, id) {
  const sh = sheet_(name), last = sh.getLastRow();
  if (last < 2) return;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === String(id)) sh.deleteRow(i + 2);
}

function clearData_(name) {
  const sh = sheet_(name), last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, SHEETS[name].length).clearContent();
}

function upsertSubjects_(subjects, replace) {
  if (replace) clearData_('Subjects');
  upsertRows_('Subjects', subjects);
}

function log_(event, detail) {
  try {
    const sh = sheet_('Log');
    sh.appendRow([Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'), event, String(detail).slice(0, 500)]);
    if (sh.getLastRow() > 500) sh.deleteRows(2, 100);
  } catch (e) { /* ignore */ }
}

/* ═════════════ ตัวช่วยวันที่/ข้อความ ═════════════ */

function nowInfo_() {
  const d = new Date();
  const iso = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  const u = Number(Utilities.formatDate(d, TZ, 'u'));
  return { iso: iso, dayCode: DAY_CODES[u - 1], dayFull: DAY_FULL[u - 1] };
}

function parseIso_(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}
function thaiDateLong_(iso) {
  const p = parseIso_(iso); return p ? p.d + ' ' + MONTHS_TH[p.m - 1] + ' ' + (p.y + 543) : String(iso);
}
function thaiDateShort_(iso) {
  const p = parseIso_(iso); return p ? p.d + ' ' + MONTHS_TH[p.m - 1].slice(0, 3) + '. ' + String(p.y + 543).slice(2) : String(iso);
}
function daysBetween_(fromIso, toIso) {
  const a = parseIso_(fromIso), b = parseIso_(toIso);
  if (!a || !b) return 0;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}
function clip_(t, n) {
  t = String(t || '').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
