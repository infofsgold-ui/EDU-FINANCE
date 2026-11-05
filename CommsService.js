/**
 * THÔNG BÁO (chuông) + CHAT nội bộ.
 *
 * Phân quyền chat (1–1) THEO TRƯỜNG:
 *  - Hai cán bộ chat được khi có chung ít nhất 1 trường (trường chính + "trường phụ trách" ở Users.SchoolIds).
 *  - Tài khoản toàn hệ thống (Ban lãnh đạo, Kế toán trưởng, Kiểm soát) CHƯA giao trường: chat với nhau và với Hiệu trưởng các trường,
 *    không hiện với cán bộ trường; đã giao trường phụ trách thì chat như cán bộ của các trường đó.
 *  - Quản trị hệ thống (GROUP_ADMIN): chat được với mọi cán bộ (hỗ trợ).
 *  - Phụ huynh ↔ giáo viên đang dạy lớp của con (chủ nhiệm hoặc giảng dạy). Phụ huynh không chat với vai trò khác.
 */

const CHAT_TIER_ = {GROUP_ADMIN:1, EXECUTIVE:1, FINANCE_MANAGER:1, AUDITOR:1, PRINCIPAL:1,
  SCHOOL_ACCOUNTANT:2, CASHIER:2, STOREKEEPER:2, TEACHER:2, PARENT:3};

function threadId_(a, b) { return [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('|'); }

/** Tập trường dùng cho chat của 1 cán bộ; null = tài khoản toàn hệ thống chưa giao trường. */
function chatSchools_(u) {
  if (ROLES[u.role] && ROLES[u.role].group) return u.assignedSchools && u.assignedSchools.length ? new Set(u.assignedSchools) : null;
  return new Set(u.schoolIds || [String(u.schoolId || '')]);
}

/** Có được chat giữa 2 cán bộ không (theo trường). */
function staffCanChat_(me, other) {
  if (!CHAT_TIER_[me.role] || !CHAT_TIER_[other.role] || me.role === 'PARENT' || other.role === 'PARENT') return false;
  if (me.role === 'GROUP_ADMIN' || other.role === 'GROUP_ADMIN') return true;
  const s1 = chatSchools_(me), s2 = chatSchools_(other);
  // Tài khoản tập đoàn chưa giao trường: chỉ liên lạc tuyến quản lý (tập đoàn ↔ tập đoàn, tập đoàn ↔ hiệu trưởng).
  if (!s1 || !s2) {
    // Tài khoản tập đoàn luôn chat được với nhau (dù đã/chưa giao trường); với cấp trường thì chỉ Hiệu trưởng.
    if (isGroupWide_(me) && isGroupWide_(other)) return true;
    const withSet = s1 ? me : other;
    return withSet.role === 'PRINCIPAL';
  }
  for (const x of s1) if (s2.has(x)) return true;
  return false;
}

/** Danh bạ chat của người dùng hiện tại (đã lọc theo quyền), kèm số tin chưa đọc và tin gần nhất. */
function chatContacts_(me) {
  const contacts = {};
  const add = (id, name, label, role) => { id = String(id).toLowerCase(); if (id && id !== String(me.email).toLowerCase()) contacts[id] = {id, name, label, role}; };
  const classes = readTable_('Classes');
  const cname = Object.fromEntries(classes.map(c => [String(c.ClassId), c.ClassName]));
  const users = readTable_('Users').filter(u => truthy_(u.Active) && ROLES[u.Role]);
  const schools = Object.fromEntries(readTable_('Schools').map(s => [String(s.SchoolId), s.SchoolName]));
  if (me.role === 'PARENT') {
    const kids = readTable_('Students').filter(s => me.studentIds.indexOf(String(s.StudentId)) > -1);
    kids.forEach(k => {
      const c = classes.find(x => String(x.ClassId) === String(k.ClassId));
      if (!c) return;
      const hr = String(c.HomeroomTeacher || '').toLowerCase().trim();
      users.filter(u => u.Role === 'TEACHER' && String(u.SchoolId) === String(k.SchoolId)).forEach(u => {
        const e = String(u.UserEmail).toLowerCase(), n = String(u.FullName || '').toLowerCase().trim();
        if (hr && (hr === e || hr === n)) add(e, u.FullName, 'GVCN lớp ' + c.ClassName + ' (em ' + k.FullName + ')', 'TEACHER');
        else if (emailList_(c.TeacherEmails).includes(e)) add(e, u.FullName, 'GV lớp ' + c.ClassName + ' (em ' + k.FullName + ')', 'TEACHER');
      });
    });
  } else {
    users.forEach(u => {
      const other = staffUser_(u);
      if (!staffCanChat_(me, other)) return;
      const sch = (other.schoolIds || (other.assignedSchools && other.assignedSchools.length ? other.assignedSchools : [other.schoolId]))
        .filter(x => x && x !== '*').map(x => schools[String(x)] || '').filter(Boolean);
      add(u.UserEmail, u.FullName || u.UserEmail, (ROLES[u.Role] || {}).label + (sch.length ? ' · ' + sch.join(', ') : ''), u.Role);
    });
    if (me.role === 'TEACHER') {
      const t = teacherClasses_(me), mine = new Set(t.homeroom.concat(t.teaching));
      const stu = Object.fromEntries(readTable_('Students').filter(s => mine.has(String(s.ClassId))).map(s => [String(s.StudentId), s]));
      readTable_('Credentials').filter(c => String(c.Type) === 'PARENT' && truthy_(c.Active) && stu[String(c.StudentId)]).forEach(c => {
        const s = stu[String(c.StudentId)];
        add('PH:' + c.Username, s.ParentName || ('Phụ huynh em ' + s.FullName), 'Phụ huynh em ' + s.FullName + ' – lớp ' + (cname[String(s.ClassId)] || ''), 'PARENT');
      });
    }
  }
  return contacts;
}

function chatContacts() {
  const me = currentUser_();
  const contacts = chatContacts_(me);
  const myId = String(me.email).toLowerCase();
  readTable_('ChatMessages').forEach(m => {
    const from = String(m.FromUser).toLowerCase(), to = String(m.ToUser).toLowerCase();
    if (from !== myId && to !== myId) return;
    const other = from === myId ? to : from, c = contacts[other];
    if (!c) return;
    if (!c.last || String(m.SentAt) > c.lastAt) { c.last = String(m.Body).slice(0, 80); c.lastAt = String(m.SentAt); c.lastMine = from === myId; }
    if (to === myId && !m.ReadAt) c.unread = (c.unread || 0) + 1;
  });
  const list = Object.values(contacts).sort((a, b) => (b.unread || 0) - (a.unread || 0) || String(b.lastAt || '').localeCompare(String(a.lastAt || '')) ||
    String(a.name).localeCompare(String(b.name), 'vi'));
  return {me:myId, contacts:list, unread:list.reduce((t, c) => t + (c.unread || 0), 0)};
}

/** Tin nhắn với một người (đánh dấu đã đọc các tin gửi đến mình). payload: {with} */
function chatMessages(payload) {
  const me = currentUser_(), myId = String(me.email).toLowerCase(), other = String(payload.with || '').toLowerCase();
  if (!chatContacts_(me)[other]) throw new Error('Bạn không có quyền nhắn tin với người này.');
  const tid = threadId_(myId, other);
  const msgs = readTable_('ChatMessages').filter(m => String(m.ThreadId).toLowerCase() === tid);
  const unread = msgs.filter(m => String(m.ToUser).toLowerCase() === myId && !m.ReadAt);
  if (unread.length) withWriteLock_(() => {
    const now = new Date(), patches = {};
    unread.forEach(m => patches[m.MessageId] = {ReadAt:now});
    updateObjectsById_('ChatMessages', 'MessageId', patches);
  });
  return msgs.slice(-200).map(m => ({id:m.MessageId, mine:String(m.FromUser).toLowerCase() === myId, from:m.FromName, body:String(m.Body),
    at:Utilities.formatDate(m.SentAt instanceof Date ? m.SentAt : new Date(m.SentAt), APP.TZ, 'dd/MM HH:mm'), read:!!m.ReadAt}));
}

/** Gửi tin nhắn. payload: {to, body} */
function chatSend(payload) {
  const me = currentUser_(), myId = String(me.email).toLowerCase(), to = String(payload.to || '').toLowerCase();
  const body = String(payload.body || '').trim();
  if (!body) throw new Error('Nhập nội dung tin nhắn.');
  if (body.length > 2000) throw new Error('Tin nhắn tối đa 2.000 ký tự.');
  if (!chatContacts_(me)[to]) throw new Error('Bạn không có quyền nhắn tin với người này.');
  return withWriteLock_(() => {
    const id = nextId_('MSG');
    // SentAt lưu dạng văn bản ISO để giữ nguyên giờ phút (cột ngày tháng khi đọc lại bị bỏ giờ).
    appendObject_('ChatMessages', {MessageId:id, ThreadId:threadId_(myId, to), FromUser:myId, FromName:me.name, ToUser:to,
      Body:body, SentAt:asText_(new Date().toISOString()), ReadAt:''});
    return {ok:true, id};
  });
}

// ===================== CHUÔNG THÔNG BÁO =====================

/** Danh sách cảnh báo / việc cần làm theo vai trò. Mỗi mục: {level, title, detail, page, count} */
/**
 * CẢNH BÁO / THÔNG BÁO — gửi đúng người xử lý:
 *  - Phụ huynh: học phí cần nộp, đơn mua đã xử lý, ngày nghỉ bị từ chối.
 *  - Giáo viên chủ nhiệm: phụ huynh báo nghỉ chờ xác nhận (lớp chủ nhiệm); chưa được phân lớp.
 *  - Hiệu trưởng: khoản chi, chính sách của trường chờ duyệt; báo nghỉ quá hạn / lớp chưa có GVCN (xác nhận thay).
 *  - Kế toán trường: đơn mua phụ huynh chờ xác nhận, công nợ quá hạn (để nhắc phí), khoản chi mình lập bị từ chối.
 *  - Thủ quỹ: đơn mua phụ huynh chờ xác nhận.  - Thủ kho: mặt hàng dưới ngưỡng tồn.
 *  - Kế toán trưởng: khoản chi, chính sách chờ duyệt toàn hệ thống.  - Quản trị: chính sách áp dụng mọi trường chờ duyệt.
 * Mỗi mục có key + fp (dấu vân tay nội dung). Đã đọc → ẩn cho đến khi nội dung thay đổi (fp khác).
 * Mục "cần xử lý" tự hết khi đã xử lý xong.
 */
function alertsRaw_(user) {
  return memo_('alerts', [String(user.email).toLowerCase(), user.role], () => computeAlerts_(user));
}

function computeAlerts_(user) {
  const items = [];
  const push = (o) => items.push(Object.assign({kind:'info', level:'info', detail:'', page:'', count:1}, o, {fp:String(o.fp)}));
  const today = Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd');
  const daysAgo = n => Utilities.formatDate(new Date(Date.now() - n * 86400000), APP.TZ, 'yyyy-MM-dd');
  const myId = String(user.email).toLowerCase();
  const unread = readTable_('ChatMessages').filter(m => String(m.ToUser).toLowerCase() === myId && !m.ReadAt);
  if (unread.length) push({key:'chat', fp:unread.length + '|' + unread[unread.length - 1].MessageId, kind:'action', title:unread.length + ' tin nhắn chưa đọc',
    detail:'Từ: ' + Array.from(new Set(unread.map(m => m.FromName))).slice(0, 4).join(', '), page:'chat', count:unread.length});
  let stuMap = null;
  const stu = () => stuMap || (stuMap = Object.fromEntries(readTable_('Students').map(s => [String(s.StudentId), s])));
  const dm = d => String(d).slice(8, 10) + '/' + String(d).slice(5, 7);

  if (user.role === 'PARENT') {
    readTable_('Students').filter(s => user.studentIds.indexOf(String(s.StudentId)) > -1).forEach(s => {
      const bal = roundMoney_(readTable_('Invoices').filter(i => String(i.StudentId) === String(s.StudentId) && invoiceLive_(i)).reduce((t, i) => t + Number(i.Balance || 0), 0));
      if (bal > 0) push({key:'bal:' + s.StudentId, fp:bal, kind:'action', level:'warn', title:'Học phí cần thanh toán: ' + fmtMoney_(bal) + 'đ', detail:'Học sinh ' + s.FullName, page:'parent', student:String(s.StudentId)});
      readTable_('Orders').filter(o => String(o.StudentId) === String(s.StudentId) && ['CONFIRMED','REJECTED'].includes(String(o.Status)) && String(o.ProcessedAt || '').slice(0, 10) >= daysAgo(30))
        .forEach(o => push({key:'ord:' + o.OrderId, fp:o.Status, level:o.Status === 'CONFIRMED' ? 'info' : 'warn',
          title:'Đơn mua của ' + s.FullName + (o.Status === 'CONFIRMED' ? ' đã được xác nhận' : ' bị từ chối'), detail:o.Reason || fmtMoney_(o.Total) + 'đ', page:'parent', student:String(s.StudentId)}));
      readTable_('MealAbsences').filter(a => String(a.StudentId) === String(s.StudentId) && String(a.Status) === 'REJECTED' && String(a.AbsenceDate).slice(0, 10) >= daysAgo(45))
        .forEach(a => push({key:'abs:' + a.AbsenceId, fp:'REJECTED', level:'warn', title:'Ngày nghỉ ' + dm(a.AbsenceDate) + ' của ' + s.FullName + ' không được xác nhận',
          detail:a.Note || 'Liên hệ giáo viên chủ nhiệm', page:'parent', student:String(s.StudentId)}));
    });
    return items;
  }

  const role = user.role;
  const schools = new Set(listSchoolsForUser_(user).map(s => String(s.SchoolId)));
  // Trường chưa có người giữ vai trò xử lý → Kế toán trưởng nhận thay.
  const staff = readTable_('Users').filter(u => truthy_(u.Active));
  const covered = roles => { const set = new Set(); staff.filter(u => roles.includes(u.Role)).forEach(u =>
    [String(u.SchoolId || '')].concat(String(u.SchoolIds || '').split(/[,;\s]+/)).filter(Boolean).forEach(x => set.add(x))); return set; };
  const fallback = (roles) => role === 'FINANCE_MANAGER' ? new Set(Array.from(schools).filter(x => !covered(roles).has(x))) : new Set();
  const sellSchools = role === 'SCHOOL_ACCOUNTANT' || role === 'CASHIER' ? schools : fallback(['SCHOOL_ACCOUNTANT','CASHIER']);
  const debtSchools = role === 'SCHOOL_ACCOUNTANT' ? schools : fallback(['SCHOOL_ACCOUNTANT']);
  const absSchools = role === 'PRINCIPAL' ? schools : fallback(['PRINCIPAL']);
  const pendAbs = readTable_('MealAbsences').filter(a => String(a.Status) === 'REPORTED' && schools.has(String(a.SchoolId)));
  const absItem = (list, title) => list.length && push({key:'mealabs', fp:list.length + '|' + list.map(a => a.AbsenceId).sort().pop(), kind:'action', level:'warn',
    title:list.length + ' ' + title, detail:list.slice(0, 5).map(a => ((stu()[String(a.StudentId)] || {}).FullName || '') + ' ' + dm(a.AbsenceDate)).join(' · '), page:'meals', count:list.length});

  if (role === 'TEACHER') {
    const t = teacherClasses_(user);
    if (!t.homeroom.length && !t.teaching.length) push({key:'noclass', fp:'1', kind:'action', level:'warn', title:'Bạn chưa được phân lớp', detail:'Liên hệ Hiệu trưởng / quản trị để được gán lớp chủ nhiệm hoặc giảng dạy.'});
    const hr = new Set(t.homeroom);
    absItem(pendAbs.filter(a => hr.has(String((stu()[String(a.StudentId)] || {}).ClassId))), 'ngày phụ huynh báo nghỉ chờ bạn xác nhận');
  }
  if (absSchools.size) {
    // Xác nhận thay: lớp chưa có GVCN hoặc báo nghỉ đã chờ từ hôm trước.
    const hasHr = new Set(readTable_('Classes').filter(c => String(c.HomeroomTeacher || '').trim()).map(c => String(c.ClassId)));
    absItem(pendAbs.filter(a => absSchools.has(String(a.SchoolId))).filter(a => !hasHr.has(String((stu()[String(a.StudentId)] || {}).ClassId)) || String(a.ReportedAt || '').slice(0, 10) < today),
      'ngày báo nghỉ chưa được GVCN xác nhận (quá hạn / lớp chưa có GVCN)');
  }
  if (sellSchools.size) {
    const list = readTable_('Orders').filter(o => o.Status === 'PENDING' && sellSchools.has(String(o.SchoolId)));
    if (list.length) push({key:'orders', fp:list.length + '|' + list.map(o => o.OrderId).sort().pop(), kind:'action', level:'warn',
      title:list.length + ' đơn mua của phụ huynh chờ xác nhận', page:'sales', count:list.length});
  }
  if (debtSchools.size) {
    const overdue = readTable_('Invoices').filter(i => invoiceLive_(i) && Number(i.Balance) > 0 && debtSchools.has(String(i.SchoolId)) && i.DueDate && String(i.DueDate).slice(0, 10) < today);
    if (overdue.length) {
      const total = roundMoney_(overdue.reduce((t, i) => t + Number(i.Balance || 0), 0));
      push({key:'overdue', fp:total, kind:'action', level:'danger', title:'Công nợ quá hạn: ' + fmtMoney_(total) + 'đ',
        detail:new Set(overdue.map(i => i.StudentId)).size + ' học sinh — gửi thông báo nhắc phí', page:'notify'});
    }
    readTable_('Expenses').filter(e => String(e.CreatedBy).toLowerCase() === myId && String(e.Status).toUpperCase() === 'REJECTED' && String(e.ExpenseDate).slice(0, 10) >= daysAgo(60))
      .forEach(e => push({key:'exprej:' + e.ExpenseId, fp:'REJECTED', level:'warn', title:'Khoản chi bị từ chối: ' + fmtMoney_(e.Amount) + 'đ',
        detail:(e.Category || '') + (e.Description ? ' – ' + e.Description : '') + ' (' + String(e.ExpenseDate).slice(0, 10) + ')', page:'expenses'}));
  }
  if (role === 'PRINCIPAL' || role === 'FINANCE_MANAGER') {
    const list = readTable_('Expenses').filter(e => String(e.Status).toUpperCase() === 'PENDING' && schools.has(String(e.SchoolId)));
    if (list.length) push({key:'expenses', fp:list.length + '|' + list.map(e => e.ExpenseId).sort().pop(), kind:'action', level:'warn',
      title:list.length + ' khoản chi chờ duyệt', detail:'Tổng ' + fmtMoney_(list.reduce((t, e) => t + Number(e.Amount || 0), 0)) + 'đ', page:'expenses', count:list.length});
  }
  if (['PRINCIPAL','FINANCE_MANAGER','GROUP_ADMIN'].includes(role)) {
    const list = readTable_('Discounts').filter(d => truthy_(d.Active) && !policyApproved_(d) && (!d.SchoolId || d.SchoolId === '*'
      ? role !== 'PRINCIPAL' : role !== 'GROUP_ADMIN' && schools.has(String(d.SchoolId))));
    if (list.length) push({key:'policies', fp:list.length + '|' + list.map(d => d.DiscountId).sort().pop(), kind:'action', level:'warn',
      title:list.length + ' chính sách giá chờ duyệt', detail:list.slice(0, 3).map(d => d.Name).join(' · '), page:'master', count:list.length});
  }
  if (role === 'STOREKEEPER' || (role === 'FINANCE_MANAGER' && !staff.some(u => u.Role === 'STOREKEEPER'))) {
    try {
      const r = getInventoryReport({});
      const low = r.totals.lowStock;
      if (low) push({key:'lowstock', fp:low + '|' + (r.rows || []).filter(x => x.lowStock).map(x => x.warehouse + ':' + x.product).join(','), kind:'action', level:'warn',
        title:low + ' mặt hàng dưới ngưỡng tồn', detail:'Cần nhập thêm hàng', page:'inventory', count:low});
    } catch (e) {}
  }
  return items;
}

function alertReadsRow_(user) {
  const key = String(user.email).toLowerCase();
  return readTable_('AlertReads').find(r => String(r.UserKey).toLowerCase() === key) || null;
}
function alertReadMap_(user) {
  const row = alertReadsRow_(user);
  try { return row ? JSON.parse(String(row.Data || '{}')) : {}; } catch (e) { return {}; }
}

function getAlerts() {
  const user = currentUser_();
  const read = alertReadMap_(user);
  const all = alertsRaw_(user);
  // Tin nhắn chưa đọc chỉ tắt khi mở đọc tin.
  const items = all.filter(i => i.key === 'chat' || read[i.key] !== i.fp);
  return {items, count:items.reduce((t, i) => t + i.count, 0), hidden:all.length - items.length};
}

/** Đánh dấu đã đọc. payload: {keys:[{key, fp}]} hoặc {all:true}. Mục ẩn cho đến khi nội dung thay đổi. */
function markAlertsRead(payload) {
  const user = currentUser_();
  payload = payload || {};
  return withWriteLock_(() => {
    const current = alertsRaw_(user);
    const map = alertReadMap_(user);
    const marks = payload.all ? current.filter(i => i.key !== 'chat').map(i => ({key:i.key, fp:i.fp})) : (payload.keys || []);
    marks.forEach(m => { if (m && m.key && m.key !== 'chat') map[String(m.key)] = String(m.fp); });
    // Chỉ giữ các mục còn tồn tại để dữ liệu không phình ra.
    const live = new Set(current.map(i => i.key));
    Object.keys(map).forEach(k => { if (!live.has(k)) delete map[k]; });
    const data = JSON.stringify(map), key = String(user.email).toLowerCase();
    if (alertReadsRow_(user)) updateObjectById_('AlertReads', 'UserKey', alertReadsRow_(user).UserKey, {Data:data, UpdatedAt:new Date()});
    else appendObject_('AlertReads', {UserKey:key, Data:data, UpdatedAt:new Date()});
    invalidateTable_('AlertReads');
    return getAlerts();
  });
}
