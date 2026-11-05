/**
 * ĐĂNG NHẬP RIÊNG CỦA ỨNG DỤNG (dùng khi web app triển khai "Execute as: Me" + "Anyone").
 * Khi đó Google không cho biết người đang truy cập, nên mọi người dùng đăng nhập bằng tài khoản của hệ thống:
 *  - Cán bộ (STAFF): tên đăng nhập = email trong sheet Users.
 *  - Phụ huynh (PARENT): tên đăng nhập = mã học sinh (nếu trùng mã giữa các trường thì thêm hậu tố trường).
 * Mật khẩu lưu dạng băm SHA-256 nhiều vòng + salt trong sheet Credentials. Mật khẩu tạm buộc đổi ở lần đăng nhập đầu.
 * Phiên đăng nhập: token ngẫu nhiên lưu trong CacheService (hết hạn sau 6 giờ không hoạt động).
 * Mọi lời gọi từ giao diện đi qua api(token, fn, arg) — chỉ các hàm trong API_FUNCTIONS_ được gọi.
 */

const SESSION_TTL_ = 21600;
const MAX_FAILED_ = 5, LOCK_MINUTES_ = 15, HASH_ROUNDS_ = 300;

const API_FUNCTIONS_ = [
  'getBootstrap','changePassword','logout','getAlerts','markAlertsRead','getPerfStats','clearDataCache','getBannerAdmin','saveSchoolBanner','uploadBannerImage','removeBannerImage','resetSchoolBanner','chatContacts','chatMessages','chatSend',
  'getDashboardData','getStudentList','getStudentDetail','getReport','exportReportToSheet','getRows',
  'saveStudent','updateStudent','saveSchool','saveClass','saveFeeType','saveFeeRate','saveWarehouse','saveProduct',
  'calculatePreview','postInvoices','recordPayment','createSale','getRecentSales','recordExpense','setExpenseStatus','getExpenses',
  'getInventoryReport','getStockBalances','recordStockMovement','recordGoodsReceipt','getGoodsReceipts',
  'getNotificationSettings','saveNotificationSettings','previewNotifications','previewNotice','sendNotifications',
  'listBankAccounts','saveBankAccount','deleteBankAccount',
  'importStudents','importStudentAccounts','importExpenses','getImportTemplateInfo',
  'listUsers','saveUser','issueStaffPassword',
  'listPolicies','savePolicy','setPolicyStatus','getPolicyDetail','addPolicyMembers','removePolicyMember','uploadPolicyDocument',
  'getMasterData','updateMaster','deleteMaster','uploadProductImage','removeProductImage','checkDriveFolders','getStudentPolicyOptions','setStudentPolicies',
  'getMealMonth','saveMealMonth','saveMealRecords','closeMealMonth','reopenMealMonth','markMealRefundPaid',
  'parentReportAbsence','parentCancelAbsence','listMealAbsences','confirmMealAbsences',
  'listParentAccounts','issueParentAccounts','setParentAccountActive','sendParentAccount','mergeFamilyAccounts',
  'getParentHome','parentRegisterMeal','createParentOrder','cancelParentOrder','listParentOrders','confirmParentOrder','rejectParentOrder','getOrderStock'
];

/** Cổng gọi duy nhất từ giao diện. */
function api(token, fn, arg) {
  if (API_FUNCTIONS_.indexOf(fn) < 0) throw new Error('Chức năng không hợp lệ: ' + fn);
  const sess = readSession_(token);
  if (!sess) throw new Error('AUTH_REQUIRED');
  if (sess.mc && ['getBootstrap','changePassword','logout'].indexOf(fn) < 0) throw new Error('MUST_CHANGE');
  preloadTables_(sess.t === 'PARENT' ? ['Credentials','Schools','Classes'] : ['Credentials','Users','Schools','Classes']);
  CURRENT_USER_ = sessionUser_(sess);
  CURRENT_TOKEN_ = token;
  touchSession_(token, sess);
  const f = globalThis[fn];
  if (typeof f !== 'function') throw new Error('Chức năng không tồn tại: ' + fn);
  const started = Date.now();
  try { return f(arg); } finally { perfRecord_(fn, Date.now() - started); }
}

/** Ghi lại thời gian xử lý: mọi lời gọi chậm (≥ 1,5 giây) và 1/10 lời gọi còn lại, giữ 200 mẫu gần nhất. */
function perfRecord_(fn, ms) {
  try {
    console.log(JSON.stringify({perf:fn, ms, sheetReads:PERF_.sheetReads, cacheHits:PERF_.cacheHits, memoHits:PERF_.memoHits, sheetMs:PERF_.sheetMs, tables:PERF_.tables}));
    if (ms < 1500 && Math.random() > 0.1) return;
    const cache = CacheService.getScriptCache();
    const list = JSON.parse(cache.get('PERF') || '[]');
    list.push({f:fn, ms, r:PERF_.sheetReads, c:PERF_.cacheHits, m:PERF_.memoHits, s:PERF_.sheetMs, t:PERF_.tables.slice(0, 8), at:Date.now()});
    cache.put('PERF', JSON.stringify(list.slice(-200)), 21600);
  } catch (e) {}
}

/** Bảng đo tốc độ cho quản trị (Cài đặt → Tốc độ hệ thống). */
function getPerfStats() {
  requireCap_('manageSettings');
  const list = JSON.parse(CacheService.getScriptCache().get('PERF') || '[]');
  const by = {};
  list.forEach(x => {
    const a = by[x.f] || (by[x.f] = {fn:x.f, count:0, total:0, max:0, sheetReads:0, cached:0, tables:{}});
    a.count++; a.total += x.ms; a.max = Math.max(a.max, x.ms); a.sheetReads += x.r; a.cached += x.c + x.m;
    (x.t || []).forEach(t => a.tables[t] = (a.tables[t] || 0) + 1);
  });
  return {samples:list.length, rows:Object.values(by).map(a => ({fn:a.fn, count:a.count, avg:Math.round(a.total / a.count), max:a.max,
    sheetReads:Math.round(a.sheetReads / a.count * 10) / 10, cached:Math.round(a.cached / a.count * 10) / 10,
    tables:Object.keys(a.tables).sort((p, q) => a.tables[q] - a.tables[p]).slice(0, 4)})).sort((p, q) => q.avg - p.avg)};
}

let CURRENT_TOKEN_ = '';

function readSession_(token) {
  if (!token || !/^[A-Za-z0-9]{40,80}$/.test(String(token))) return null;
  const raw = CacheService.getScriptCache().get('S:' + token);
  return raw ? JSON.parse(raw) : null;
}
function touchSession_(token, sess) {
  if (Date.now() - (sess.at || 0) > 15 * 60000) { sess.at = Date.now(); CacheService.getScriptCache().put('S:' + token, JSON.stringify(sess), SESSION_TTL_); }
}
function newToken_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }

/** Dựng đối tượng người dùng (giống currentUser_) từ phiên. */
function sessionUser_(sess) {
  const cred = readTable_('Credentials').find(c => String(c.Username).toLowerCase() === String(sess.u).toLowerCase());
  if (!cred || !truthy_(cred.Active)) throw new Error('AUTH_REQUIRED');
  if (sess.t === 'PARENT') {
    const ids = parentFamilyIds_(cred);
    const kids = readTable_('Students').filter(s => ids.indexOf(String(s.StudentId)) > -1);
    if (!kids.length) throw new Error('AUTH_REQUIRED');
    kids.sort((a, b) => ids.indexOf(String(a.StudentId)) - ids.indexOf(String(b.StudentId)));
    const st = kids[0];
    return {email:'PH:' + cred.Username, username:cred.Username, name:st.ParentName || ('Phụ huynh ' + st.FullName), role:'PARENT',
      schoolId:String(st.SchoolId), schoolIds:Array.from(new Set(kids.map(k => String(k.SchoolId)))), studentIds:kids.map(k => String(k.StudentId)), mustChange:!!sess.mc};
  }
  const email = String(cred.UserEmail || cred.Username).toLowerCase();
  const u = readTable_('Users').find(x => String(x.UserEmail).toLowerCase().trim() === email && truthy_(x.Active));
  if (!u || !ROLES[u.Role]) throw new Error('AUTH_REQUIRED');
  return staffUser_(u, {email, username:cred.Username, mustChange:!!sess.mc});
}

function hashPassword_(password, salt) {
  let h = salt + '|' + password;
  for (let i = 0; i < HASH_ROUNDS_; i++) {
    h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8)
      .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  }
  return h;
}
function randomPassword_() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const seed = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  let out = '';
  for (let i = 0; i < 9; i++) out += chars[parseInt(seed.substr(i * 3, 3), 16) % chars.length];
  return out;
}
function checkPasswordRules_(pw) {
  pw = String(pw || '');
  if (pw.length < 8) throw new Error('Mật khẩu phải có ít nhất 8 ký tự.');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new Error('Mật khẩu cần có cả chữ và số.');
}

/** Đặt mật khẩu (tạo tài khoản nếu chưa có). Gọi trong khóa ghi. */
function setCredential_(username, fields, password, mustChange) {
  const salt = Utilities.getUuid().replace(/-/g, '');
  const now = new Date();
  const row = Object.assign({}, fields, {PasswordHash:hashPassword_(password, salt), Salt:salt, MustChange:!!mustChange,
    Active:true, FailedCount:0, LockedUntil:'', UpdatedAt:now});
  const cur = readTable_('Credentials').find(c => String(c.Username).toLowerCase() === String(username).toLowerCase());
  if (cur) updateObjectById_('Credentials', 'Username', cur.Username, row);
  else appendObject_('Credentials', Object.assign({Username:asText_(String(username)), CreatedAt:now}, row));
}

/** Đăng nhập. payload: {type:'PARENT'|'STAFF', username, password} → {token, mustChange} */
function login(payload) {
  const type = String(payload.type || '').toUpperCase() === 'PARENT' ? 'PARENT' : 'STAFF';
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '');
  if (!username || !password) throw new Error('Nhập tên đăng nhập và mật khẩu.');
  const generic = 'Tên đăng nhập hoặc mật khẩu không đúng.';
  return withWriteLock_(() => {
    const cred = type === 'PARENT' ? findParentCredByLogin_(username)
      : readTable_('Credentials').find(c => String(c.Username).toLowerCase() === username.toLowerCase() && String(c.Type) === type);
    if (!cred || !truthy_(cred.Active)) throw new Error(generic);
    // LockedUntil lưu dạng số mili-giây (không lưu kiểu ngày vì khi đọc lại bị mất giờ).
    if (Number(cred.LockedUntil) > Date.now())
      throw new Error('Tài khoản tạm khóa do nhập sai nhiều lần. Thử lại sau ' + LOCK_MINUTES_ + ' phút hoặc dùng "Quên mật khẩu".');
    if (hashPassword_(password, String(cred.Salt)) !== String(cred.PasswordHash)) {
      const failed = Number(cred.FailedCount || 0) + 1;
      updateObjectById_('Credentials', 'Username', cred.Username, failed >= MAX_FAILED_
        ? {FailedCount:0, LockedUntil:Date.now() + LOCK_MINUTES_ * 60000} : {FailedCount:failed});
      throw new Error(failed >= MAX_FAILED_ ? 'Sai mật khẩu ' + MAX_FAILED_ + ' lần — tài khoản tạm khóa ' + LOCK_MINUTES_ + ' phút.' : generic);
    }
    const sess = {u:String(cred.Username), t:type, mc:truthy_(cred.MustChange), at:Date.now()};
    sessionUser_(sess); // kiểm tra tài khoản còn hiệu lực (cán bộ còn trong Users, học sinh còn tồn tại)
    const token = newToken_();
    CacheService.getScriptCache().put('S:' + token, JSON.stringify(sess), SESSION_TTL_);
    updateObjectById_('Credentials', 'Username', cred.Username, {FailedCount:0, LockedUntil:'', LastLogin:new Date()});
    return {token, mustChange:sess.mc};
  });
}

function logout() {
  if (CURRENT_TOKEN_) CacheService.getScriptCache().remove('S:' + CURRENT_TOKEN_);
  return {ok:true};
}

/** Đổi mật khẩu (bắt buộc ở lần đăng nhập đầu). payload: {oldPassword, newPassword} */
function changePassword(payload) {
  const user = currentUser_();
  checkPasswordRules_(payload.newPassword);
  return withWriteLock_(() => {
    const cred = readTable_('Credentials').find(c => String(c.Username).toLowerCase() === String(user.username).toLowerCase());
    if (!cred) throw new Error('Không tìm thấy tài khoản.');
    if (hashPassword_(String(payload.oldPassword || ''), String(cred.Salt)) !== String(cred.PasswordHash)) throw new Error('Mật khẩu hiện tại không đúng.');
    if (payload.oldPassword === payload.newPassword) throw new Error('Mật khẩu mới phải khác mật khẩu hiện tại.');
    setCredential_(cred.Username, {}, String(payload.newPassword), false);
    const sess = readSession_(CURRENT_TOKEN_);
    if (sess) { sess.mc = false; CacheService.getScriptCache().put('S:' + CURRENT_TOKEN_, JSON.stringify(sess), SESSION_TTL_); }
    return {ok:true};
  });
}

/**
 * Quên mật khẩu / lần đầu đăng nhập (không cần phiên). Luôn trả về cùng một thông báo để không lộ tài khoản nào tồn tại.
 * STAFF: email có trong Users (đang hoạt động) → gửi mật khẩu tạm qua email.
 * PARENT: mã học sinh đã được cấp tài khoản → gửi mật khẩu tạm qua email / SMS / Zalo đã đăng ký của phụ huynh.
 */
function requestPasswordReset(payload) {
  const type = String(payload.type || '').toUpperCase() === 'PARENT' ? 'PARENT' : 'STAFF';
  const username = String(payload.username || '').trim();
  const reply = {ok:true, message:'Nếu thông tin hợp lệ, mật khẩu tạm đã được gửi tới email/điện thoại đã đăng ký. Vui lòng kiểm tra (kể cả hộp thư Spam).'};
  if (!username) return reply;
  const cache = CacheService.getScriptCache(), key = 'R:' + type + ':' + username.toLowerCase();
  if (cache.get(key)) return reply; // tối đa 1 lần / 5 phút cho mỗi tài khoản
  cache.put(key, '1', 300);
  try {
    if (type === 'STAFF') {
      const u = readTable_('Users').find(x => String(x.UserEmail).toLowerCase().trim() === username.toLowerCase() && truthy_(x.Active));
      if (!u || !ROLES[u.Role] || u.Role === 'PARENT') return reply;
      sendStaffPassword_(String(u.UserEmail).toLowerCase().trim(), u.FullName);
    } else {
      const cred = findParentCredByLogin_(username);
      if (!cred || !truthy_(cred.Active)) return reply;
      const st = readTable_('Students').find(s => String(s.StudentId) === String(cred.StudentId));
      if (st) issueParentAccount_(st, ['EMAIL','SMS','ZALO'], true, {email:'system'});
    }
  } catch (e) { console.error('requestPasswordReset ' + type + ' ' + username + ': ' + (e && e.stack || e)); }
  return reply;
}

function sendStaffPassword_(email, name) {
  const pw = randomPassword_();
  withWriteLock_(() => setCredential_(email, {Type:'STAFF', UserEmail:email, StudentId:''}, pw, true));
  const url = appUrl_();
  MailApp.sendEmail({to:email, subject:'[' + APP.NAME + '] Mật khẩu đăng nhập', name:APP.NAME,
    htmlBody:emailLogo_() + '<div style="font-family:Arial,sans-serif;font-size:14px;color:#2d3a4a">Xin chào ' + esc_(name || email) + ',<br><br>' +
      'Tài khoản cán bộ của bạn trên hệ thống <b>' + APP.NAME + '</b>:<br>• Tên đăng nhập: <b>' + esc_(email) + '</b><br>• Mật khẩu tạm: <b style="font-size:16px">' + esc_(pw) + '</b><br><br>' +
      (url ? 'Đăng nhập tại: <a href="' + esc_(url) + '">' + esc_(url) + '</a> (chọn tab “Cán bộ”).<br>' : '') +
      'Lần đăng nhập đầu tiên hệ thống sẽ yêu cầu đặt mật khẩu mới.</div>'});
}

/** Admin gửi (lại) mật khẩu tạm cho cán bộ. */
function issueStaffPassword(email) {
  const user = requireCap_('manageUsers');
  const u = readTable_('Users').find(x => String(x.UserEmail).toLowerCase().trim() === String(email).toLowerCase().trim() && truthy_(x.Active));
  if (!u) throw new Error('Không tìm thấy người dùng đang hoạt động.');
  if (user.role !== 'GROUP_ADMIN') { if ((ROLES[u.Role] || {}).group) throw new Error('Không có quyền.'); assertSchoolAccess_(user, u.SchoolId); }
  sendStaffPassword_(String(u.UserEmail).toLowerCase().trim(), u.FullName);
  audit_('ISSUE_PASSWORD','Credentials',u.UserEmail,{});
  return {ok:true};
}

// ===================== TÀI KHOẢN PHỤ HUYNH =====================
/*
 * MỘT PHỤ HUYNH – NHIỀU CON: một tài khoản phụ huynh có thể gắn nhiều học sinh (Credentials.StudentId = con đầu tiên,
 * Credentials.StudentIds = các con gắn thêm). Anh chị em = học sinh có chung email hoặc chung SĐT phụ huynh.
 * Khi cấp tài khoản cho con sau, hệ thống gắn vào TÀI KHOẢN CẤP LẦN ĐẦU của phụ huynh thay vì tạo tài khoản mới.
 */
function credStudents_(c) {
  return Array.from(new Set([String(c.StudentId || '')].concat(String(c.StudentIds || '').split(/[,;\s]+/)).map(s => s.trim()).filter(Boolean)));
}
/** Tài khoản phụ huynh đang quản lý học sinh (ưu tiên tài khoản đang hoạt động). */
function parentCredOf_(studentId, includeInactive) {
  const list = readTable_('Credentials').filter(c => String(c.Type) === 'PARENT' && credStudents_(c).indexOf(String(studentId)) > -1);
  return list.find(c => truthy_(c.Active)) || (includeInactive ? list[0] : null) || null;
}
/** Các học sinh cùng phụ huynh (chung email hoặc chung SĐT), gồm cả chính học sinh. */
function familyStudents_(st) {
  const emails = new Set(emailList_(st.ParentEmail)), phone = phoneKey_(st.ParentPhone);
  return readTable_('Students').filter(s => String(s.StudentId) === String(st.StudentId) ||
    emailList_(s.ParentEmail).some(e => emails.has(e)) || (phone && phoneKey_(s.ParentPhone) === phone));
}
/** Tài khoản cấp lần đầu (sớm nhất, đang hoạt động) trong số tài khoản của anh chị em. */
function familyCred_(st) {
  const ids = new Set(familyStudents_(st).map(s => String(s.StudentId)).filter(id => id !== String(st.StudentId)));
  return readTable_('Credentials').filter(c => String(c.Type) === 'PARENT' && truthy_(c.Active) && credStudents_(c).some(id => ids.has(id)))
    .sort((a, b) => String(a.CreatedAt).localeCompare(String(b.CreatedAt)))[0] || null;
}
/**
 * Học sinh mà tài khoản phụ huynh được xem: các con đã gắn vào tài khoản + anh chị em đang học
 * (cùng SĐT/email phụ huynh) — kể cả khi con mới nhập học chưa được gắn/cấp tài khoản.
 */
function parentFamilyIds_(cred) {
  const linked = credStudents_(cred);
  const all = readTable_('Students');
  const out = linked.slice();
  all.filter(s => linked.indexOf(String(s.StudentId)) > -1).forEach(st => familyStudents_(st)
    .filter(isActiveStudent_)
    .sort((a, b) => String(normalizeDateText_(a.DOB) || '9999').localeCompare(String(normalizeDateText_(b.DOB) || '9999')))
    .forEach(s => { if (out.indexOf(String(s.StudentId)) < 0) out.push(String(s.StudentId)); }));
  return out;
}
/** Gắn thêm học sinh vào 1 tài khoản phụ huynh. Gọi trong khóa ghi. */
function linkStudentToCred_(cred, studentId) {
  const ids = credStudents_(cred);
  if (ids.indexOf(String(studentId)) > -1) return;
  const extra = ids.filter(id => id !== String(cred.StudentId)).concat([String(studentId)]);
  updateObjectById_('Credentials', 'Username', cred.Username, {StudentIds:extra.join(', '), UpdatedAt:new Date()});
}
function childNames_(cred) {
  const smap = Object.fromEntries(readTable_('Students').map(s => [String(s.StudentId), s]));
  return credStudents_(cred).map(id => smap[id]).filter(Boolean).map(s => s.FullName);
}
/** Tìm tài khoản phụ huynh theo tên đăng nhập; nếu không có thì theo MÃ HỌC SINH của bất kỳ con nào đã gắn vào tài khoản. */
function findParentCredByLogin_(login) {
  const l = String(login || '').trim().toLowerCase();
  const direct = readTable_('Credentials').find(c => String(c.Type) === 'PARENT' && String(c.Username).toLowerCase() === l);
  if (direct) return direct;
  const st = readTable_('Students').filter(s => String(s.StudentCode).trim().toLowerCase() === l);
  return st.length === 1 ? (parentCredOf_(st[0].StudentId) || familyCred_(st[0])) : null;
}
/**
 * Gộp các tài khoản phụ huynh của anh chị em vào TÀI KHOẢN CẤP LẦN ĐẦU. payload: {schoolId, apply, notify}
 * apply = false → chỉ xem trước. Tài khoản bị gộp được khóa (Active = FALSE), học sinh chuyển sang tài khoản giữ lại.
 */
function mergeFamilyAccounts(payload) {
  const user = requireCap_('manageParentAccounts');
  payload = payload || {};
  const sc = scope_(user, {schoolId:payload.schoolId});
  const creds = readTable_('Credentials').filter(c => String(c.Type) === 'PARENT' && truthy_(c.Active));
  const seen = new Set(), plans = [];
  sc.students.forEach(st => {
    if (seen.has(String(st.StudentId))) return;
    const fam = familyStudents_(st);
    fam.forEach(f => seen.add(String(f.StudentId)));
    const famIds = new Set(fam.map(f => String(f.StudentId)));
    const famCreds = creds.filter(c => credStudents_(c).some(id => famIds.has(id))).sort((a, b) => String(a.CreatedAt).localeCompare(String(b.CreatedAt)));
    if (famCreds.length < 2) return;
    plans.push({keep:String(famCreds[0].Username), merge:famCreds.slice(1).map(c => String(c.Username)),
      children:fam.map(f => f.FullName + ' (' + f.StudentCode + ')'), parent:fam[0].ParentName || '', email:emailList_(fam[0].ParentEmail).join(', ')});
  });
  if (!payload.apply) return {plans};
  withWriteLock_(() => {
    plans.forEach(p => {
      p.merge.forEach(u => {
        const other = readTable_('Credentials').find(c => String(c.Username) === u);
        credStudents_(other).forEach(id => linkStudentToCred_(readTable_('Credentials').find(c => String(c.Username) === p.keep), id));
        updateObjectById_('Credentials', 'Username', other.Username, {Active:false, UpdatedAt:new Date()});
      });
      audit_('MERGE_PARENT_ACCOUNTS', 'Credentials', p.keep, {merged:p.merge});
    });
  });
  if (payload.notify) plans.forEach(p => {
    if (!p.email) return;
    try {
      MailApp.sendEmail({to:p.email, name:APP.NAME, subject:'[' + APP.NAME + '] Gộp tài khoản phụ huynh',
        htmlBody:emailLogo_() + '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7">Kính gửi Quý phụ huynh <b>' + esc_(p.parent) + '</b>,<br>' +
          'Từ nay Quý phụ huynh dùng <b>một tài khoản</b> để xem tất cả các con: ' + esc_(p.children.join(', ')) + '.<br>' +
          '• Mã đăng nhập: <b>' + esc_(p.keep) + '</b> (có thể đăng nhập bằng mã học sinh của bất kỳ con nào)<br>• Mật khẩu: giữ nguyên mật khẩu của tài khoản này.<br>' +
          (appUrl_() ? 'Đăng nhập tại: <a href="' + esc_(appUrl_()) + '">' + esc_(appUrl_()) + '</a>. ' : '') + 'Nếu quên mật khẩu, bấm “Quên mật khẩu” trên trang đăng nhập.</div>'});
      p.notified = true;
    } catch (e) { p.notifyError = String(e.message || e); }
  });
  return {plans, merged:plans.length};
}


/** Tên đăng nhập của phụ huynh = mã học sinh; nếu mã trùng giữa các trường thì thêm hậu tố mã trường. */
function parentUsername_(st) {
  const base = String(st.StudentCode || st.StudentId).trim();
  const clash = readTable_('Students').some(s => String(s.StudentId) !== String(st.StudentId) && String(s.StudentCode).trim().toLowerCase() === base.toLowerCase());
  return clash ? base + '.' + String(st.SchoolId).slice(-4) : base;
}

/** Tạo/đặt lại tài khoản phụ huynh + gửi mật khẩu tạm. Trả về {username, sent:[kênh], errors:[...]} */
function issueParentAccount_(st, channels, reset, by, password) {
  let existing = parentCredOf_(st.StudentId);
  if (!existing) {
    // Anh/chị/em đã có tài khoản → gắn học sinh vào tài khoản cấp lần đầu của phụ huynh, không tạo tài khoản mới.
    const fam = familyCred_(st);
    if (fam) {
      withWriteLock_(() => linkStudentToCred_(fam, st.StudentId));
      existing = parentCredOf_(st.StudentId);
      if (!reset) return Object.assign(sendLinkedNotice_(st, existing, channels, by), {username:String(existing.Username), linked:true, children:childNames_(existing)});
    }
  }
  const username = existing ? String(existing.Username) : parentUsername_(st);
  if (existing && !reset) return {username, skipped:true, sent:[], errors:[], children:childNames_(existing)};
  const pw = password ? String(password) : randomPassword_();
  withWriteLock_(() => setCredential_(username, existing ? {} : {Type:'PARENT', StudentId:String(st.StudentId), UserEmail:''}, pw, true));
  const kids = existing ? childNames_(parentCredOf_(st.StudentId)) : [st.FullName];
  const school = readTable_('Schools').find(s => String(s.SchoolId) === String(st.SchoolId)) || {};
  const url = appUrl_();
  const sent = [], errors = [], logs = [];
  channels.forEach(ch => {
    const log = {NotificationId:nextId_('NTF'), SchoolId:st.SchoolId, StudentId:st.StudentId, InvoiceId:'', Channel:ch, Recipient:'',
      Subject:'Tài khoản phụ huynh', Message:'Cấp mật khẩu tạm (không lưu mật khẩu)', Status:'SENT', Error:'', SentAt:new Date(), CreatedBy:by.email};
    try {
      if (ch === 'EMAIL') {
        const to = emailList_(st.ParentEmail).join(',');
        log.Recipient = to;
        if (!to) throw new Error('Chưa có email phụ huynh.');
        MailApp.sendEmail({to, name:school.SchoolName || APP.NAME, subject:'[' + (school.SchoolName || APP.NAME) + '] Tài khoản tra cứu học phí của học sinh ' + st.FullName,
          htmlBody:emailLogo_() + '<div style="font-family:Arial,sans-serif;font-size:14px;color:#2d3a4a;line-height:1.7">Kính gửi Quý phụ huynh <b>' + esc_(st.ParentName || '') + '</b>,<br>' +
            'Nhà trường gửi tài khoản để Quý phụ huynh xem thông báo & chi tiết học phí, đăng ký suất ăn và mua đồ dùng cho ' + (kids.length > 1 ? 'các con: <b>' + esc_(kids.join(', ')) + '</b>' : 'học sinh <b>' + esc_(st.FullName) + '</b>') + ':<br>' +
            '• Mã đăng nhập: <b style="font-size:16px">' + esc_(username) + '</b><br>• Mật khẩu tạm: <b style="font-size:16px">' + esc_(pw) + '</b><br>' +
            (url ? '• Đăng nhập tại: <a href="' + esc_(url) + '">' + esc_(url) + '</a> (chọn “Phụ huynh”)<br>' : '') +
            'Lần đăng nhập đầu tiên, hệ thống sẽ yêu cầu Quý phụ huynh đặt mật khẩu mới. Vui lòng không chia sẻ mật khẩu cho người khác.</div>'});
      } else if (ch === 'SMS') {
        log.Recipient = normalizePhone_(st.ParentPhone);
        smsSendRaw_(log.Recipient, foldText_(school.SchoolName || APP.NAME).toUpperCase().slice(0, 30) + ': Tai khoan tra cuu hoc phi HS ' +
          foldText_(st.FullName).replace(/\b\w/g, c => c.toUpperCase()) + '. Ma dang nhap: ' + username + ', mat khau tam: ' + pw + (url ? '. Dang nhap: ' + url : '') + '. Doi mat khau o lan dau.');
      } else if (ch === 'ZALO') {
        log.Recipient = normalizePhone_(st.ParentPhone);
        znsSendRaw_(log.Recipient, getSetting_(st.SchoolId, 'ZNS_ACCOUNT_TEMPLATE_ID'),
          {student_name:st.FullName, student_code:String(st.StudentCode || ''), username, password:pw, url:url || '', school_name:school.SchoolName || ''}, 'ACC-' + st.StudentId);
      }
      sent.push(ch);
    } catch (e) { log.Status = 'FAILED'; log.Error = String(e.message || e).slice(0, 300); errors.push(ch + ': ' + log.Error); }
    log.Recipient = asText_(String(log.Recipient || ''));
    logs.push(log);
  });
  withWriteLock_(() => appendObjects_('Notifications', logs));
  return {username, sent, errors, children:kids};
}

/** Báo phụ huynh: tài khoản cũ nay xem được thêm con (không gửi mật khẩu). */
function sendLinkedNotice_(st, cred, channels, by) {
  const kids = childNames_(cred), url = appUrl_(), sent = [], errors = [], logs = [];
  const school = readTable_('Schools').find(s => String(s.SchoolId) === String(st.SchoolId)) || {};
  channels.filter(ch => ch !== 'ZALO').forEach(ch => {
    const log = {NotificationId:nextId_('NTF'), SchoolId:st.SchoolId, StudentId:st.StudentId, InvoiceId:'', Channel:ch, Recipient:'',
      Subject:'Tài khoản phụ huynh', Message:'Gắn vào tài khoản ' + cred.Username, Status:'SENT', Error:'', SentAt:new Date(), CreatedBy:by.email};
    try {
      if (ch === 'EMAIL') {
        log.Recipient = emailList_(st.ParentEmail).join(',');
        if (!log.Recipient) throw new Error('Chưa có email phụ huynh.');
        MailApp.sendEmail({to:log.Recipient, name:school.SchoolName || APP.NAME, subject:'[' + (school.SchoolName || APP.NAME) + '] Thêm học sinh ' + st.FullName + ' vào tài khoản phụ huynh',
          htmlBody:emailLogo_() + '<div style="font-family:Arial,sans-serif;font-size:14px;color:#2d3a4a;line-height:1.7">Kính gửi Quý phụ huynh <b>' + esc_(st.ParentName || '') + '</b>,<br>' +
            'Học sinh <b>' + esc_(st.FullName) + '</b> đã được thêm vào tài khoản phụ huynh hiện có của Quý phụ huynh. Từ nay một tài khoản xem được các con: <b>' + esc_(kids.join(', ')) + '</b>.<br>' +
            '• Mã đăng nhập: <b style="font-size:16px">' + esc_(cred.Username) + '</b> (hoặc mã học sinh của bất kỳ con nào)<br>• Mật khẩu: <b>giữ nguyên</b> mật khẩu Quý phụ huynh đang dùng.<br>' +
            (url ? '• Đăng nhập tại: <a href="' + esc_(url) + '">' + esc_(url) + '</a><br>' : '') + 'Nếu quên mật khẩu, bấm “Quên mật khẩu” trên trang đăng nhập.</div>'});
      } else if (ch === 'SMS') {
        log.Recipient = normalizePhone_(st.ParentPhone);
        smsSendRaw_(log.Recipient, foldText_(school.SchoolName || APP.NAME).toUpperCase().slice(0, 30) + ': HS ' + foldText_(st.FullName).replace(/\b\w/g, c => c.toUpperCase()) +
          ' da duoc them vao tai khoan phu huynh ' + cred.Username + '. Dung mat khau hien tai.' + (url ? ' ' + url : ''));
      }
      sent.push(ch);
    } catch (e) { log.Status = 'FAILED'; log.Error = String(e.message || e).slice(0, 300); errors.push(ch + ': ' + log.Error); }
    log.Recipient = asText_(String(log.Recipient || ''));
    logs.push(log);
  });
  withWriteLock_(() => appendObjects_('Notifications', logs));
  return {sent, errors};
}

/** Danh sách tài khoản phụ huynh theo trường / lớp. */
function listParentAccounts(params) {
  const user = requireCap_('manageParentAccounts');
  params = params || {};
  const sc = scope_(user, {schoolId:params.schoolId, classId:params.classId});
  const creds = {};
  readTable_('Credentials').forEach(c => { if (String(c.Type) === 'PARENT') credStudents_(c).forEach(id => { if (!creds[id] || truthy_(c.Active)) creds[id] = c; }); });
  return sc.students.filter(isActiveStudent_).map(s => {
    const own = creds[String(s.StudentId)];
    const c = own || familyCred_(s);
    return {shared: !own && !!c,studentId:String(s.StudentId), code:String(s.StudentCode || ''), name:s.FullName, className:(sc.classMap[String(s.ClassId)] || {}).ClassName || '',
      parentName:s.ParentName || '', email:emailList_(s.ParentEmail).join(', '), phone:normalizePhone_(s.ParentPhone),
      username: c ? String(c.Username) : '', active: c ? truthy_(c.Active) : false, mustChange: c ? truthy_(c.MustChange) : false,
      lastLogin: c && c.LastLogin ? String(c.LastLogin).slice(0, 16) : ''};
  }).sort((a,b) => (a.className + a.name).localeCompare(b.className + b.name, 'vi', {numeric:true}));
}

/** Cấp tài khoản hàng loạt. payload: {studentIds:[...], channels:['EMAIL','SMS','ZALO'], reset:false} */
function issueParentAccounts(payload) {
  const user = requireCap_('manageParentAccounts');
  const ids = (payload.studentIds || []).map(String);
  const channels = (payload.channels || []).map(c => String(c).toUpperCase()).filter(c => ['EMAIL','SMS','ZALO'].includes(c));
  if (!ids.length) throw new Error('Chọn học sinh.');
  if (!channels.length) throw new Error('Chọn ít nhất một kênh gửi mật khẩu.');
  const stu = Object.fromEntries(readTable_('Students').map(s => [String(s.StudentId), s]));
  const started = Date.now(), out = {created:0, skipped:0, errors:[], processed:0};
  for (const sid of ids) {
    if (Date.now() - started > 270000) break;
    const st = stu[sid];
    out.processed++;
    if (!st) continue;
    assertSchoolAccess_(user, st.SchoolId);
    const r = issueParentAccount_(st, channels, !!payload.reset, user);
    if (r.skipped) out.skipped++; else out.created++;
    if (r.errors.length) out.errors.push({name:st.FullName, username:r.username, errors:r.errors, sent:r.sent});
  }
  audit_('ISSUE_PARENT_ACCOUNTS','Credentials','',{count:out.created, channels, reset:!!payload.reset});
  return Object.assign(out, {remaining: ids.slice(out.processed)});
}

/** Mật khẩu do nhà trường đặt cho phụ huynh: tối thiểu 6 ký tự, không chứa khoảng trắng. */
function checkInitialPassword_(pw) {
  pw = String(pw || '');
  if (pw.length < 6) throw new Error('Mật khẩu phụ huynh cần ít nhất 6 ký tự.');
  if (/\s/.test(pw)) throw new Error('Mật khẩu không được chứa khoảng trắng.');
}

/** Thông tin tài khoản phụ huynh của 1 học sinh (hiển thị trong form Sửa hồ sơ). */
function parentAccountInfo_(studentId) {
  const c = parentCredOf_(studentId, true);
  const sent = readTable_('Notifications').filter(n => String(n.StudentId) === String(studentId) && n.Subject === 'Tài khoản phụ huynh')
    .sort((a,b) => String(b.SentAt).localeCompare(String(a.SentAt)))[0];
  return {username: c ? String(c.Username) : '', active: c ? truthy_(c.Active) : false, mustChange: c ? truthy_(c.MustChange) : false,
    siblings: c ? childNames_(c) : [],
    lastLogin: c && c.LastLogin ? String(c.LastLogin).slice(0, 16) : '',
    lastSend: sent ? {date:String(sent.SentAt).slice(0, 16), channel:sent.Channel, status:sent.Status, error:sent.Error || '', recipient:String(sent.Recipient || '')} : null};
}

/**
 * Gửi (lại) tài khoản đăng nhập cho phụ huynh của 1 học sinh. payload: {StudentId, password (tuỳ chọn), channels (mặc định ['EMAIL'])}
 * Đặt lại mật khẩu (mật khẩu nhập vào hoặc tự tạo) và gửi ngay; trả về kết quả từng kênh để hiển thị cho người dùng.
 */
function sendParentAccount(payload) {
  const user = requireCap_('manageParentAccounts');
  const st = readTable_('Students').find(s => String(s.StudentId) === String(payload.StudentId));
  if (!st) throw new Error('Không tìm thấy học sinh.');
  assertSchoolAccess_(user, st.SchoolId);
  if (payload.password) checkInitialPassword_(payload.password);
  const channels = (payload.channels && payload.channels.length ? payload.channels : ['EMAIL']).map(c => String(c).toUpperCase());
  if (channels.includes('EMAIL')) {
    const emails = emailList_(st.ParentEmail);
    if (!emails.length) throw new Error('Học sinh chưa có email phụ huynh. Nhập email trong hồ sơ rồi lưu trước.');
    emails.forEach(e => { if (!isValidEmail_(e)) throw new Error('Email phụ huynh không hợp lệ: "' + e + '". Sửa lại trong hồ sơ học sinh.'); });
  }
  const r = issueParentAccount_(st, channels, true, user, payload.password || '');
  audit_('SEND_PARENT_ACCOUNT', 'Credentials', r.username, {studentId:st.StudentId, sent:r.sent, errors:r.errors});
  return Object.assign(r, {email: emailList_(st.ParentEmail).join(', ')});
}

function setParentAccountActive(payload) {
  const user = requireCap_('manageParentAccounts');
  return withWriteLock_(() => {
    const c = parentCredOf_(payload.studentId, true);
    if (!c) throw new Error('Học sinh chưa có tài khoản.');
    const st = readTable_('Students').find(s => String(s.StudentId) === String(c.StudentId));
    if (st) assertSchoolAccess_(user, st.SchoolId);
    updateObjectById_('Credentials', 'Username', c.Username, {Active: !!payload.active});
    audit_(payload.active ? 'ACTIVATE' : 'DEACTIVATE', 'Credentials', c.Username, {});
    return {ok:true};
  });
}
