/**
 * Quản lý người dùng (sheet Users).
 * - GROUP_ADMIN: quản lý mọi tài khoản.
 * - PRINCIPAL: chỉ quản lý tài khoản thuộc trường mình và chỉ cấp các vai trò cấp trường.
 * Phụ huynh không bắt buộc có tài khoản: email trong hồ sơ học sinh (ParentEmail) tự được nhận diện.
 */
function listUsers() {
  const user = requireCap_('manageUsers');
  const schools = Object.fromEntries(readTable_('Schools').map(s => [String(s.SchoolId), s.SchoolName]));
  return readTable_('Users')
    .filter(u => isGroupWide_(user) || (user.schoolIds || [user.schoolId]).some(sid => String(u.SchoolId) === String(sid) || schoolIdList_(u.SchoolIds).includes(String(sid))))
    .map(u => ({email:String(u.UserEmail).toLowerCase(), name:u.FullName, role:u.Role, roleLabel:(ROLES[u.Role]||{}).label || u.Role,
      classes: u.Role === 'TEACHER' ? teacherClasses_(staffUser_(u)) : null, schoolIds: schoolIdList_(u.SchoolIds),
      schoolId:String(u.SchoolId||''), school:u.SchoolId === '*' ? 'Toàn hệ thống' : (schools[String(u.SchoolId)] || ''),
      phone:String(u.Phone||''), active:truthy_(u.Active)}))
    .sort((a,b) => (a.school + a.role + a.name).localeCompare(b.school + b.role + b.name, 'vi'));
}

/** Thêm mới hoặc cập nhật theo email. */
function saveUser(payload) {
  const user = requireCap_('manageUsers');
  const email = String(payload.UserEmail || '').toLowerCase().trim();
  const role = String(payload.Role || '');
  let schoolId = String(payload.SchoolId || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Email không hợp lệ.');
  if (!ROLES[role]) throw new Error('Vai trò không hợp lệ.');
  if (ROLES[role].group) schoolId = '*';
  else if (!schoolId || schoolId === '*') throw new Error('Vai trò cấp trường cần chọn trường.');
  if (user.role !== 'GROUP_ADMIN') {
    if (ROLES[role].group) throw new Error('Chỉ Quản trị hệ thống được cấp vai trò toàn hệ thống.');
    assertSchoolAccess_(user, schoolId);
  }
  if (email === user.email && payload.Active === false) throw new Error('Không thể tự khóa tài khoản của chính mình.');
  const result = withWriteLock_(() => {
    const existing = readTable_('Users').find(u => String(u.UserEmail).toLowerCase().trim() === email);
    if (existing && user.role !== 'GROUP_ADMIN' && (ROLES[existing.Role]||{}).group) throw new Error('Không thể sửa tài khoản cấp hệ thống.');
    if (existing && user.role !== 'GROUP_ADMIN') assertSchoolAccess_(user, existing.SchoolId);
    const extra = (Array.isArray(payload.SchoolIds) ? payload.SchoolIds : schoolIdList_(payload.SchoolIds)).map(String).filter(x => x && x !== schoolId);
    extra.forEach(x => {
      if (!readTable_('Schools').some(s => String(s.SchoolId) === x)) throw new Error('Không tìm thấy trường: ' + x);
      if (user.role !== 'GROUP_ADMIN') assertSchoolAccess_(user, x);
    });
    const row = {FullName:String(payload.FullName||'').trim() || email, Role:role, SchoolId:schoolId, SchoolIds:extra.join(', '),
      Active: payload.Active === false || String(payload.Active) === 'false' ? false : true, Phone:asText_(String(payload.Phone||'').trim())};
    if (existing) updateObjectById_('Users','UserEmail', existing.UserEmail, row);
    else appendObject_('Users', Object.assign({UserEmail:email, CreatedAt:new Date()}, row));
    // Phân lớp cho giáo viên: chủ nhiệm (HomeroomTeacher = email) và giảng dạy (TeacherEmails).
    let classes = null;
    if (role === 'TEACHER' && (payload.HomeroomClassIds || payload.TeachingClassIds)) classes = assignTeacherClasses_(email, schoolId,
      (payload.HomeroomClassIds || []).map(String), (payload.TeachingClassIds || []).map(String), user, [schoolId].concat(extra));
    audit_(existing ? 'UPDATE' : 'CREATE', 'Users', email, {role, schoolId, active:row.Active, classes});
    return {ok:true, created:!existing, email};
  });
  if (payload.SendPassword === true || String(payload.SendPassword) === 'true') {
    try { sendStaffPassword_(email, String(payload.FullName || '').trim() || email); result.passwordSent = true; }
    catch (e) { result.passwordSent = false; result.passwordError = String(e.message || e); }
  }
  return result;
}

/** Gán lớp cho giáo viên trong trường: ghi đè đúng tập lớp đã chọn, gỡ khỏi các lớp bỏ chọn. Gọi trong khóa ghi. */
function assignTeacherClasses_(email, schoolId, homeroomIds, teachingIds, by, schoolList) {
  const inSchools = new Set((schoolList || [schoolId]).map(String));
  const hrSet = new Set(homeroomIds), tSet = new Set(teachingIds.filter(id => !homeroomIds.includes(id)));
  const patches = {};
  readTable_('Classes').filter(c => inSchools.has(String(c.SchoolId))).forEach(c => {
    const id = String(c.ClassId), hr = String(c.HomeroomTeacher || '').toLowerCase().trim();
    const others = emailList_(c.TeacherEmails).filter(e => e !== email);
    const patch = {};
    if (hrSet.has(id) && hr !== email) patch.HomeroomTeacher = email;
    if (!hrSet.has(id) && hr === email) patch.HomeroomTeacher = '';
    const want = tSet.has(id) ? others.concat([email]) : others;
    if (want.join(', ') !== emailList_(c.TeacherEmails).join(', ')) patch.TeacherEmails = want.join(', ');
    if (Object.keys(patch).length) patches[id] = patch;
  });
  [...hrSet, ...tSet].forEach(id => { if (!readTable_('Classes').some(c => String(c.ClassId) === id && inSchools.has(String(c.SchoolId)))) throw new Error('Lớp không thuộc trường của giáo viên: ' + id); });
  updateObjectsById_('Classes', 'ClassId', patches);
  return {homeroom:[...hrSet], teaching:[...tSet]};
}
