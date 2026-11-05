/**
 * CHÍNH SÁCH GIÁ / HỖ TRỢ HỌC PHÍ (sheet Discounts + PolicyMembers + Attachments).
 *
 * Nhóm chính sách (PolicyType):
 *  - SCHOOL       Toàn trường / theo cấp học, khối, lớp — tự áp dụng cho mọi học sinh khớp phạm vi.
 *  - SIBLING      Anh chị em ruột — nhận diện theo SĐT/email phụ huynh, xếp thứ tự theo ngày sinh (con lớn nhất = con thứ 1).
 *                 MinChildOrder = 1: mọi con khi gia đình có ≥ 2 con; = N ≥ 2: từ con thứ N trở đi.
 *                 SiblingScope = SCHOOL (mặc định): chỉ tính anh chị em cùng trường; SYSTEM: tính cả các trường trong hệ thống.
 *  - PREPAY_TERM  Đóng trước 1 học kỳ — áp dụng cho học sinh được ghi danh vào chính sách.
 *  - PREPAY_YEAR  Đóng trước 1 năm học — như trên.
 *  - STAFF_CHILD  Con cán bộ, giáo viên, nhân viên — ghi danh từng học sinh.
 *  - STUDENT      Hỗ trợ riêng từng học sinh (học bổng, hoàn cảnh khó khăn, đối tượng chính sách...) — ghi danh.
 *  - OTHER        Chính sách tự tạo khác — ghi danh.
 * Chính sách không có PolicyType (dữ liệu bản cũ) giữ cách áp dụng cũ: lọc theo StudentId/ClassId nếu có.
 *
 * Cộng dồn: các chính sách Stackable = TRUE được cộng với nhau; chính sách Stackable = FALSE không cộng dồn —
 * học sinh được hưởng mức có lợi nhất giữa (tổng các chính sách cộng dồn) và (từng chính sách không cộng dồn).
 * MaxAmount: mức giảm tối đa cho mỗi dòng phí (0 = không giới hạn).
 */

const POLICY_TYPES = {
  SCHOOL:      {label:'Toàn trường / theo cấp, khối, lớp', members:false},
  SIBLING:     {label:'Anh chị em ruột', members:false},
  PREPAY_TERM: {label:'Đóng trước 1 học kỳ', members:true},
  PREPAY_YEAR: {label:'Đóng trước 1 năm học', members:true},
  STAFF_CHILD: {label:'Con cán bộ, giáo viên, nhân viên', members:true},
  STUDENT:     {label:'Hỗ trợ từng học sinh (học bổng, hoàn cảnh...)', members:true},
  OTHER:       {label:'Chính sách khác (tự tạo)', members:true}
};

/**
 * Nhóm anh chị em đang học: theo SĐT phụ huynh (9 số cuối), thiếu SĐT thì theo email đầu tiên.
 * schoolId = null → toàn hệ thống. Xếp theo ngày sinh (lớn trước), trùng ngày sinh thì theo mã.
 * Trả về {order:{studentId: thứ tự}, size:{studentId: số con}, groups:[[student...]]}
 */
function siblingFamilies_(schoolId) {
  const fam = {};
  readTable_('Students').filter(s => isActiveStudent_(s) && (!schoolId || String(s.SchoolId) === String(schoolId))).forEach(s => {
    const k = phoneKey_(s.ParentPhone) || emailList_(s.ParentEmail)[0];
    if (k) (fam[k] = fam[k] || []).push(s);
  });
  const order = {}, size = {}, groups = [];
  Object.values(fam).forEach(list => {
    list.sort((a, b) => String(normalizeDateText_(a.DOB) || '9999').localeCompare(String(normalizeDateText_(b.DOB) || '9999')) || String(a.StudentId).localeCompare(String(b.StudentId)));
    list.forEach((s, i) => { order[String(s.StudentId)] = i + 1; size[String(s.StudentId)] = list.length; });
    if (list.length > 1) groups.push(list);
  });
  return {order, size, groups};
}

function policyApproved_(d) { return !truthy_(d.ApprovalRequired) || String(d.ApprovedBy || '').trim() !== ''; }
function feeTypeList_(v) { return String(v || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean); }
function phoneKey_(p) { const s = String(p || '').replace(/\D/g, ''); return s.length >= 9 ? s.slice(-9) : ''; }

/** Chuẩn bị dữ liệu chính sách cho một trường + kỳ (gọi một lần mỗi lần tính phí). */
function discountContext_(schoolId, range) {
  const discounts = readTable_('Discounts').filter(d => truthy_(d.Active) && policyApproved_(d) &&
    (!d.SchoolId || d.SchoolId === '*' || String(d.SchoolId) === String(schoolId)) && overlaps_(range, d.ValidFrom, d.ValidTo));
  const ids = new Set(discounts.map(d => String(d.DiscountId)));
  const members = {};
  readTable_('PolicyMembers').forEach(m => {
    if (!ids.has(String(m.DiscountId)) || !truthy_(m.Active) || !overlaps_(range, m.ValidFrom, m.ValidTo)) return;
    (members[m.DiscountId] = members[m.DiscountId] || new Set()).add(String(m.StudentId));
  });
  // Thứ tự con trong gia đình (2 phạm vi): toàn hệ thống / cùng trường.
  const sibling = {SYSTEM: siblingFamilies_(null), SCHOOL: siblingFamilies_(schoolId)};
  return {discounts, members, sibling};
}

/** Tính mức giảm của một dòng phí. Trả về {amount, note} — note liệt kê tên chính sách đã áp dụng. */
function matchDiscounts_(ctx, student, cls, level, feeTypeId, gross) {
  const sid = String(student.StudentId);
  const applied = [];
  ctx.discounts.forEach(d => {
    const fees = feeTypeList_(d.FeeTypeId);
    if (fees.length && !fees.includes(String(feeTypeId))) return;
    if (d.ClassId && String(d.ClassId) !== String(student.ClassId)) return;
    if (d.Level && String(d.Level) !== String(level)) return;
    if (d.Grade && String(d.Grade) !== String((cls && cls.Grade) || '')) return;
    if (d.StudentId && String(d.StudentId) !== sid) return;
    const type = String(d.PolicyType || '').toUpperCase();
    if (POLICY_TYPES[type] && POLICY_TYPES[type].members && !(ctx.members[d.DiscountId] && ctx.members[d.DiscountId].has(sid))) return;
    if (type === 'SIBLING') {
      const fam = ctx.sibling[String(d.SiblingScope || 'SCHOOL').toUpperCase() === 'SYSTEM' ? 'SYSTEM' : 'SCHOOL'];
      const order = fam.order[sid] || 1, size = fam.size[sid] || 1, min = Number(d.MinChildOrder || 2);
      if (size < 2 || order < Math.max(1, min)) return;
    }
    const method = String(d.Method || '').toUpperCase(), v = Number(d.Value || 0);
    let amt = method === 'PERCENT' ? gross * Math.min(Math.max(v,0),100) / 100 : (method === 'FIXED' || method === 'AMOUNT') ? Math.max(v,0) : 0;
    if (Number(d.MaxAmount) > 0) amt = Math.min(amt, Number(d.MaxAmount));
    amt = roundMoney_(Math.min(amt, gross));
    // Dữ liệu cũ (chưa có cột Stackable) mặc định cộng dồn như trước.
    if (amt > 0) applied.push({name:d.Name, amt, stack: d.Stackable === '' || d.Stackable === undefined || truthy_(d.Stackable)});
  });
  if (!applied.length) return {amount:0, note:''};
  const stack = applied.filter(a => a.stack), sumStack = Math.min(gross, stack.reduce((s,a) => s + a.amt, 0));
  const bestSolo = applied.filter(a => !a.stack).sort((a,b) => b.amt - a.amt)[0];
  const chosen = bestSolo && bestSolo.amt > sumStack ? [bestSolo] : stack;
  const amount = roundMoney_(Math.min(gross, chosen.reduce((s,a) => s + a.amt, 0)));
  return {amount, note: chosen.map(a => a.name).join('; ')};
}

// ===================== QUẢN LÝ CHÍNH SÁCH =====================

function listPolicies(params) {
  const user = requireCap_('managePolicy');
  params = params || {};
  const allowed = new Set(listSchoolsForUser_(user).map(s => String(s.SchoolId)));
  const smap = Object.fromEntries(readTable_('Schools').map(s => [String(s.SchoolId), s.SchoolName]));
  const fmap = Object.fromEntries(readTable_('FeeTypes').map(f => [String(f.FeeTypeId), f.FeeName]));
  const cmap = Object.fromEntries(readTable_('Classes').map(c => [String(c.ClassId), c.ClassName]));
  const memberCount = {}, docCount = {};
  readTable_('PolicyMembers').forEach(m => { if (truthy_(m.Active)) memberCount[m.DiscountId] = (memberCount[m.DiscountId]||0) + 1; });
  readTable_('Attachments').forEach(a => { if (a.Entity === 'Discounts') docCount[a.EntityId] = (docCount[a.EntityId]||0) + 1; });
  return {
    types: Object.keys(POLICY_TYPES).map(k => ({code:k, label:POLICY_TYPES[k].label, members:POLICY_TYPES[k].members})),
    rows: readTable_('Discounts').filter(d => {
      const sid = String(d.SchoolId || '*');
      if (sid === '*') return true;
      if (!allowed.has(sid)) return false;
      return !params.schoolId || sid === String(params.schoolId);
    }).map(d => policyView_(d, smap, fmap, cmap, memberCount, docCount))
      .sort((a,b) => (a.status === 'PENDING' ? 0 : 1) - (b.status === 'PENDING' ? 0 : 1) || String(b.createdAt).localeCompare(String(a.createdAt)))
  };
}

function policyView_(d, smap, fmap, cmap, memberCount, docCount) {
  const type = String(d.PolicyType || '').toUpperCase() || 'LEGACY';
  const fees = feeTypeList_(d.FeeTypeId);
  const scope = [];
  if (d.Level) scope.push(LEVELS[d.Level] || d.Level);
  if (d.Grade) scope.push('Khối ' + d.Grade);
  if (d.ClassId) scope.push('Lớp ' + (cmap[String(d.ClassId)] || d.ClassId));
  return {
    id:d.DiscountId, name:d.Name, type, typeLabel:(POLICY_TYPES[type] || {label:'Miễn giảm (bản cũ)'}).label,
    needsMembers: !!(POLICY_TYPES[type] && POLICY_TYPES[type].members),
    schoolId:String(d.SchoolId || '*'), school: !d.SchoolId || d.SchoolId === '*' ? 'Mọi trường' : (smap[String(d.SchoolId)] || d.SchoolId),
    method:String(d.Method || '').toUpperCase(), value:Number(d.Value || 0), maxAmount:Number(d.MaxAmount || 0),
    feeTypeIds:fees, fees: fees.length ? fees.map(f => fmap[f] || f).join(', ') : 'Mọi khoản phí',
    level:String(d.Level || ''), grade:String(d.Grade || ''), classId:String(d.ClassId || ''), scope: scope.join(' · ') || 'Toàn trường',
    validFrom:String(d.ValidFrom || '').slice(0,10), validTo:String(d.ValidTo || '').slice(0,10),
    stackable: d.Stackable === '' || d.Stackable === undefined || truthy_(d.Stackable), minChildOrder:Number(d.MinChildOrder || 2),
    siblingScope: String(d.SiblingScope || 'SCHOOL').toUpperCase() === 'SYSTEM' ? 'SYSTEM' : 'SCHOOL',
    description:d.Description || '', active:truthy_(d.Active), approvedBy:d.ApprovedBy || '', approvedAt:String(d.ApprovedAt || ''),
    status: !truthy_(d.Active) ? 'INACTIVE' : policyApproved_(d) ? 'APPROVED' : 'PENDING',
    createdAt:String(d.CreatedAt || ''), createdBy:d.CreatedBy || '',
    memberCount: (memberCount || {})[d.DiscountId] || 0, docCount: (docCount || {})[d.DiscountId] || 0
  };
}

function assertPolicyScope_(user, schoolId) {
  if (schoolId === '*' || !schoolId) { if (!isGroupWide_(user)) throw new Error('Chỉ cấp tập đoàn được tạo chính sách áp dụng cho mọi trường.'); }
  else assertSchoolAccess_(user, schoolId);
}

/** Tạo mới (không có DiscountId) hoặc sửa chính sách. Chính sách bị sửa phải duyệt lại nếu người sửa không có quyền duyệt. */
function savePolicy(payload) {
  const user = requireCap_('managePolicy');
  const type = String(payload.PolicyType || '').toUpperCase();
  if (!POLICY_TYPES[type]) throw new Error('Chọn nhóm chính sách.');
  const name = String(payload.Name || '').trim();
  if (!name) throw new Error('Tên chính sách là bắt buộc.');
  const method = String(payload.Method || 'PERCENT').toUpperCase();
  const value = Number(payload.Value);
  if (!['PERCENT','AMOUNT'].includes(method)) throw new Error('Hình thức giảm không hợp lệ.');
  if (!(value > 0) || (method === 'PERCENT' && value > 100)) throw new Error('Mức giảm không hợp lệ (phần trăm từ 0–100, hoặc số tiền > 0).');
  const schoolId = String(payload.SchoolId || '*');
  assertPolicyScope_(user, schoolId);
  const fees = (Array.isArray(payload.FeeTypeIds) ? payload.FeeTypeIds : feeTypeList_(payload.FeeTypeIds)).map(String);
  const known = new Set(readTable_('FeeTypes').map(f => String(f.FeeTypeId)));
  fees.forEach(f => { if (!known.has(f)) throw new Error('Không tìm thấy khoản phí: ' + f); });
  if (payload.ClassId) {
    const c = readTable_('Classes').find(x => String(x.ClassId) === String(payload.ClassId));
    if (!c || (schoolId !== '*' && String(c.SchoolId) !== schoolId)) throw new Error('Lớp không thuộc trường của chính sách.');
  }
  if (payload.ValidFrom && payload.ValidTo && String(payload.ValidTo) < String(payload.ValidFrom)) throw new Error('Ngày kết thúc phải sau ngày bắt đầu.');
  const canApprove = can_(user, 'approvePolicy');
  const row = {
    SchoolId:schoolId, Name:name, Method:method, Value:value, FeeTypeId:fees.join(','),
    ValidFrom:asText_(String(payload.ValidFrom || '')), ValidTo:asText_(String(payload.ValidTo || '')),
    ApprovalRequired:true, PolicyType:type, Level:String(payload.Level || ''), Grade:asText_(String(payload.Grade || '')),
    ClassId:String(payload.ClassId || ''), MaxAmount:Number(payload.MaxAmount || 0),
    Stackable: !(payload.Stackable === false || String(payload.Stackable) === 'false'),
    MinChildOrder: type === 'SIBLING' ? Math.max(1, Number(payload.MinChildOrder || 2)) : '',
    SiblingScope: type === 'SIBLING' ? (String(payload.SiblingScope || 'SCHOOL').toUpperCase() === 'SYSTEM' ? 'SYSTEM' : 'SCHOOL') : '',
    Description:String(payload.Description || '')
  };
  return withWriteLock_(() => {
    const now = new Date();
    if (payload.DiscountId) {
      const cur = readTable_('Discounts').find(d => String(d.DiscountId) === String(payload.DiscountId));
      if (!cur) throw new Error('Không tìm thấy chính sách.');
      assertPolicyScope_(user, String(cur.SchoolId || '*'));
      Object.assign(row, canApprove ? {ApprovedBy:user.email, ApprovedAt:now} : {ApprovedBy:'', ApprovedAt:''});
      updateObjectById_('Discounts','DiscountId',cur.DiscountId,row);
      audit_('UPDATE','Discounts',cur.DiscountId,row);
      return {ok:true, id:cur.DiscountId, approved:canApprove};
    }
    const id = nextId_('POL');
    appendObject_('Discounts', Object.assign(row, {DiscountId:id, Active:true, StudentId:'', CreatedAt:now, CreatedBy:user.email,
      ApprovedBy: canApprove ? user.email : '', ApprovedAt: canApprove ? now : ''}));
    audit_('CREATE','Discounts',id,row);
    return {ok:true, id, approved:canApprove};
  });
}

/** action: APPROVE | DEACTIVATE | ACTIVATE */
function setPolicyStatus(payload) {
  const action = String(payload.action || '').toUpperCase();
  const user = requireCap_(action === 'APPROVE' ? 'approvePolicy' : 'managePolicy');
  return withWriteLock_(() => {
    const d = readTable_('Discounts').find(x => String(x.DiscountId) === String(payload.DiscountId));
    if (!d) throw new Error('Không tìm thấy chính sách.');
    assertPolicyScope_(user, String(d.SchoolId || '*'));
    const patch = action === 'APPROVE' ? {ApprovedBy:user.email, ApprovedAt:new Date()}
      : action === 'DEACTIVATE' ? {Active:false} : action === 'ACTIVATE' ? {Active:true} : null;
    if (!patch) throw new Error('Thao tác không hợp lệ.');
    updateObjectById_('Discounts','DiscountId',d.DiscountId,patch);
    audit_(action,'Discounts',d.DiscountId,{});
    return {ok:true};
  });
}

function getPolicyDetail(id) {
  const user = requireCap_('managePolicy');
  const d = readTable_('Discounts').find(x => String(x.DiscountId) === String(id));
  if (!d) throw new Error('Không tìm thấy chính sách.');
  if (d.SchoolId && d.SchoolId !== '*') assertSchoolAccess_(user, d.SchoolId);
  const allowed = new Set(listSchoolsForUser_(user).map(s => String(s.SchoolId)));
  const smap = Object.fromEntries(readTable_('Schools').map(s => [String(s.SchoolId), s.SchoolName]));
  const fmap = Object.fromEntries(readTable_('FeeTypes').map(f => [String(f.FeeTypeId), f.FeeName]));
  const cmap = Object.fromEntries(readTable_('Classes').map(c => [String(c.ClassId), c.ClassName]));
  const stu = Object.fromEntries(readTable_('Students').map(s => [String(s.StudentId), s]));
  return {
    policy: policyView_(d, smap, fmap, cmap),
    members: readTable_('PolicyMembers').filter(m => String(m.DiscountId) === String(id) && truthy_(m.Active) && allowed.has(String(m.SchoolId)))
      .map(m => { const s = stu[String(m.StudentId)] || {};
        return {memberId:m.MemberId, studentId:m.StudentId, name:s.FullName || m.StudentId, code:String(s.StudentCode || ''),
          className:cmap[String(s.ClassId)] || '', school:smap[String(m.SchoolId)] || '', note:m.Note || '',
          validFrom:String(m.ValidFrom || '').slice(0,10), validTo:String(m.ValidTo || '').slice(0,10), by:m.CreatedBy}; })
      .sort((a,b) => (a.className + a.name).localeCompare(b.className + b.name, 'vi')),
    families: String(d.PolicyType).toUpperCase() === 'SIBLING' ? (() => {
      const scope = String(d.SiblingScope || 'SCHOOL').toUpperCase() === 'SYSTEM' ? null : (d.SchoolId && d.SchoolId !== '*' ? String(d.SchoolId) : '');
      const min = Number(d.MinChildOrder || 2);
      // Phạm vi cùng trường nhưng chính sách áp dụng mọi trường → liệt kê theo từng trường.
      const lists = scope === '' ? listSchoolsForUser_(user).map(s => siblingFamilies_(String(s.SchoolId)).groups).reduce((a, b) => a.concat(b), [])
        : siblingFamilies_(scope).groups;
      return lists.filter(g => g.some(s => allowed.has(String(s.SchoolId)))).map(g => ({parent:g[0].ParentName || '', phone:String(g[0].ParentPhone || ''),
        children:g.map((s, i) => ({name:s.FullName, code:String(s.StudentCode || ''), dob:normalizeDateText_(s.DOB), order:i + 1, school:smap[String(s.SchoolId)] || '',
          eligible: g.length >= 2 && (i + 1) >= Math.max(1, min)}))}));
    })() : [],
    attachments: readTable_('Attachments').filter(a => a.Entity === 'Discounts' && String(a.EntityId) === String(id))
      .map(a => ({id:a.AttachmentId, name:a.FileName, url:a.Url, size:Number(a.Size || 0), at:String(a.UploadedAt), by:a.UploadedBy}))
  };
}

/** Ghi danh học sinh vào chính sách. payload: {DiscountId, StudentIds:[], Note, ValidFrom, ValidTo} */
function addPolicyMembers(payload) {
  const user = requireCap_('managePolicy');
  const ids = (payload.StudentIds || []).map(String).filter(Boolean);
  if (!ids.length) throw new Error('Chọn học sinh.');
  return withWriteLock_(() => {
    const d = readTable_('Discounts').find(x => String(x.DiscountId) === String(payload.DiscountId));
    if (!d) throw new Error('Không tìm thấy chính sách.');
    const type = String(d.PolicyType || '').toUpperCase();
    if (!POLICY_TYPES[type] || !POLICY_TYPES[type].members) throw new Error('Chính sách này tự áp dụng theo phạm vi, không cần ghi danh học sinh.');
    const stu = Object.fromEntries(readTable_('Students').map(s => [String(s.StudentId), s]));
    const existing = new Set(readTable_('PolicyMembers').filter(m => String(m.DiscountId) === String(d.DiscountId) && truthy_(m.Active)).map(m => String(m.StudentId)));
    const now = new Date(), rows = [];
    ids.forEach(sid => {
      const s = stu[sid];
      if (!s) throw new Error('Không tìm thấy học sinh ' + sid);
      assertSchoolAccess_(user, s.SchoolId);
      if (d.SchoolId && d.SchoolId !== '*' && String(s.SchoolId) !== String(d.SchoolId)) throw new Error(s.FullName + ' không thuộc trường của chính sách.');
      if (existing.has(sid)) return;
      existing.add(sid);
      rows.push({MemberId:nextId_('MEM'), DiscountId:d.DiscountId, StudentId:sid, SchoolId:s.SchoolId, Note:String(payload.Note || ''),
        ValidFrom:asText_(String(payload.ValidFrom || '')), ValidTo:asText_(String(payload.ValidTo || '')), Active:true, CreatedAt:now, CreatedBy:user.email});
    });
    appendObjects_('PolicyMembers', rows);
    audit_('ADD_MEMBERS','Discounts',d.DiscountId,{count:rows.length});
    return {ok:true, added:rows.length, skipped:ids.length - rows.length};
  });
}

function removePolicyMember(memberId) {
  const user = requireCap_('managePolicy');
  return withWriteLock_(() => {
    const m = readTable_('PolicyMembers').find(x => String(x.MemberId) === String(memberId));
    if (!m) throw new Error('Không tìm thấy.');
    assertSchoolAccess_(user, m.SchoolId);
    updateObjectById_('PolicyMembers','MemberId',m.MemberId,{Active:false});
    audit_('REMOVE_MEMBER','Discounts',m.DiscountId,{studentId:m.StudentId});
    return {ok:true};
  });
}

/**
 * Tải tờ trình / hồ sơ gốc lên Google Drive (thư mục cấu hình) và gắn vào chính sách.
 * payload: {EntityId, fileName, mimeType, base64}
 */
function uploadPolicyDocument(payload) {
  const user = requireCap_('managePolicy');
  const d = readTable_('Discounts').find(x => String(x.DiscountId) === String(payload.EntityId));
  if (!d) throw new Error('Không tìm thấy chính sách.');
  if (d.SchoolId && d.SchoolId !== '*') assertSchoolAccess_(user, d.SchoolId);
  const bytes = Utilities.base64Decode(String(payload.base64 || ''));
  if (!bytes.length) throw new Error('Tệp rỗng.');
  if (bytes.length > APP.MAX_UPLOAD_MB * 1024 * 1024) throw new Error('Tệp vượt quá ' + APP.MAX_UPLOAD_MB + ' MB.');
  const folder = driveFolder_('DOCUMENTS_FOLDER_ID', 'Tờ trình chính sách');
  const date = Utilities.formatDate(new Date(), APP.TZ, 'yyyyMMdd');
  const original = String(payload.fileName || 'to-trinh').replace(/[\\/:*?"<>|]/g, '_');
  const name = date + ' - ' + String(d.Name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + ' - ' + original;
  const file = folder.createFile(Utilities.newBlob(bytes, String(payload.mimeType || 'application/octet-stream'), name));
  file.setDescription('Tờ trình chính sách "' + d.Name + '" (' + d.DiscountId + ') - tải lên bởi ' + user.email);
  return withWriteLock_(() => {
    const id = nextId_('ATT');
    appendObject_('Attachments', {AttachmentId:id, Entity:'Discounts', EntityId:d.DiscountId, FileId:file.getId(), FileName:name,
      Url:file.getUrl(), MimeType:file.getMimeType(), Size:bytes.length, UploadedAt:new Date(), UploadedBy:user.email});
    audit_('UPLOAD','Discounts',d.DiscountId,{file:name});
    return {ok:true, id, url:file.getUrl(), name};
  });
}
