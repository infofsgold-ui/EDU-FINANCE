/**
 * Sửa danh mục: trường, lớp, khoản phí, bảng giá, mặt hàng, kho.
 * Mỗi loại khai báo: sheet, cột khóa, quyền cần có, các cột được sửa, cột phải lưu dạng văn bản và cách kiểm tra phạm vi trường.
 */
const MASTER_DEF_ = {
  schools:    {sheet:'Schools', key:'SchoolId', cap:'manageMaster', fields:['SchoolName','Level','Address','Active'], scope:r => r.SchoolId},
  classes:    {sheet:'Classes', key:'ClassId', cap:'manageClasses', fields:['ClassName','Grade','SchoolYear','HomeroomTeacher','TeacherEmails','Capacity','Active'],
               text:['Grade','SchoolYear'], scope:r => r.SchoolId},
  feeTypes:   {sheet:'FeeTypes', key:'FeeTypeId', cap:'manageMaster', fields:['FeeName','Category','CalculationMethod','Unit','Description','Active']},
  feeRates:   {sheet:'FeeRates', key:'RateId', cap:'manageMaster', fields:['SchoolId','FeeTypeId','UnitPrice','Level','Grade','Frequency','ValidFrom','ValidTo','Active'],
               text:['Grade','ValidFrom','ValidTo'], scope:r => r.SchoolId},
  products:   {sheet:'Products', key:'ProductId', cap:'manageStock', fields:['SKU','ProductName','Category','Unit','Size','ReorderLevel','SalePrice','Active'],
               text:['SKU']},
  warehouses: {sheet:'Warehouses', key:'WarehouseId', cap:'manageStock', fields:['WarehouseName','WarehouseType','Active'], scope:r => r.SchoolId}
};

/** Toàn bộ danh mục (kể cả mục đã ngừng) trong phạm vi người dùng, để hiển thị bảng và sửa. */
function getMasterData() {
  const user = currentUser_();
  if (!['manageMaster','manageClasses','manageStock','managePolicy','viewRawData'].some(c => can_(user, c))) throw new Error('Bạn không có quyền xem danh mục.');
  const allowed = new Set(listSchoolsForUser_(user).map(s => String(s.SchoolId)));
  const inScope = r => isGroupWide_(user) || !r.SchoolId || allowed.has(String(r.SchoolId));
  const smap = Object.fromEntries(readTable_('Schools').map(s => [String(s.SchoolId), s.SchoolName]));
  const fmap = Object.fromEntries(readTable_('FeeTypes').map(f => [String(f.FeeTypeId), f.FeeName]));
  const students = {};
  readTable_('Students').forEach(s => { if (isActiveStudent_(s)) students[s.ClassId] = (students[s.ClassId] || 0) + 1; });
  return {
    schools: readTable_('Schools').filter(s => isGroupWide_(user) || allowed.has(String(s.SchoolId)))
      .map(s => ({id:s.SchoolId, SchoolName:s.SchoolName, Level:normalizeLevel_(s.Level) || s.Level, Address:s.Address, Active:truthy_(s.Active)})),
    classes: readTable_('Classes').filter(inScope).map(c => ({id:c.ClassId, SchoolId:c.SchoolId, school:smap[String(c.SchoolId)] || '',
      ClassName:c.ClassName, Grade:String(c.Grade || ''), SchoolYear:String(c.SchoolYear || ''), HomeroomTeacher:c.HomeroomTeacher,
      Capacity:Number(c.Capacity || 0), students:students[c.ClassId] || 0, Active:truthy_(c.Active), TeacherEmails:String(c.TeacherEmails || '')})),
    teachers: readTable_('Users').filter(u => u.Role === 'TEACHER' && truthy_(u.Active) && (isGroupWide_(user) || allowed.has(String(u.SchoolId))))
      .map(u => ({email:String(u.UserEmail).toLowerCase(), name:u.FullName, schoolId:String(u.SchoolId || '')})),
    feeTypes: readTable_('FeeTypes').map(f => ({id:f.FeeTypeId, FeeName:f.FeeName, Category:f.Category, CalculationMethod:f.CalculationMethod,
      Unit:f.Unit, Description:f.Description, Active:truthy_(f.Active)})),
    feeRates: readTable_('FeeRates').filter(inScope).map(r => ({id:r.RateId, SchoolId:r.SchoolId, school:smap[String(r.SchoolId)] || '',
      FeeTypeId:r.FeeTypeId, fee:fmap[String(r.FeeTypeId)] || r.FeeTypeId, UnitPrice:Number(r.UnitPrice || 0), Level:String(r.Level || ''),
      Grade:String(r.Grade || ''), Frequency:r.Frequency, ValidFrom:String(r.ValidFrom || '').slice(0,7), ValidTo:String(r.ValidTo || '').slice(0,7),
      Active:truthy_(r.Active)})),
    products: readTable_('Products').map(p => ({id:p.ProductId, SKU:String(p.SKU || ''), ProductName:p.ProductName, Category:p.Category,
      Unit:p.Unit, Size:p.Size, ReorderLevel:Number(p.ReorderLevel || 0), SalePrice:Number(p.SalePrice || 0), Active:truthy_(p.Active), ImageUrl:p.ImageUrl || ''})),
    warehouses: readTable_('Warehouses').filter(inScope).map(w => ({id:w.WarehouseId, SchoolId:w.SchoolId || '', school:w.SchoolId ? (smap[String(w.SchoolId)] || '') : 'Kho tổng',
      WarehouseName:w.WarehouseName, WarehouseType:w.WarehouseType, Active:truthy_(w.Active)}))
  };
}

/** payload: {entity, id, values:{Cột: giá trị}} — chỉ các cột trong MASTER_DEF_[entity].fields được ghi. */
function updateMaster(payload) {
  const def = MASTER_DEF_[payload.entity];
  if (!def) throw new Error('Danh mục không hỗ trợ sửa.');
  const user = requireCap_(def.cap);
  const id = String(payload.id || '');
  return withWriteLock_(() => {
    const row = readTable_(def.sheet).find(r => String(r[def.key]) === id);
    if (!row) throw new Error('Không tìm thấy bản ghi.');
    if (def.scope) {
      const sid = def.scope(row);
      if (sid) assertSchoolAccess_(user, sid);
      else if (!isGroupWide_(user) && !can_(user, 'manageStock')) throw new Error('Bạn không có quyền sửa mục dùng chung.');
    }
    const v = payload.values || {}, patch = {};
    def.fields.forEach(f => {
      if (v[f] === undefined) return;
      let x = v[f];
      if (f === 'Active') x = !(x === false || String(x) === 'false');
      else if (['UnitPrice','Capacity','ReorderLevel','SalePrice'].includes(f)) { x = Number(x || 0); if (x < 0) throw new Error('Giá trị không được âm.'); }
      else { x = String(x).trim(); if ((def.text || []).includes(f)) x = asText_(x); }
      patch[f] = x;
    });
    if (patch.SchoolName === '' || patch.ClassName === '' || patch.FeeName === '' || patch.ProductName === '' || patch.WarehouseName === '')
      throw new Error('Tên không được để trống.');
    if (patch.SchoolId !== undefined) {
      if (!readTable_('Schools').some(x => String(x.SchoolId) === patch.SchoolId)) throw new Error('Không tìm thấy trường.');
      assertSchoolAccess_(user, patch.SchoolId);
    }
    if (patch.FeeTypeId !== undefined && !readTable_('FeeTypes').some(x => String(x.FeeTypeId) === patch.FeeTypeId)) throw new Error('Không tìm thấy khoản phí.');
    if (patch.Level !== undefined) patch.Level = normalizeLevel_(patch.Level) || patch.Level;
    if (patch.CalculationMethod && !['FIXED','PER_DAY','QUANTITY'].includes(patch.CalculationMethod)) throw new Error('Cách tính không hợp lệ.');
    if (payload.entity === 'products' && patch.SKU !== undefined) {
      const sku = String(v.SKU).trim().toLowerCase();
      if (!sku) throw new Error('Mã SKU không được để trống.');
      if (readTable_('Products').some(p => String(p.ProductId) !== id && String(p.SKU).trim().toLowerCase() === sku)) throw new Error('Mã SKU đã tồn tại.');
    }
    updateObjectById_(def.sheet, def.key, id, patch);
    audit_('UPDATE', def.sheet, id, patch);
    const switched = payload.entity === 'feeRates' && syncDailyFeeType_(patch.FeeTypeId || row.FeeTypeId, patch.Frequency || row.Frequency);
    return {ok:true, switchedToDaily: !!switched};
  });
}

// ===================== CHÍNH SÁCH CỦA TỪNG HỌC SINH =====================

/** Các chính sách cần ghi danh mà học sinh (của trường schoolId) có thể được gán, kèm trạng thái đang hưởng. */
function getStudentPolicyOptions(params) {
  const user = requireCap_('managePolicy');
  const schoolId = String(params.schoolId || '');
  assertSchoolAccess_(user, schoolId);
  const mine = new Set(params.studentId ? readTable_('PolicyMembers')
    .filter(m => String(m.StudentId) === String(params.studentId) && truthy_(m.Active)).map(m => String(m.DiscountId)) : []);
  const today = Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd');
  return readTable_('Discounts').filter(d => {
    const t = String(d.PolicyType || '').toUpperCase();
    if (!POLICY_TYPES[t] || !POLICY_TYPES[t].members) return false;
    if (d.SchoolId && d.SchoolId !== '*' && String(d.SchoolId) !== schoolId) return false;
    if (mine.has(String(d.DiscountId))) return true;
    return truthy_(d.Active) && (!d.ValidTo || normDate_(d.ValidTo, true) >= today);
  }).map(d => ({id:d.DiscountId, name:d.Name, type:String(d.PolicyType).toUpperCase(), typeLabel:POLICY_TYPES[String(d.PolicyType).toUpperCase()].label,
    value: String(d.Method).toUpperCase() === 'PERCENT' ? Number(d.Value) + '%' : fmtMoney_(d.Value) + 'đ',
    approved: policyApproved_(d), active: truthy_(d.Active), checked: mine.has(String(d.DiscountId))}));
}

/** Đặt danh sách chính sách (loại cần ghi danh) cho một học sinh: thêm mục mới chọn, gỡ mục bỏ chọn. */
function setStudentPolicies(payload) {
  const user = requireCap_('managePolicy');
  const sid = String(payload.StudentId || '');
  const want = new Set((payload.DiscountIds || []).map(String));
  const st = readTable_('Students').find(s => String(s.StudentId) === sid);
  if (!st) throw new Error('Không tìm thấy học sinh.');
  assertSchoolAccess_(user, st.SchoolId);
  const current = readTable_('PolicyMembers').filter(m => String(m.StudentId) === sid && truthy_(m.Active));
  const have = new Set(current.map(m => String(m.DiscountId)));
  let added = 0, removed = 0;
  want.forEach(did => { if (!have.has(did)) { addPolicyMembers({DiscountId:did, StudentIds:[sid], Note:String(payload.Note || '')}); added++; } });
  current.forEach(m => { if (!want.has(String(m.DiscountId))) { removePolicyMember(m.MemberId); removed++; } });
  return {ok:true, added, removed};
}

/**
 * Xóa mặt hàng / kho. Chỉ xóa được khi CHƯA phát sinh dữ liệu (phiếu kho, hóa đơn, đơn đặt hàng);
 * đã phát sinh thì phải "Ngừng sử dụng" để giữ lịch sử. payload: {entity:'products'|'warehouses', id}
 */
function deleteMaster(payload) {
  const entity = String(payload.entity || ''), id = String(payload.id || '');
  if (!['products','warehouses'].includes(entity)) throw new Error('Danh mục này không hỗ trợ xóa.');
  const user = requireCap_('manageStock');
  return withWriteLock_(() => {
    if (entity === 'products') {
      const p = readTable_('Products').find(x => String(x.ProductId) === id);
      if (!p) throw new Error('Không tìm thấy mặt hàng.');
      const used = [
        [readTable_('StockMovements').filter(m => String(m.ProductId) === id).length, 'phiếu kho'],
        [readTable_('InvoiceLines').filter(l => String(l.ProductId) === id).length, 'dòng hóa đơn bán hàng'],
        [readTable_('OrderLines').filter(l => String(l.ProductId) === id).length, 'đơn đặt của phụ huynh']
      ].filter(x => x[0] > 0);
      if (used.length) throw new Error('Không xóa được "' + p.ProductName + '" vì đã có ' + used.map(x => x[0] + ' ' + x[1]).join(', ') +
        '. Hãy Sửa → bỏ chọn "Đang kinh doanh" để ngừng sử dụng (giữ lịch sử).');
      deleteRowById_('Products', 'ProductId', id);
      if (p.ImageFileId) { try { DriveApp.getFileById(String(p.ImageFileId)).setTrashed(true); } catch (e) {} }
      audit_('DELETE', 'Products', id, {name:p.ProductName, sku:p.SKU});
      return {ok:true, name:p.ProductName};
    }
    const w = readTable_('Warehouses').find(x => String(x.WarehouseId) === id);
    if (!w) throw new Error('Không tìm thấy kho.');
    if (w.SchoolId) assertSchoolAccess_(user, w.SchoolId); else if (!isGroupWide_(user)) throw new Error('Chỉ cấp tập đoàn được xóa kho tổng.');
    const moves = readTable_('StockMovements').filter(m => String(m.WarehouseId) === id).length;
    const lines = readTable_('InvoiceLines').filter(l => String(l.WarehouseId) === id).length;
    if (moves || lines) throw new Error('Không xóa được kho "' + w.WarehouseName + '" vì đã có ' + (moves ? moves + ' phiếu kho' : '') +
      (moves && lines ? ', ' : '') + (lines ? lines + ' dòng bán hàng' : '') + '. Hãy Sửa → bỏ chọn "Đang sử dụng" để ngừng kho.');
    deleteRowById_('Warehouses', 'WarehouseId', id);
    audit_('DELETE', 'Warehouses', id, {name:w.WarehouseName});
    return {ok:true, name:w.WarehouseName};
  });
}
