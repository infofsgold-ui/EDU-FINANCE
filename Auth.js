let CURRENT_USER_ = null;

/**
 * Xác định người dùng:
 *  1. Có dòng Active trong sheet Users → dùng Role/SchoolId ở đó.
 *  2. Không có nhưng email trùng Students.ParentEmail → tự nhận vai trò PARENT (chỉ xem con mình).
 */
function currentUser_() {
  if (CURRENT_USER_) return CURRENT_USER_;
  // Không có phiên đăng nhập của ứng dụng: chỉ chấp nhận chủ sở hữu script (chạy từ Editor / truy cập bằng chính tài khoản triển khai).
  // Khi web app chạy "Execute as: Me", người truy cập khác không có email ở đây → phải đăng nhập qua api().
  if (!isScriptOwner_()) throw new Error('AUTH_REQUIRED');
  const email = (Session.getActiveUser().getEmail() || '').toLowerCase().trim();
  if (!email) throw new Error('Không xác định được email đăng nhập. Hãy triển khai trong Google Workspace và kiểm tra cấu hình quyền truy cập.');
  if (email === 'admin@example.com') throw new Error('Tài khoản mẫu không được phép sử dụng.');
  const users = readTable_('Users');
  const user = users.find(u => String(u.UserEmail).toLowerCase().trim() === email && truthy_(u.Active));
  if (user) {
    if (!ROLES[user.Role]) throw new Error('Vai trò không hợp lệ trong sheet Users: ' + user.Role);
    CURRENT_USER_ = staffUser_(user, {email});
    return CURRENT_USER_;
  }
  const children = readTable_('Students').filter(s => emailList_(s.ParentEmail).includes(email));
  if (children.length) {
    // Phụ huynh có thể có con học ở nhiều trường trong hệ thống.
    const schoolIds = Array.from(new Set(children.map(c => String(c.SchoolId))));
    CURRENT_USER_ = { email, name: children[0].ParentName || email, role: 'PARENT', schoolId: schoolIds[0], schoolIds };
    return CURRENT_USER_;
  }
  throw new Error('Tài khoản chưa được cấp quyền trong sheet Users: ' + email);
}

/** Danh sách mã trường trong cột Users.SchoolIds (trường phụ trách thêm). */
function schoolIdList_(v) { return String(v || '').split(/[,;\s]+/).map(s => s.trim()).filter(s => s && s !== '*'); }

/**
 * Dựng đối tượng người dùng cán bộ từ 1 dòng Users.
 * - Vai trò cấp trường: phạm vi = SchoolId + các trường phụ trách thêm (SchoolIds).
 * - Vai trò toàn hệ thống: xem mọi trường; SchoolIds (nếu có) = các trường được giao phụ trách → dùng cho phân quyền chat.
 */
function staffUser_(u, extra) {
  const role = u.Role, primary = String(u.SchoolId || '');
  const more = schoolIdList_(u.SchoolIds);
  const o = Object.assign({email:String(u.UserEmail).toLowerCase().trim(), name:u.FullName || u.UserEmail, role, schoolId:primary}, extra || {});
  if (ROLES[role] && ROLES[role].group) o.assignedSchools = more;
  else if (more.length) o.schoolIds = Array.from(new Set([primary].concat(more).filter(Boolean)));
  return o;
}

function isScriptOwner_() {
  try {
    const a = (Session.getActiveUser().getEmail() || '').toLowerCase(), e = (Session.getEffectiveUser().getEmail() || '').toLowerCase();
    return !!a && a === e;
  } catch (err) { return false; }
}

/**
 * Kiểm tra định dạng email. Ngoài cú pháp cơ bản, chặn lỗi gõ dính 2 địa chỉ như "abc@gmail.comnguyen"
 * (đuôi .com/.vn/.org/.net/.edu bị dính thêm chữ phía sau).
 */
function isValidEmail_(e) {
  e = String(e || '').trim();
  if (!/^[^@\s,;]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$/.test(e)) return false;
  const tld = e.slice(e.lastIndexOf('.') + 1).toLowerCase();
  return !/^(com|vn|org|net|edu)[a-z]+$/.test(tld);
}

function emailList_(v) {
  return String(v || '').toLowerCase().split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
}

function can_(user, cap) { return (CAPS[cap] || []).includes(user.role); }

function requireCap_(cap) {
  const u = currentUser_();
  if (!can_(u, cap)) throw new Error('Bạn không có quyền thực hiện nghiệp vụ này.');
  return u;
}

function requireRole_(allowed) {
  const u = currentUser_();
  if (!allowed.includes(u.role)) throw new Error('Bạn không có quyền thực hiện nghiệp vụ này.');
  return u;
}

function isGroupWide_(user) { return !!(ROLES[user.role] && ROLES[user.role].group); }

function assertSchoolAccess_(user, schoolId) {
  if (isGroupWide_(user)) return;
  const allowed = user.schoolIds || [String(user.schoolId)];
  if (!allowed.includes(String(schoolId))) throw new Error('Bạn không có quyền truy cập dữ liệu trường này.');
}

/** Tập StudentId mà giáo viên / phụ huynh được xem; null = không giới hạn ở mức học sinh. */
function personalStudentSet_(user) {
  if (user.role === 'PARENT') {
    if (user.studentIds) return new Set(user.studentIds.map(String));
    return new Set(readTable_('Students').filter(s => emailList_(s.ParentEmail).includes(user.email)).map(s => String(s.StudentId)));
  }
  if (user.role === 'TEACHER') {
    const t = teacherClasses_(user);
    const classes = new Set(t.homeroom.concat(t.teaching));
    return new Set(readTable_('Students').filter(s => classes.has(String(s.ClassId))).map(s => String(s.StudentId)));
  }
  return null;
}

/**
 * Lớp của giáo viên: chủ nhiệm (Classes.HomeroomTeacher = email, hoặc họ tên như dữ liệu cũ)
 * và giảng dạy (email có trong Classes.TeacherEmails).
 */
function teacherClasses_(user) {
  const email = String(user.email).toLowerCase(), name = String(user.name || '').toLowerCase().trim();
  const homeroom = [], teaching = [];
  readTable_('Classes').forEach(c => {
    if ((user.schoolIds || [String(user.schoolId)]).indexOf(String(c.SchoolId)) < 0 || !truthy_(c.Active)) return;
    const hr = String(c.HomeroomTeacher || '').toLowerCase().trim();
    if (hr && (hr === email || hr === name)) homeroom.push(String(c.ClassId));
    else if (emailList_(c.TeacherEmails).includes(email)) teaching.push(String(c.ClassId));
  });
  return {homeroom, teaching};
}

function assertStudentAccess_(user, student) {
  assertSchoolAccess_(user, student.SchoolId);
  const set = personalStudentSet_(user);
  if (set && !set.has(String(student.StudentId))) throw new Error('Bạn không có quyền xem học sinh này.');
}

function getBootstrap() {
  const user = currentUser_();
  const schools = listSchoolsForUser_(user);
  const allowed = new Set(schools.map(s => String(s.SchoolId)));
  const personal = personalStudentSet_(user);
  let classes = readTable_('Classes').filter(c => truthy_(c.Active) && allowed.has(String(c.SchoolId)));
  if (personal) {
    const cls = new Set(readTable_('Students').filter(s => personal.has(String(s.StudentId))).map(s => String(s.ClassId)));
    classes = classes.filter(c => cls.has(String(c.ClassId)));
  }
  const schoolMap = Object.fromEntries(schools.map(s => [String(s.SchoolId), s]));
  const caps = {};
  Object.keys(CAPS).forEach(k => caps[k] = can_(user, k));
  return {
    appName: APP.NAME,
    version: APP.VERSION,
    user: Object.assign({roleLabel: ROLES[user.role].label, groupWide: isGroupWide_(user)}, user),
    schools: schools.map(s => Object.assign({}, s, {LevelCode: normalizeLevel_(s.Level)})),
    classes: classes.map(c => ({ClassId:c.ClassId, SchoolId:c.SchoolId, ClassName:c.ClassName, Grade:gradeOfClass_(c), SchoolYear:c.SchoolYear,
      HomeroomTeacher:c.HomeroomTeacher, Level: levelOfClass_(c, schoolMap[String(c.SchoolId)])})),
    feeTypes: personal ? [] : readTable_('FeeTypes').filter(x => truthy_(x.Active)),
    products: personal ? [] : readTable_('Products').filter(x => truthy_(x.Active)),
    warehouses: personal ? [] : readTable_('Warehouses').filter(w => truthy_(w.Active) && (!w.SchoolId || allowed.has(String(w.SchoolId)))),
    roles: Object.keys(ROLES).map(k => ({code:k, label:ROLES[k].label, group:ROLES[k].group})),
    levels: Object.keys(LEVELS).map(k => ({code:k, label:LEVELS[k]})),
    caps: caps,
    capMatrix: can_(user, 'manageUsers') ? CAPS : null,
    // Giữ tương thích bản 0.2
    capabilities: {
      canManageMaster: caps.manageMaster, canApprove: caps.approveExpense,
      canReceivePayment: caps.receivePayment, canManageStock: caps.manageStock
    }
  };
}

function listSchoolsForUser_(user) {
  return readTable_('Schools').filter(s => truthy_(s.Active) &&
    (isGroupWide_(user) || (user.schoolIds || [String(user.schoolId)]).includes(String(s.SchoolId))));
}

/** Chuẩn hoá cấp học về mã: MAM_NON / TIEU_HOC / THCS / THPT / LIEN_CAP. */
function normalizeLevel_(v) {
  const s = String(v || '').trim();
  if (LEVELS[s.toUpperCase()]) return s.toUpperCase();
  const t = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
  if (!t) return '';
  if (/lien cap|lien_cap|multi/.test(t)) return 'LIEN_CAP';
  if (/mam non|mau giao|nha tre|^mn$|kinder|pre/.test(t)) return 'MAM_NON';
  if (/tieu hoc|^th$|primary/.test(t)) return 'TIEU_HOC';
  if (/thcs|trung hoc co so|secondary|^cs$/.test(t)) return 'THCS';
  if (/thpt|trung hoc pho thong|high/.test(t)) return 'THPT';
  return '';
}

/** Cấp học của một lớp: theo khối (1-5 TH, 6-9 THCS, 10-12 THPT, chữ = mầm non), nếu không suy ra được thì lấy cấp của trường. */
/** Khối của lớp: cột Grade nếu là số/khối thật; nếu cột Grade ghi tên cấp học thì lấy số đầu tên lớp (1A1 → 1). */
function gradeOfClass_(cls) {
  const g = String((cls && cls.Grade) || '').trim();
  if (g && !normalizeLevel_(g)) return g;
  const m = String((cls && cls.ClassName) || '').trim().match(/^(?:l[ớo]p\s*)?(\d{1,2})/i);
  return m ? m[1] : '';
}

function levelOfClass_(cls, school) {
  const g = String((cls && cls.Grade) || '').trim();
  const n = parseInt(g, 10);
  if (!isNaN(n)) {
    if (n >= 1 && n <= 5) return 'TIEU_HOC';
    if (n >= 6 && n <= 9) return 'THCS';
    if (n >= 10 && n <= 12) return 'THPT';
    if (n === 0) return 'MAM_NON';
  } else if (g) {
    // Khối dạng chữ (Nhà trẻ, Mầm, Chồi, Lá...) được hiểu là mầm non, trừ khi ghi rõ tên cấp khác.
    return normalizeLevel_(g) || 'MAM_NON';
  }
  return normalizeLevel_(school && school.Level);
}
