function saveSchool(payload) {
  const user = requireCap_('manageMaster');
  const name = String(payload.SchoolName || '').trim();
  if (!name) throw new Error('Tên trường là bắt buộc.');
  return withWriteLock_(() => {
    const id = nextId_('SCH');
    appendObject_('Schools', {
      SchoolId:id, SchoolName:name, Level:normalizeLevel_(payload.Level) || String(payload.Level||''), Address:String(payload.Address||''),
      Active:true, CreatedAt:new Date(), CreatedBy:user.email
    });
    audit_('CREATE','Schools',id,{name});
    return {ok:true,id};
  });
}

function saveClass(payload) {
  const user = requireCap_('manageClasses');
  const schoolId = String(payload.SchoolId||'');
  assertSchoolAccess_(user, schoolId);
  if (!schoolId || !payload.ClassName) throw new Error('Trường và tên lớp là bắt buộc.');
  return withWriteLock_(() => {
    const id = nextId_('CLS');
    appendObject_('Classes',{
      ClassId:id, SchoolId:schoolId, SchoolYear:asText_(String(payload.SchoolYear||'')), Grade:asText_(String(payload.Grade||'')),
      ClassName:String(payload.ClassName), HomeroomTeacher:String(payload.HomeroomTeacher||''),
      Capacity:Number(payload.Capacity||0), Active:true, CreatedAt:new Date(), CreatedBy:user.email
    });
    audit_('CREATE','Classes',id,payload);
    return {ok:true,id};
  });
}

/** Chuẩn hoá & kiểm tra email phụ huynh (có thể nhiều email, cách nhau dấu phẩy). */
function cleanParentEmails_(v) {
  const list = emailList_(v);
  list.forEach(e => { if (!isValidEmail_(e)) throw new Error('Email phụ huynh không hợp lệ: "' + e + '". Nhiều email thì cách nhau bằng dấu phẩy.'); });
  return list.join(', ');
}

/**
 * Thêm học sinh. Nếu có email phụ huynh (và SendAccount khác false): tạo tài khoản phụ huynh
 * (tên đăng nhập = mã học sinh, mật khẩu = ParentPassword hoặc tự tạo) và gửi email ngay; kết quả gửi trả về trong `account`.
 */
function saveStudent(payload) {
  const user = requireCap_('manageStudents');
  const schoolId = String(payload.SchoolId||'');
  assertSchoolAccess_(user, schoolId);
  if (!schoolId || !payload.FullName || !payload.ClassId) throw new Error('Trường, lớp và họ tên học sinh là bắt buộc.');
  payload.ParentEmail = cleanParentEmails_(payload.ParentEmail);
  if (payload.ParentPassword) checkInitialPassword_(payload.ParentPassword);
  const created = withWriteLock_(() => {
    const cls = readTable_('Classes').find(c => String(c.ClassId) === String(payload.ClassId));
    if (!cls || String(cls.SchoolId) !== schoolId) throw new Error('Mã lớp không tồn tại hoặc không thuộc trường đã chọn.');
    const id = nextId_('STU');
    const code = String(payload.StudentCode||'').trim() || id;
    if (readTable_('Students').some(s => String(s.SchoolId) === schoolId && String(s.StudentCode).trim() === code))
      throw new Error('Mã học sinh "' + code + '" đã tồn tại trong trường.');
    appendObject_('Students',{
      StudentId:id, SchoolId:schoolId, ClassId:String(payload.ClassId), StudentCode:asText_(code),
      FullName:String(payload.FullName).trim(), DOB:String(payload.DOB||''), EnrollmentDate:String(payload.EnrollmentDate||''),
      Status:String(payload.Status||'ACTIVE'), ParentName:String(payload.ParentName||''), ParentPhone:asText_(String(payload.ParentPhone||'').trim()),
      Notes:String(payload.Notes||''), CreatedAt:new Date(), CreatedBy:user.email,
      Gender:String(payload.Gender||''), Address:String(payload.Address||''), ParentEmail:String(payload.ParentEmail||'').trim().toLowerCase(),
      LeaveDate:String(payload.LeaveDate||'')
    });
    audit_('CREATE','Students',id,{name:payload.FullName,schoolId});
    return {ok:true,id};
  });
  const wantAccount = !(payload.SendAccount === false || String(payload.SendAccount) === 'false');
  if (wantAccount && (payload.ParentEmail || payload.ParentPassword)) {
    const st = readTable_('Students').find(s => String(s.StudentId) === created.id);
    try {
      const r = issueParentAccount_(st, payload.ParentEmail ? ['EMAIL'] : [], true, user, payload.ParentPassword || '');
      created.account = Object.assign(r, {email: payload.ParentEmail});
    } catch (e) { created.account = {username:'', sent:[], errors:['Tạo tài khoản lỗi: ' + (e.message || e)], email: payload.ParentEmail}; }
  }
  return created;
}

/** Sửa hồ sơ học sinh (chuyển lớp, đổi trạng thái, thông tin phụ huynh...). Không đổi được trường. */
function updateStudent(payload) {
  const user = requireCap_('manageStudents');
  const id = String(payload.StudentId || '');
  return withWriteLock_(() => {
    const st = readTable_('Students').find(s => String(s.StudentId) === id);
    if (!st) throw new Error('Không tìm thấy học sinh.');
    assertSchoolAccess_(user, st.SchoolId);
    if (payload.ClassId && String(payload.ClassId) !== String(st.ClassId)) {
      const cls = readTable_('Classes').find(c => String(c.ClassId) === String(payload.ClassId));
      if (!cls || String(cls.SchoolId) !== String(st.SchoolId)) throw new Error('Lớp mới không thuộc trường của học sinh.');
    }
    const editable = ['ClassId','FullName','DOB','EnrollmentDate','Status','ParentName','ParentPhone','Notes','Gender','Address','ParentEmail','LeaveDate'];
    const patch = {};
    editable.forEach(k => {
      if (payload[k] === undefined) return;
      let v = String(payload[k]).trim();
      if (k === 'ParentEmail') v = cleanParentEmails_(v);
      if (k === 'ParentPhone') v = asText_(v);
      patch[k] = v;
    });
    if (!patch.FullName && patch.FullName !== undefined) throw new Error('Họ tên không được để trống.');
    updateObjectById_('Students','StudentId',id,patch);
    audit_('UPDATE','Students',id,patch);
    return {ok:true,id};
  });
}

function saveFeeType(payload) {
  const user = requireCap_('manageMaster');
  const name = String(payload.FeeName||'').trim();
  const method = String(payload.CalculationMethod||'FIXED').toUpperCase();
  if (!name) throw new Error('Tên khoản phí là bắt buộc.');
  if (!['FIXED','PER_DAY','QUANTITY'].includes(method)) throw new Error('Cách tính không hợp lệ.');
  const created = withWriteLock_(() => {
    const id = String(payload.FeeTypeId||'').trim().toUpperCase() || nextId_('FEE');
    if (readTable_('FeeTypes').some(f => String(f.FeeTypeId) === id)) throw new Error('Mã khoản phí đã tồn tại: ' + id);
    appendObject_('FeeTypes',{FeeTypeId:id, FeeName:name, Category:String(payload.Category||''), CalculationMethod:method,
      Unit:String(payload.Unit||''), Active:true, Description:String(payload.Description||'')});
    audit_('CREATE','FeeTypes',id,payload);
    return {ok:true,id};
  });
  // Nhập luôn đơn giá khi tạo khoản phí: tạo mức giá cho trường đã chọn (hoặc mọi trường trong phạm vi).
  if (payload.UnitPrice !== undefined && payload.UnitPrice !== '' && Number(payload.UnitPrice) >= 0) {
    const schools = payload.RateSchoolId ? [String(payload.RateSchoolId)] : listSchoolsForUser_(user).map(s => String(s.SchoolId));
    const rateIds = schools.map(sid => saveFeeRate({SchoolId:sid, FeeTypeId:created.id, UnitPrice:payload.UnitPrice, Level:payload.Level || '',
      Grade:payload.Grade || '', Frequency:'MONTHLY', ValidFrom:payload.ValidFrom || '', ValidTo:payload.ValidTo || ''}).id);
    return Object.assign(created, {rateIds});
  }
  return created;
}

/** Mức giá "Theo ngày" → chuyển khoản phí sang cách tính Theo ngày (PER_DAY). Gọi trong khóa ghi. */
function syncDailyFeeType_(feeTypeId, frequency) {
  if (String(frequency || '').toUpperCase() !== 'DAILY') return false;
  const ft = readTable_('FeeTypes').find(f => String(f.FeeTypeId) === String(feeTypeId));
  if (!ft || String(ft.CalculationMethod).toUpperCase() === 'PER_DAY') return false;
  updateObjectById_('FeeTypes', 'FeeTypeId', ft.FeeTypeId, {CalculationMethod:'PER_DAY'});
  audit_('UPDATE', 'FeeTypes', ft.FeeTypeId, {CalculationMethod:'PER_DAY', reason:'Mức giá theo ngày'});
  return true;
}

function saveFeeRate(payload) {
  const user = requireCap_('manageMaster');
  const schoolId = String(payload.SchoolId||'');
  const feeTypeId = String(payload.FeeTypeId||'');
  const price = Number(payload.UnitPrice);
  if (!schoolId || !feeTypeId || !(price >= 0)) throw new Error('Trường, khoản phí và đơn giá là bắt buộc.');
  if (!readTable_('FeeTypes').some(f => String(f.FeeTypeId) === feeTypeId)) throw new Error('Không tìm thấy khoản phí.');
  return withWriteLock_(() => {
    const id = nextId_('RATE');
    appendObject_('FeeRates',{RateId:id, SchoolId:schoolId, Level:String(payload.Level||''), Grade:asText_(String(payload.Grade||'')),
      FeeTypeId:feeTypeId, UnitPrice:price, Frequency:String(payload.Frequency||'MONTHLY'),
      ValidFrom:asText_(String(payload.ValidFrom||'')), ValidTo:asText_(String(payload.ValidTo||'')), Active:true,
      CreatedAt:new Date(), CreatedBy:user.email});
    audit_('CREATE','FeeRates',id,payload);
    const switched = syncDailyFeeType_(feeTypeId, payload.Frequency);
    return {ok:true, id, switchedToDaily:switched};
  });
}

function saveWarehouse(payload) {
  const user = requireCap_('manageStock');
  const name = String(payload.WarehouseName||'').trim();
  const schoolId = String(payload.SchoolId||'');
  if (!name) throw new Error('Tên kho là bắt buộc.');
  if (schoolId) assertSchoolAccess_(user, schoolId); else if (!isGroupWide_(user)) throw new Error('Chỉ cấp tập đoàn được tạo kho tổng.');
  return withWriteLock_(() => {
    const id = nextId_('WH');
    appendObject_('Warehouses',{WarehouseId:id, SchoolId:schoolId, WarehouseName:name, WarehouseType:String(payload.WarehouseType||'SCHOOL'), Active:true});
    audit_('CREATE','Warehouses',id,payload);
    return {ok:true,id};
  });
}
