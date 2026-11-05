/**
 * NHẬP DỮ LIỆU TỪ FILE EXCEL (đọc file ở trình duyệt, gửi lên dạng mảng dòng {tên cột: giá trị}).
 * Hai bước: dryRun = true → kiểm tra, trả về lỗi/cảnh báo từng dòng; dryRun = false → ghi các dòng hợp lệ.
 *  - importStudents: đủ thông tin như form "Thêm học sinh" (lớp, phụ huynh, tài khoản phụ huynh, chính sách).
 *  - importExpenses: đủ thông tin như form "Ghi nhận khoản chi" + cấp học / khối / lớp.
 */

const IMPORT_MAX_ROWS_ = 2000;

/** Lấy giá trị theo tên cột (bỏ dấu, bỏ "*", không phân biệt hoa thường). aliases: danh sách tên cột chấp nhận. */
function importCell_(row, aliases) {
  const keys = Object.keys(row || {});
  const norm = s => foldText_(String(s)).toLowerCase().replace(/\*/g, '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
  for (const a of aliases) {
    const k = keys.find(x => norm(x) === norm(a));
    if (k !== undefined) return String(row[k] == null ? '' : row[k]).trim();
  }
  return '';
}

/** Ngày từ Excel: yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy hoặc số sê-ri. Trả về '' nếu trống, null nếu sai. */
function importDate_(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return normalizeDateText_(s.replace(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/, '$1-$2-$3')) || null;
}

function importMoney_(v) {
  const s = String(v || '').replace(/\s|đ|vnd|VND|₫/g, '');
  if (!s) return NaN;
  // "1.500.000" hoặc "1,500,000" → 1500000; "1500000.5" giữ phần thập phân
  const n = /^\d{1,3}([.,]\d{3})+$/.test(s) ? Number(s.replace(/[.,]/g, '')) : Number(s.replace(/,/g, ''));
  return n;
}

function importYes_(v, dflt) {
  const t = foldText_(String(v || '')).toLowerCase().trim();
  if (!t) return dflt;
  return /^(co|x|yes|y|true|1|gui)$/.test(t);
}

function importPhone_(v) {
  let s = String(v || '').replace(/[^\d+]/g, '');
  if (/^\d{9}$/.test(s)) s = '0' + s; // Excel làm mất số 0 đầu
  return s;
}

/** Trường theo mã hoặc tên trong phạm vi người dùng; trống → trường mặc định. */
function importSchool_(user, text, dflt) {
  const schools = listSchoolsForUser_(user);
  const t = foldText_(String(text || '')).toLowerCase().trim();
  if (!t) return schools.find(s => String(s.SchoolId) === String(dflt)) || null;
  return schools.find(s => foldText_(String(s.SchoolId)).toLowerCase() === t || foldText_(String(s.SchoolName)).toLowerCase().trim() === t) || null;
}

/** Lớp theo mã hoặc tên trong trường. */
function importClass_(schoolId, text) {
  const t = foldText_(String(text || '')).toLowerCase().replace(/^lop\s*/, '').trim();
  if (!t) return null;
  const list = readTable_('Classes').filter(c => String(c.SchoolId) === String(schoolId));
  return list.find(c => foldText_(String(c.ClassId)).toLowerCase() === t) ||
    list.find(c => foldText_(String(c.ClassName)).toLowerCase().replace(/^lop\s*/, '').trim() === t) || null;
}

const STUDENT_STATUS_IMPORT_ = {'dang hoc':'ACTIVE', 'active':'ACTIVE', 'bao luu':'RESERVED', 'reserved':'RESERVED', 'nghi hoc':'INACTIVE', 'inactive':'INACTIVE',
  'chuyen truong':'TRANSFERRED', 'transferred':'TRANSFERRED', 'tot nghiep':'GRADUATED', 'graduated':'GRADUATED'};

/**
 * payload: {schoolId (trường mặc định), rows:[{...}], dryRun}
 * Trả về {rows:[{row, name, code, school, className, errors[], warnings[]}], valid, invalid, created?, accounts?, pendingAccounts?}
 */
function importStudents(payload) {
  const user = requireCap_('manageStudents');
  const rows = (payload.rows || []).slice(0, IMPORT_MAX_ROWS_);
  if (!rows.length) throw new Error('File không có dòng dữ liệu nào.');
  const canPolicy = can_(user, 'managePolicy'), canAccount = can_(user, 'manageParentAccounts');
  const existing = readTable_('Students');
  const policies = readTable_('Discounts').filter(d => { const t = String(d.PolicyType || '').toUpperCase(); return POLICY_TYPES[t] && POLICY_TYPES[t].members && truthy_(d.Active); });
  const seenCodes = {};
  const checked = rows.map((r, i) => {
    const out = {row:i + 2, errors:[], warnings:[], data:null};
    const school = importSchool_(user, importCell_(r, ['Trường', 'Mã trường']), payload.schoolId);
    const name = importCell_(r, ['Họ và tên', 'Họ tên', 'Tên học sinh']);
    const code = importCell_(r, ['Mã học sinh', 'Mã HS']);
    out.name = name; out.code = code;
    if (!school) { out.errors.push('Không tìm thấy trường "' + importCell_(r, ['Trường', 'Mã trường']) + '" (hoặc không có quyền)'); return out; }
    out.school = school.SchoolName;
    if (!name) out.errors.push('Thiếu họ và tên');
    const clsText = importCell_(r, ['Lớp', 'Mã lớp', 'Tên lớp']);
    const cls = importClass_(school.SchoolId, clsText);
    if (!clsText) out.errors.push('Thiếu lớp'); else if (!cls) out.errors.push('Không có lớp "' + clsText + '" trong ' + school.SchoolName);
    out.className = cls ? cls.ClassName : clsText;
    if (code) {
      const key = school.SchoolId + '|' + code.toLowerCase();
      if (existing.some(s => String(s.SchoolId) === String(school.SchoolId) && String(s.StudentCode).trim().toLowerCase() === code.toLowerCase()))
        out.errors.push('Mã học sinh "' + code + '" đã có trong trường');
      else if (seenCodes[key]) out.errors.push('Mã học sinh "' + code + '" trùng với dòng ' + seenCodes[key]);
      else seenCodes[key] = out.row;
    }
    const dates = {};
    [['DOB', ['Ngày sinh']], ['EnrollmentDate', ['Ngày nhập học']], ['LeaveDate', ['Ngày nghỉ học', 'Ngày nghỉ học / chuyển trường']]].forEach(([k, al]) => {
      const raw = importCell_(r, al), d = importDate_(raw);
      if (d === null) out.errors.push(al[0] + ' "' + raw + '" không hợp lệ (dùng dd/mm/yyyy)'); else dates[k] = d;
    });
    const gRaw = foldText_(importCell_(r, ['Giới tính'])).toLowerCase();
    const gender = !gRaw ? '' : /^(nam|male|m)$/.test(gRaw) ? 'Nam' : /^(nu|female|f)$/.test(gRaw) ? 'Nữ' : null;
    if (gender === null) out.errors.push('Giới tính phải là Nam hoặc Nữ');
    const stRaw = foldText_(importCell_(r, ['Trạng thái'])).toLowerCase().trim();
    const status = stRaw ? STUDENT_STATUS_IMPORT_[stRaw] : 'ACTIVE';
    if (!status) out.errors.push('Trạng thái "' + importCell_(r, ['Trạng thái']) + '" không hợp lệ');
    let email = importCell_(r, ['Email phụ huynh', 'Email']);
    try { email = cleanParentEmails_(email); } catch (e) { out.errors.push(String(e.message || e)); }
    const phone = importPhone_(importCell_(r, ['SĐT phụ huynh', 'Số điện thoại', 'SĐT']));
    if (phone && !normalizePhone_(phone)) out.warnings.push('SĐT "' + phone + '" có thể sai (Zalo/SMS không gửi được)');
    const password = importCell_(r, ['Mật khẩu phụ huynh', 'Mật khẩu']);
    if (password) { try { checkInitialPassword_(password); } catch (e) { out.errors.push(String(e.message || e)); } }
    const send = importYes_(importCell_(r, ['Gửi email tài khoản', 'Gửi tài khoản']), true);
    // Có mật khẩu → luôn tạo tài khoản; "Gửi email tài khoản" chỉ quyết định có gửi email hay không.
    const wantAccount = canAccount && !!(email || password) && (send || !!password);
    if (!canAccount && (email || password)) out.warnings.push('Bạn không có quyền cấp tài khoản phụ huynh — chỉ lưu thông tin');
    if (send && !email && password) out.warnings.push('Không có email: tạo tài khoản nhưng không gửi được mật khẩu');
    const polNames = importCell_(r, ['Chính sách', 'Chính sách giá / hỗ trợ']).split(/[;\n]+/).map(s => s.trim()).filter(Boolean);
    const polIds = [];
    polNames.forEach(pn => {
      const f = foldText_(pn).toLowerCase();
      const d = policies.find(p => String(p.DiscountId).toLowerCase() === pn.toLowerCase() || foldText_(String(p.Name)).toLowerCase().trim() === f);
      if (!d) out.errors.push('Không tìm thấy chính sách cần ghi danh "' + pn + '"');
      else if (d.SchoolId && d.SchoolId !== '*' && String(d.SchoolId) !== String(school.SchoolId)) out.errors.push('Chính sách "' + pn + '" không áp dụng cho ' + school.SchoolName);
      else polIds.push(String(d.DiscountId));
    });
    if (polIds.length && !canPolicy) { out.warnings.push('Bạn không có quyền ghi danh chính sách — bỏ qua cột Chính sách'); polIds.length = 0; }
    if (name && dates.DOB && existing.some(s => String(s.SchoolId) === String(school.SchoolId) && foldText_(s.FullName).toLowerCase() === foldText_(name).toLowerCase() && normalizeDateText_(s.DOB) === dates.DOB))
      out.warnings.push('Đã có học sinh cùng tên và ngày sinh trong trường — kiểm tra trùng');
    out.data = {SchoolId:String(school.SchoolId), ClassId:cls ? String(cls.ClassId) : '', StudentCode:code, FullName:name, Gender:gender || '', DOB:dates.DOB || '',
      EnrollmentDate:dates.EnrollmentDate || '', LeaveDate:dates.LeaveDate || '', Status:status || 'ACTIVE', Address:importCell_(r, ['Địa chỉ']),
      ParentName:importCell_(r, ['Phụ huynh', 'Tên phụ huynh', 'Họ tên phụ huynh']), ParentPhone:phone, ParentEmail:email, Notes:importCell_(r, ['Ghi chú']),
      password, send, wantAccount, polIds, polNote:importCell_(r, ['Ghi chú chính sách'])};
    return out;
  });
  const valid = checked.filter(c => !c.errors.length && c.data);
  const view = c => ({row:c.row, name:c.name, code:c.code, school:c.school || '', className:c.className || '', errors:c.errors, warnings:c.warnings,
    account:!!(c.data && c.data.wantAccount), policies:c.data ? c.data.polIds.length : 0});
  const result = {rows:checked.map(view), valid:valid.length, invalid:checked.length - valid.length};
  if (payload.dryRun !== false || !valid.length) return result;

  // Ghi học sinh trong một khóa ghi.
  const created = withWriteLock_(() => {
    const now = new Date(), objs = [];
    const codes = new Set(readTable_('Students').map(s => s.SchoolId + '|' + String(s.StudentCode).trim().toLowerCase()));
    valid.forEach(c => {
      const d = c.data, id = nextId_('STU');
      const code = d.StudentCode || id;
      if (codes.has(d.SchoolId + '|' + code.toLowerCase())) { c.errors.push('Mã học sinh vừa bị trùng'); return; }
      codes.add(d.SchoolId + '|' + code.toLowerCase());
      c.studentId = id;
      objs.push({StudentId:id, SchoolId:d.SchoolId, ClassId:d.ClassId, StudentCode:asText_(code), FullName:d.FullName, DOB:d.DOB,
        EnrollmentDate:d.EnrollmentDate, Status:d.Status, ParentName:d.ParentName, ParentPhone:asText_(d.ParentPhone), Notes:d.Notes,
        CreatedAt:now, CreatedBy:user.email, Gender:d.Gender, Address:d.Address, ParentEmail:d.ParentEmail.toLowerCase(), LeaveDate:d.LeaveDate});
    });
    appendObjects_('Students', objs);
    audit_('IMPORT','Students','',{count:objs.length});
    return objs.length;
  });
  const done = valid.filter(c => c.studentId);
  // Ghi danh chính sách: gom theo chính sách + ghi chú.
  const byPol = {};
  done.forEach(c => c.data.polIds.forEach(pid => { const k = pid + '|' + c.data.polNote; (byPol[k] = byPol[k] || {pid, note:c.data.polNote, ids:[]}).ids.push(c.studentId); }));
  let polAdded = 0;
  Object.values(byPol).forEach(g => { try { polAdded += addPolicyMembers({DiscountId:g.pid, StudentIds:g.ids, Note:g.note}).added; } catch (e) { result.policyError = String(e.message || e); } });
  // Tài khoản phụ huynh: tạo/gửi trong giới hạn thời gian, phần còn lại trả về để giao diện gọi tiếp.
  const accounts = done.filter(c => c.data.wantAccount).map(c => ({studentId:c.studentId, password:c.data.password, send:c.data.send}));
  const acc = importStudentAccounts_({items:accounts}, user);
  return Object.assign(result, {created, policyMembers:polAdded, accounts:acc,
    rows:checked.map(c => Object.assign(view(c), {studentId:c.studentId || ''}))});
}

/** Tiếp tục cấp tài khoản phụ huynh sau khi nhập file. payload: {items:[{studentId, password, send}]} */
function importStudentAccounts(payload) {
  const user = requireCap_('manageParentAccounts');
  return importStudentAccounts_(payload, user);
}

function importStudentAccounts_(payload, user) {
  const items = payload.items || [];
  const out = {created:0, sent:0, errors:[], remaining:[]};
  if (!items.length || !can_(user, 'manageParentAccounts')) return out;
  const started = Date.now();
  const stu = Object.fromEntries(readTable_('Students').map(s => [String(s.StudentId), s]));
  for (let i = 0; i < items.length; i++) {
    if (Date.now() - started > 240000) { out.remaining = items.slice(i); break; }
    const it = items[i], st = stu[String(it.studentId)];
    if (!st) continue;
    assertSchoolAccess_(user, st.SchoolId);
    try {
      const email = emailList_(st.ParentEmail).length > 0;
      const r = issueParentAccount_(st, it.send && email ? ['EMAIL'] : [], true, user, it.password || '');
      out.created++;
      if (r.sent && r.sent.length) out.sent++;
      if (r.errors && r.errors.length) out.errors.push({name:st.FullName, error:r.errors.join(' · ')});
    } catch (e) { out.errors.push({name:st.FullName, error:String(e.message || e)}); }
  }
  return out;
}

/**
 * payload: {schoolId (mặc định), rows:[{...}], dryRun}
 * Cột: Trường, Ngày chi*, Hạng mục, Số tiền*, Nhà cung cấp, Diễn giải, Cấp học, Khối, Lớp
 */
function importExpenses(payload) {
  const user = requireCap_('recordExpense');
  const rows = (payload.rows || []).slice(0, IMPORT_MAX_ROWS_);
  if (!rows.length) throw new Error('File không có dòng dữ liệu nào.');
  const cats = EXPENSE_CATEGORIES;
  const checked = rows.map((r, i) => {
    const out = {row:i + 2, errors:[], warnings:[], data:null};
    const schoolText = importCell_(r, ['Trường', 'Mã trường']);
    const school = importSchool_(user, schoolText, payload.schoolId);
    if (!school) { out.errors.push('Không tìm thấy trường "' + schoolText + '" (hoặc không có quyền)'); return out; }
    out.school = school.SchoolName;
    const dRaw = importCell_(r, ['Ngày chi', 'Ngày']), date = importDate_(dRaw);
    if (!dRaw) out.errors.push('Thiếu ngày chi'); else if (date === null) out.errors.push('Ngày chi "' + dRaw + '" không hợp lệ (dùng dd/mm/yyyy)');
    const aRaw = importCell_(r, ['Số tiền', 'Số tiền (VND)']), amount = importMoney_(aRaw);
    if (!(amount > 0)) out.errors.push('Số tiền "' + aRaw + '" không hợp lệ');
    const cRaw = importCell_(r, ['Hạng mục', 'Danh mục']);
    let category = cats.find(c => foldText_(c).toLowerCase() === foldText_(cRaw).toLowerCase()) || '';
    if (!cRaw) category = 'Khác';
    else if (!category) { category = cRaw; out.warnings.push('Hạng mục "' + cRaw + '" ngoài danh sách chuẩn — vẫn lưu theo tên này'); }
    const clsText = importCell_(r, ['Lớp', 'Mã lớp']);
    const cls = clsText ? importClass_(school.SchoolId, clsText) : null;
    if (clsText && !cls) out.errors.push('Không có lớp "' + clsText + '" trong ' + school.SchoolName);
    const lvRaw = importCell_(r, ['Cấp học', 'Cấp']);
    let level = lvRaw ? normalizeLevel_(lvRaw) : '';
    if (lvRaw && !level) out.errors.push('Cấp học "' + lvRaw + '" không hợp lệ');
    let grade = importCell_(r, ['Khối', 'Khối học']).replace(/^kh[oố]i\s*/i, '');
    if (cls) {
      const cg = gradeOfClass_(cls), cl = levelOfClass_(cls, school);
      if (grade && cg && grade !== cg) out.warnings.push('Khối ' + grade + ' khác khối của lớp ' + cls.ClassName + ' (' + cg + ') — dùng khối của lớp');
      grade = cg || grade;
      if (level && cl && level !== cl) out.warnings.push('Cấp học khác cấp của lớp — dùng cấp của lớp');
      level = cl || level;
    }
    out.date = date || dRaw; out.amount = amount; out.category = category; out.className = cls ? cls.ClassName : ''; out.grade = grade;
    out.data = {SchoolId:String(school.SchoolId), ExpenseDate:date || '', Category:category, Vendor:importCell_(r, ['Nhà cung cấp', 'Nhà cung cấp / người nhận', 'Người nhận']),
      Description:importCell_(r, ['Diễn giải', 'Nội dung']), Amount:roundMoney_(amount), Level:level, Grade:grade, ClassId:cls ? String(cls.ClassId) : ''};
    return out;
  });
  const valid = checked.filter(c => !c.errors.length && c.data);
  const result = {rows:checked.map(c => ({row:c.row, school:c.school || '', date:c.date || '', category:c.category || '', amount:c.amount || 0,
      className:c.className || '', grade:c.grade || '', errors:c.errors, warnings:c.warnings})),
    valid:valid.length, invalid:checked.length - valid.length, total:roundMoney_(valid.reduce((t, c) => t + c.data.Amount, 0))};
  if (payload.dryRun !== false || !valid.length) return result;
  valid.forEach(c => assertSchoolAccess_(user, c.data.SchoolId));
  const autoApprove = can_(user, 'approveExpense');
  return withWriteLock_(() => {
    const now = new Date();
    const objs = valid.map(c => Object.assign({ExpenseId:nextId_('EXP')}, c.data, {BudgetPeriod:asText_(c.data.ExpenseDate.slice(0, 7)),
      Status:autoApprove ? 'APPROVED' : 'PENDING', ApprovedBy:autoApprove ? user.email : '', CreatedAt:now, CreatedBy:user.email, Grade:asText_(c.data.Grade)}));
    appendObjects_('Expenses', objs);
    audit_('IMPORT','Expenses','',{count:objs.length, total:result.total});
    return Object.assign(result, {created:objs.length, status:autoApprove ? 'APPROVED' : 'PENDING'});
  });
}

/** Dữ liệu cho file mẫu: trường, lớp, chính sách cần ghi danh, hạng mục chi trong phạm vi người dùng. */
function getImportTemplateInfo(params) {
  const user = currentUser_();
  const kind = String((params && params.kind) || 'students');
  if (kind === 'students') requireCap_('manageStudents'); else requireCap_('recordExpense');
  const schools = listSchoolsForUser_(user);
  const allowed = new Set(schools.map(s => String(s.SchoolId)));
  const smap = Object.fromEntries(schools.map(s => [String(s.SchoolId), s]));
  const classes = readTable_('Classes').filter(c => allowed.has(String(c.SchoolId)) && (c.Active === '' || c.Active === undefined || truthy_(c.Active)))
    .map(c => ({school:smap[String(c.SchoolId)].SchoolName, schoolId:String(c.SchoolId), className:c.ClassName, classId:String(c.ClassId), grade:gradeOfClass_(c),
      level:LEVELS[levelOfClass_(c, smap[String(c.SchoolId)])] || ''}))
    .sort((a, b) => (a.school + a.className).localeCompare(b.school + b.className, 'vi', {numeric:true}));
  const policies = kind === 'students' && can_(user, 'managePolicy') ? readTable_('Discounts').filter(d => {
    const t = String(d.PolicyType || '').toUpperCase();
    return POLICY_TYPES[t] && POLICY_TYPES[t].members && truthy_(d.Active) && (!d.SchoolId || d.SchoolId === '*' || allowed.has(String(d.SchoolId)));
  }).map(d => ({name:d.Name, school:!d.SchoolId || d.SchoolId === '*' ? 'Mọi trường' : (smap[String(d.SchoolId)] || {}).SchoolName || '', type:POLICY_TYPES[String(d.PolicyType).toUpperCase()].label})) : [];
  return {schools:schools.map(s => ({id:String(s.SchoolId), name:s.SchoolName})), classes, policies, categories:EXPENSE_CATEGORIES,
    levels:Object.keys(LEVELS).filter(k => k !== 'LIEN_CAP').map(k => LEVELS[k])};
}
