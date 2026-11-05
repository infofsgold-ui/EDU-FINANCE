/**
 * TIỀN ĂN BÁN TRÚ — phương án "Thu trước, quyết toán cuối tháng, trừ vào tháng sau".
 *
 *  1. Đầu tháng: kế toán thiết lập tháng (khoản phí tiền ăn, số ngày ăn dự kiến) và đăng ký ăn từng học sinh
 *     (mặc định giữ như tháng trước; học sinh chưa có dữ liệu = có đăng ký, ăn đủ số ngày dự kiến).
 *     Khi tính học phí, tiền ăn = số ngày dự kiến của học sinh × đơn giá trong Bảng giá (sau chính sách giảm nếu có).
 *  2. Trong/cuối tháng: GVCN hoặc kế toán nhập số ngày nghỉ có báo / không báo.
 *  3. Cuối tháng: kế toán CHỐT. Số ngày được trừ = nghỉ có báo (+ nghỉ không báo nếu trường cho phép),
 *     tiền được trừ = số ngày × đơn giá THỰC THU của dòng tiền ăn trên hóa đơn tháng đó.
 *  4. Lần tính học phí tháng sau: phần được trừ tự thành dòng âm "Hoàn tiền ăn Tx" trên hóa đơn.
 *     Nếu hóa đơn tháng sau không đủ để trừ (VD học sinh nghỉ học), khoản hoàn chờ xử lý → "Đã hoàn tiền mặt".
 */

const MEAL_REFUND_FEE_ID = 'MEAL_REFUND';

function mealRules_(schoolId) {
  return {
    refundUnreported: truthy_(getSetting_(schoolId, 'MEAL_REFUND_UNREPORTED')),
    deadline: getSetting_(schoolId, 'MEAL_DEADLINE') || '08:00 cùng ngày'
  };
}

function setSetting_(schoolId, key, value, user) {
  const sh = sheet_('Settings');
  const data = sh.getDataRange().getValues();
  const now = new Date();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][0] || '*') === String(schoolId) && data[r][1] === key) {
      sh.getRange(r + 1, 3, 1, 3).setValues([[asText_(String(value)), now, user.email]]);
      invalidateTable_('Settings');
      return;
    }
  }
  sh.appendRow([schoolId, key, asText_(String(value)), now, user.email]);
  invalidateTable_('Settings');
}

function mealMonthRow_(schoolId, period) {
  return readTable_('MealMonths').find(m => String(m.SchoolId) === String(schoolId) && String(m.Period).slice(0,7) === period);
}

function prevPeriod_(period) {
  const y = Number(period.slice(0,4)), m = Number(period.slice(5,7));
  return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
}

/**
 * Kế hoạch ăn của một trường trong một tháng (dùng khi tính học phí).
 * Trả về null nếu tháng chưa được thiết lập tiền ăn → khi đó tính theo "Số ngày ăn" nhập tay như trước.
 */
function mealPlanFor_(schoolId, period) {
  const month = mealMonthRow_(schoolId, period);
  if (!month || !month.FeeTypeId) return null;
  const planned = Number(month.PlannedDays || 0);
  const recs = {}, prev = {};
  const prevP = prevPeriod_(period);
  readTable_('MealRecords').forEach(r => {
    if (String(r.SchoolId) !== String(schoolId)) return;
    const p = String(r.Period).slice(0,7);
    if (p === period) recs[String(r.StudentId)] = r;
    else if (p === prevP) prev[String(r.StudentId)] = r;
  });
  return {
    month, feeTypeId:String(month.FeeTypeId), planned,
    registered: sid => recs[sid] ? truthy_(recs[sid].Registered) : prev[sid] ? truthy_(prev[sid].Registered) : true,
    days: sid => {
      const r = recs[sid];
      const reg = r ? truthy_(r.Registered) : prev[sid] ? truthy_(prev[sid].Registered) : true;
      if (!reg) return 0;
      return r && r.PlannedDays !== '' && r.PlannedDays !== null ? Number(r.PlannedDays) : planned;
    }
  };
}

/** Màn hình tiền ăn của một tháng. params: {schoolId, period, classId} */
function getMealMonth(params) {
  const user = requireCap_('recordMealAbsence');
  const schoolId = String(params.schoolId || ''), period = String(params.period || '').slice(0,7);
  if (!schoolId || !/^\d{4}-\d{2}$/.test(period)) throw new Error('Chọn trường và tháng.');
  assertSchoolAccess_(user, schoolId);
  const sc = scope_(user, {schoolId, classId:params.classId});
  const month = mealMonthRow_(schoolId, period);
  const plan = mealPlanFor_(schoolId, period);
  const rules = mealRules_(schoolId);
  const dailyFees = new Set(readTable_('FeeRates').filter(r => String(r.Frequency).toUpperCase() === 'DAILY').map(r => String(r.FeeTypeId)));
  const feeTypes = readTable_('FeeTypes').filter(f => truthy_(f.Active) && (String(f.CalculationMethod).toUpperCase() === 'PER_DAY' || dailyFees.has(String(f.FeeTypeId))))
    .map(f => ({id:f.FeeTypeId, name:f.FeeName}));
  const feeTypeId = month ? String(month.FeeTypeId) : (feeTypes[0] || {}).id || '';
  const range = monthRange_(period);
  const rate = readTable_('FeeRates').filter(r => String(r.SchoolId) === schoolId && String(r.FeeTypeId) === feeTypeId && truthy_(r.Active) &&
    overlaps_(range, r.ValidFrom, r.ValidTo)).sort((a,b) => String(b.ValidFrom).localeCompare(String(a.ValidFrom)))[0];
  const recs = {};
  readTable_('MealRecords').forEach(r => { if (String(r.SchoolId) === schoolId && String(r.Period).slice(0,7) === period) recs[String(r.StudentId)] = r; });
  // Đơn giá thực thu của dòng tiền ăn trên hóa đơn tháng này (sau giảm trừ).
  const billed = mealBilledUnit_(schoolId, period, feeTypeId);
  const planned = month ? Number(month.PlannedDays || 0) : 0;
  const rows = sc.students.filter(isActiveStudent_).map(s => {
    const sid = String(s.StudentId), r = recs[sid], c = sc.classMap[String(s.ClassId)] || {};
    const registered = plan ? plan.registered(sid) : true;
    const days = r && r.PlannedDays !== '' ? Number(r.PlannedDays) : planned;
    const rep = Number((r && r.ReportedAbsent) || 0), unrep = Number((r && r.UnreportedAbsent) || 0);
    const unit = billed[sid] ? billed[sid].unit : 0;
    const refundDays = registered ? Math.min(days, rep + (rules.refundUnreported ? unrep : 0)) : 0;
    return {studentId:sid, code:String(s.StudentCode || ''), name:s.FullName, classId:String(s.ClassId), className:c.ClassName || '',
      registered, plannedDays: registered ? days : 0, customDays: !!(r && r.PlannedDays !== '' && Number(r.PlannedDays) !== planned),
      reportedAbsent:rep, unreportedAbsent:unrep, actualMeals: registered ? Math.max(0, days - rep - unrep) : 0,
      billedQty: billed[sid] ? billed[sid].qty : 0, unitNet:unit, refundDays,
      refundAmount: r && truthy_(r.Settled) ? Number(r.RefundAmount || 0) : roundMoney_(refundDays * unit),
      settled: !!(r && truthy_(r.Settled)), adjustInvoiceId: r ? String(r.AdjustInvoiceId || '') : '', note: r ? (r.Note || '') : ''};
  }).sort((a,b) => (a.className + a.name).localeCompare(b.className + b.name, 'vi', {numeric:true}));
  const sum = k => rows.reduce((t,r) => t + Number(r[k] || 0), 0);
  const pending = readTable_('MealRecords').filter(r => String(r.SchoolId) === schoolId && truthy_(r.Settled) && Number(r.RefundAmount) > 0 && !r.AdjustInvoiceId);
  const smap = Object.fromEntries(readTable_('Students').map(s => [String(s.StudentId), s.FullName]));
  return {
    schoolId, period, month: month ? {status:month.Status || 'OPEN', feeTypeId:String(month.FeeTypeId), plannedDays:planned,
      closedAt:String(month.ClosedAt || ''), closedBy:month.ClosedBy || '', notes:month.Notes || ''} : null,
    feeTypes, feeTypeId, unitPrice: rate ? Number(rate.UnitPrice || 0) : 0, hasRate: !!rate, rules,
    canManage: can_(user, 'manageMeals'), isTeacher: user.role === 'TEACHER',
    pendingAbsences: readTable_('MealAbsences').filter(a => String(a.SchoolId) === schoolId && String(a.AbsenceDate).slice(0, 7) === period &&
      String(a.Status) === 'REPORTED' && sc.studentMap[String(a.StudentId)]).length,
    rows,
    summary: {students:rows.length, registered:rows.filter(r => r.registered).length, plannedMeals:sum('plannedDays'),
      reportedAbsent:sum('reportedAbsent'), unreportedAbsent:sum('unreportedAbsent'), actualMeals:sum('actualMeals'), refund:roundMoney_(sum('refundAmount')),
      billedStudents:Object.keys(billed).length},
    pendingRefunds: pending.filter(r => !params.classId || rows.some(x => x.studentId === String(r.StudentId))).map(r => ({recordId:r.RecordId,
      period:String(r.Period).slice(0,7), name:smap[String(r.StudentId)] || r.StudentId, amount:Number(r.RefundAmount), days:Number(r.RefundDays || 0)}))
  };
}

/** {studentId: {qty, unit}} — đơn giá thực thu tiền ăn trên hóa đơn học phí của tháng. */
function mealBilledUnit_(schoolId, period, feeTypeId) {
  const inv = {};
  readTable_('Invoices').forEach(i => {
    if (String(i.SchoolId) === String(schoolId) && String(i.Period).slice(0,7) === period && invoiceLive_(i) &&
        String(i.InvoiceType || 'TUITION').toUpperCase() === 'TUITION') inv[String(i.InvoiceId)] = String(i.StudentId);
  });
  const out = {};
  readTable_('InvoiceLines').forEach(l => {
    const sid = inv[String(l.InvoiceId)];
    if (!sid || String(l.FeeTypeId) !== String(feeTypeId) || !(Number(l.Quantity) > 0)) return;
    const o = out[sid] || (out[sid] = {qty:0, net:0});
    o.qty += Number(l.Quantity); o.net += Number(l.NetAmount || 0);
  });
  Object.keys(out).forEach(k => out[k].unit = roundMoney_(out[k].net / out[k].qty));
  return out;
}

/** Thiết lập tháng + quy định trừ tiền ăn của trường. */
function saveMealMonth(payload) {
  const user = requireCap_('manageMeals');
  const schoolId = String(payload.schoolId || ''), period = String(payload.period || '').slice(0,7);
  assertSchoolAccess_(user, schoolId);
  const feeTypeId = String(payload.FeeTypeId || '');
  const days = Number(payload.PlannedDays);
  if (!readTable_('FeeTypes').some(f => String(f.FeeTypeId) === feeTypeId)) throw new Error('Chọn khoản phí tiền ăn (cách tính "Theo ngày").');
  if (!(days >= 0 && days <= 31)) throw new Error('Số ngày ăn dự kiến phải từ 0 đến 31.');
  return withWriteLock_(() => {
    const m = mealMonthRow_(schoolId, period);
    if (m && String(m.Status).toUpperCase() === 'CLOSED') throw new Error('Tháng đã chốt, không sửa được thiết lập.');
    if (m) updateObjectById_('MealMonths', 'MonthId', m.MonthId, {FeeTypeId:feeTypeId, PlannedDays:days, Notes:String(payload.Notes || '')});
    else appendObject_('MealMonths', {MonthId:nextId_('MEALM'), SchoolId:schoolId, Period:asText_(period), FeeTypeId:feeTypeId, PlannedDays:days,
      Status:'OPEN', Notes:String(payload.Notes || ''), CreatedAt:new Date(), CreatedBy:user.email});
    if (payload.refundUnreported !== undefined) setSetting_(schoolId, 'MEAL_REFUND_UNREPORTED', payload.refundUnreported ? 'TRUE' : 'FALSE', user);
    if (payload.deadline !== undefined) setSetting_(schoolId, 'MEAL_DEADLINE', String(payload.deadline || ''), user);
    audit_('SAVE','MealMonths',schoolId + '|' + period,{feeTypeId, days});
    return {ok:true};
  });
}

/**
 * Lưu đăng ký / ngày nghỉ. rows: [{studentId, registered, plannedDays, reportedAbsent, unreportedAbsent, note}]
 * Giáo viên chỉ sửa được ngày nghỉ và ghi chú của học sinh lớp mình; đăng ký và số ngày dự kiến do kế toán.
 */
function saveMealRecords(payload) {
  const user = requireCap_('recordMealAbsence');
  const schoolId = String(payload.schoolId || ''), period = String(payload.period || '').slice(0,7);
  assertSchoolAccess_(user, schoolId);
  const manage = can_(user, 'manageMeals');
  return withWriteLock_(() => {
    const m = mealMonthRow_(schoolId, period);
    if (!m) throw new Error('Tháng chưa được thiết lập tiền ăn. Kế toán cần lưu thiết lập tháng trước.');
    if (String(m.Status).toUpperCase() === 'CLOSED') throw new Error('Tháng đã chốt tiền ăn, không sửa được.');
    const personal = personalStudentSet_(user);
    const stu = Object.fromEntries(readTable_('Students').filter(s => String(s.SchoolId) === schoolId).map(s => [String(s.StudentId), s]));
    const existing = {};
    readTable_('MealRecords').forEach(r => { if (String(r.SchoolId) === schoolId && String(r.Period).slice(0,7) === period) existing[String(r.StudentId)] = r; });
    const planned = Number(m.PlannedDays || 0);
    const patches = {}, adds = [], now = new Date();
    (payload.rows || []).forEach(x => {
      const sid = String(x.studentId);
      if (!stu[sid]) throw new Error('Học sinh không thuộc trường: ' + sid);
      if (personal && !personal.has(sid)) throw new Error('Bạn chỉ nhập được cho học sinh lớp mình.');
      const cur = existing[sid];
      const days = manage && x.plannedDays !== undefined && x.plannedDays !== '' ? Number(x.plannedDays) : (cur && cur.PlannedDays !== '' ? Number(cur.PlannedDays) : planned);
      const rep = Math.max(0, Number(x.reportedAbsent || 0)), unrep = Math.max(0, Number(x.unreportedAbsent || 0));
      if (!(days >= 0 && days <= 31)) throw new Error('Số ngày dự kiến không hợp lệ: ' + stu[sid].FullName);
      if (rep + unrep > days) throw new Error(stu[sid].FullName + ': tổng ngày nghỉ (' + (rep + unrep) + ') lớn hơn số ngày dự kiến (' + days + ').');
      const row = {PlannedDays:days, ReportedAbsent:rep, UnreportedAbsent:unrep, Note:String(x.note || ''), UpdatedAt:now, UpdatedBy:user.email};
      if (manage && x.registered !== undefined) row.Registered = !(x.registered === false || String(x.registered) === 'false');
      if (cur) patches[cur.RecordId] = row;
      else adds.push(Object.assign({RecordId:nextId_('MEAL'), SchoolId:schoolId, Period:asText_(period), StudentId:sid,
        Registered: row.Registered === undefined ? true : row.Registered, Settled:false}, row));
    });
    updateObjectsById_('MealRecords', 'RecordId', patches);
    appendObjects_('MealRecords', adds);
    audit_('SAVE','MealRecords',schoolId + '|' + period,{updated:Object.keys(patches).length, added:adds.length});
    return {ok:true, saved:Object.keys(patches).length + adds.length};
  });
}

/** Chốt tiền ăn tháng: tính số ngày & tiền được trừ cho từng học sinh, khóa tháng. */
function closeMealMonth(payload) {
  const user = requireCap_('manageMeals');
  const schoolId = String(payload.schoolId || ''), period = String(payload.period || '').slice(0,7);
  assertSchoolAccess_(user, schoolId);
  return withWriteLock_(() => {
    const m = mealMonthRow_(schoolId, period);
    if (!m) throw new Error('Tháng chưa được thiết lập tiền ăn.');
    if (String(m.Status).toUpperCase() === 'CLOSED') throw new Error('Tháng đã được chốt.');
    const pendingAbs = readTable_('MealAbsences').filter(a => String(a.SchoolId) === schoolId && String(a.AbsenceDate).slice(0, 7) === period && String(a.Status) === 'REPORTED').length;
    if (pendingAbs && !payload.force) throw new Error('PENDING_ABSENCES:' + pendingAbs);
    const rules = mealRules_(schoolId);
    const plan = mealPlanFor_(schoolId, period);
    const billed = mealBilledUnit_(schoolId, period, m.FeeTypeId);
    const existing = {};
    readTable_('MealRecords').forEach(r => { if (String(r.SchoolId) === schoolId && String(r.Period).slice(0,7) === period) existing[String(r.StudentId)] = r; });
    const students = readTable_('Students').filter(s => String(s.SchoolId) === schoolId && (isActiveStudent_(s) || existing[String(s.StudentId)] || billed[String(s.StudentId)]));
    const patches = {}, adds = [], now = new Date();
    let total = 0, count = 0, unbilled = 0;
    students.forEach(s => {
      const sid = String(s.StudentId), r = existing[sid];
      const registered = plan.registered(sid);
      const days = plan.days(sid);
      const rep = Number((r && r.ReportedAbsent) || 0), unrep = Number((r && r.UnreportedAbsent) || 0);
      const refundDays = registered ? Math.min(days, rep + (rules.refundUnreported ? unrep : 0)) : 0;
      const b = billed[sid];
      // Chỉ hoàn trên số ngày đã thực thu; chưa phát hành hóa đơn tiền ăn thì không hoàn.
      const effDays = b ? Math.min(refundDays, b.qty) : 0;
      if (refundDays > 0 && !b) unbilled++;
      const amount = roundMoney_(effDays * (b ? b.unit : 0));
      const row = {Registered:registered, PlannedDays:days, ReportedAbsent:rep, UnreportedAbsent:unrep, RefundDays:effDays,
        UnitNet: b ? b.unit : 0, RefundAmount:amount, Settled:true, UpdatedAt:now, UpdatedBy:user.email};
      if (amount > 0) { total += amount; count++; }
      if (r) patches[r.RecordId] = row;
      else adds.push(Object.assign({RecordId:nextId_('MEAL'), SchoolId:schoolId, Period:asText_(period), StudentId:sid, Note:'', AdjustInvoiceId:''}, row));
    });
    updateObjectsById_('MealRecords', 'RecordId', patches);
    appendObjects_('MealRecords', adds);
    updateObjectById_('MealMonths', 'MonthId', m.MonthId, {Status:'CLOSED', ClosedAt:now, ClosedBy:user.email});
    audit_('CLOSE','MealMonths',schoolId + '|' + period,{refundTotal:total, students:count});
    return {ok:true, refundTotal:roundMoney_(total), refundStudents:count, unbilled};
  });
}

/** Mở lại tháng đã chốt — chỉ khi chưa có khoản hoàn nào được trừ vào hóa đơn. */
function reopenMealMonth(payload) {
  const user = requireCap_('manageMeals');
  const schoolId = String(payload.schoolId || ''), period = String(payload.period || '').slice(0,7);
  assertSchoolAccess_(user, schoolId);
  return withWriteLock_(() => {
    const m = mealMonthRow_(schoolId, period);
    if (!m || String(m.Status).toUpperCase() !== 'CLOSED') throw new Error('Tháng chưa chốt.');
    const recs = readTable_('MealRecords').filter(r => String(r.SchoolId) === schoolId && String(r.Period).slice(0,7) === period);
    if (recs.some(r => r.AdjustInvoiceId)) throw new Error('Đã có khoản hoàn tiền ăn được trừ vào hóa đơn / hoàn tiền mặt — không mở lại được.');
    const patches = {};
    recs.forEach(r => patches[r.RecordId] = {Settled:false, RefundAmount:0, RefundDays:0});
    updateObjectsById_('MealRecords', 'RecordId', patches);
    updateObjectById_('MealMonths', 'MonthId', m.MonthId, {Status:'OPEN', ClosedAt:'', ClosedBy:''});
    audit_('REOPEN','MealMonths',schoolId + '|' + period,{});
    return {ok:true};
  });
}

/** Khoản hoàn không trừ được vào hóa đơn (VD học sinh nghỉ học) → ghi nhận đã hoàn tiền mặt / chuyển khoản. */
function markMealRefundPaid(recordId) {
  const user = requireCap_('manageMeals');
  return withWriteLock_(() => {
    const r = readTable_('MealRecords').find(x => String(x.RecordId) === String(recordId));
    if (!r) throw new Error('Không tìm thấy.');
    assertSchoolAccess_(user, r.SchoolId);
    if (r.AdjustInvoiceId) throw new Error('Khoản hoàn này đã được xử lý.');
    updateObjectById_('MealRecords', 'RecordId', r.RecordId, {AdjustInvoiceId:'CASH', UpdatedAt:new Date(), UpdatedBy:user.email});
    audit_('MEAL_REFUND_CASH','MealRecords',r.RecordId,{amount:r.RefundAmount});
    return {ok:true};
  });
}

/** Các khoản hoàn tiền ăn đã chốt, chưa trừ: {studentId: [{recordId, period, days, amount}]} */
function pendingMealRefunds_(schoolId) {
  const out = {};
  readTable_('MealRecords').forEach(r => {
    if (String(r.SchoolId) !== String(schoolId) || !truthy_(r.Settled) || !(Number(r.RefundAmount) > 0) || r.AdjustInvoiceId) return;
    (out[String(r.StudentId)] = out[String(r.StudentId)] || []).push({recordId:r.RecordId, period:String(r.Period).slice(0,7),
      days:Number(r.RefundDays || 0), amount:Number(r.RefundAmount), unit:Number(r.UnitNet || 0)});
  });
  return out;
}

// ===================== BÁO NGHỈ ĂN CỦA PHỤ HUYNH → GVCN XÁC NHẬN =====================
/*
 * Phụ huynh báo nghỉ theo ngày (trang phụ huynh). "Đúng hạn" = báo trước giờ hạn (MEAL_DEADLINE, VD 08:00) của chính ngày nghỉ.
 * Cuối tháng GVCN/kế toán xác nhận (CONFIRMED) hoặc từ chối (REJECTED). Khi xác nhận, bảng tiền ăn tháng được cập nhật:
 *   Nghỉ có báo = số ngày đã xác nhận báo đúng hạn; Nghỉ không báo ≥ số ngày đã xác nhận báo trễ.
 * Kế toán chỉ chốt tháng khi không còn ngày báo nghỉ chờ xác nhận (hoặc chọn chốt bỏ qua).
 */

/** Giờ hạn báo nghỉ dạng [giờ, phút] lấy từ quy định của trường (mặc định 08:00). */
function mealDeadlineHM_(schoolId) {
  const m = String(mealRules_(schoolId).deadline || '').match(/(\d{1,2})[:hH](\d{2})?/);
  return m ? [Math.min(23, Number(m[1])), Number(m[2] || 0)] : [8, 0];
}

/** Phụ huynh báo nghỉ ăn. payload: {studentId, from, to, reason} — tự bỏ qua thứ 7/CN/ngày lễ theo lịch trường. */
function parentReportAbsence(payload) {
  const user = requireCap_('parentPortal');
  const st = parentStudent_(user, payload.studentId);
  const from = normalizeDateText_(payload.from), to = normalizeDateText_(payload.to || payload.from);
  if (!from || !to || to < from) throw new Error('Chọn ngày nghỉ hợp lệ.');
  const today = Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd');
  if (from < today) throw new Error('Không báo nghỉ được cho ngày đã qua. Vui lòng liên hệ giáo viên chủ nhiệm.');
  const days = schoolDayList_(String(st.SchoolId), from, to);
  if (!days.length) throw new Error('Khoảng ngày đã chọn không có ngày học nào.');
  if (days.length > 31) throw new Error('Mỗi lần báo tối đa 31 ngày.');
  const [hh, mm] = mealDeadlineHM_(String(st.SchoolId));
  return withWriteLock_(() => {
    const existing = new Set(readTable_('MealAbsences').filter(a => String(a.StudentId) === String(st.StudentId) &&
      ['REPORTED','CONFIRMED'].includes(String(a.Status))).map(a => String(a.AbsenceDate).slice(0, 10)));
    const now = new Date(), rows = [], skipped = [];
    days.forEach(d => {
      if (existing.has(d)) { skipped.push(d); return; }
      const ms = parentMealStatus_(st, d.slice(0, 7));
      if (ms.closed) throw new Error('Tháng ' + periodLabel_(d.slice(0, 7)) + ' đã chốt tiền ăn, không báo nghỉ được nữa.');
      if (!ms.registered) throw new Error('Học sinh không đăng ký ăn bán trú tháng ' + periodLabel_(d.slice(0, 7)) + '.');
      const deadline = new Date(Number(d.slice(0,4)), Number(d.slice(5,7)) - 1, Number(d.slice(8,10)), hh, mm);
      rows.push({AbsenceId:nextId_('ABS'), SchoolId:st.SchoolId, StudentId:st.StudentId, AbsenceDate:asText_(d),
        Reason:String(payload.reason || '').slice(0, 200), OnTime: now < deadline, Status:'REPORTED',
        ReportedAt:now, ReportedBy:user.email, ConfirmedAt:'', ConfirmedBy:'', Note:''});
    });
    appendObjects_('MealAbsences', rows);
    audit_('PARENT_ABSENCE','MealAbsences',st.StudentId,{days:rows.length});
    return {ok:true, added:rows.length, skipped:skipped.length, late:rows.filter(r => !r.OnTime).length,
      deadline:String(hh).padStart(2,'0') + ':' + String(mm).padStart(2,'0')};
  });
}

function parentCancelAbsence(id) {
  const user = requireCap_('parentPortal');
  return withWriteLock_(() => {
    const a = readTable_('MealAbsences').find(x => String(x.AbsenceId) === String(id));
    if (!a || user.studentIds.indexOf(String(a.StudentId)) < 0) throw new Error('Không tìm thấy ngày báo nghỉ.');
    if (String(a.Status) !== 'REPORTED') throw new Error('Giáo viên đã xử lý ngày này, không hủy được.');
    if (String(a.AbsenceDate).slice(0, 10) < Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd')) throw new Error('Không hủy được ngày đã qua.');
    updateObjectById_('MealAbsences', 'AbsenceId', a.AbsenceId, {Status:'CANCELLED'});
    return {ok:true};
  });
}

/** Ngày báo nghỉ của 1 học sinh (trang phụ huynh). */
function studentAbsences_(studentId) {
  return readTable_('MealAbsences').filter(a => String(a.StudentId) === String(studentId) && String(a.Status) !== 'CANCELLED')
    .sort((a, b) => String(b.AbsenceDate).localeCompare(String(a.AbsenceDate))).slice(0, 60)
    .map(a => ({id:a.AbsenceId, date:String(a.AbsenceDate).slice(0, 10), reason:a.Reason || '', onTime:truthy_(a.OnTime), status:a.Status,
      confirmedBy:a.ConfirmedBy || ''}));
}

/** Danh sách báo nghỉ trong tháng cho GVCN / kế toán. params: {schoolId, period, classId} */
function listMealAbsences(params) {
  const user = requireCap_('recordMealAbsence');
  const schoolId = String(params.schoolId || ''), period = String(params.period || '').slice(0, 7);
  assertSchoolAccess_(user, schoolId);
  const sc = scope_(user, {schoolId, classId:params.classId});
  return readTable_('MealAbsences').filter(a => String(a.SchoolId) === schoolId && String(a.AbsenceDate).slice(0, 7) === period &&
      sc.studentMap[String(a.StudentId)] && String(a.Status) !== 'CANCELLED')
    .map(a => { const s = sc.studentMap[String(a.StudentId)];
      return {id:a.AbsenceId, studentId:String(a.StudentId), name:s.FullName, code:String(s.StudentCode || ''),
        className:(sc.classMap[String(s.ClassId)] || {}).ClassName || '', date:String(a.AbsenceDate).slice(0, 10), reason:a.Reason || '',
        onTime:truthy_(a.OnTime), status:a.Status, reportedAt:String(a.ReportedAt || '').slice(0, 16), confirmedBy:a.ConfirmedBy || ''}; })
    .sort((a, b) => (a.status === 'REPORTED' ? 0 : 1) - (b.status === 'REPORTED' ? 0 : 1) || (a.className + a.name + a.date).localeCompare(b.className + b.name + b.date, 'vi'));
}

/** GVCN / kế toán xác nhận hoặc từ chối ngày báo nghỉ, rồi cập nhật bảng tiền ăn. payload: {ids:[...], action:'CONFIRM'|'REJECT', note} */
function confirmMealAbsences(payload) {
  const user = requireCap_('recordMealAbsence');
  const action = String(payload.action || '').toUpperCase();
  if (!['CONFIRM','REJECT'].includes(action)) throw new Error('Thao tác không hợp lệ.');
  const ids = new Set((payload.ids || []).map(String));
  if (!ids.size) throw new Error('Chọn ngày báo nghỉ.');
  return withWriteLock_(() => {
    const personal = personalStudentSet_(user);
    const list = readTable_('MealAbsences').filter(a => ids.has(String(a.AbsenceId)));
    const patches = {}, touched = {}, now = new Date();
    list.forEach(a => {
      assertSchoolAccess_(user, a.SchoolId);
      if (personal && !personal.has(String(a.StudentId))) throw new Error('Bạn chỉ xác nhận được cho học sinh lớp mình.');
      const m = mealMonthRow_(String(a.SchoolId), String(a.AbsenceDate).slice(0, 7));
      if (m && String(m.Status).toUpperCase() === 'CLOSED') throw new Error('Tháng ' + periodLabel_(String(a.AbsenceDate).slice(0, 7)) + ' đã chốt tiền ăn.');
      patches[a.AbsenceId] = {Status: action === 'CONFIRM' ? 'CONFIRMED' : 'REJECTED', ConfirmedAt:now, ConfirmedBy:user.email, Note:String(payload.note || '')};
      touched[a.SchoolId + '|' + a.StudentId + '|' + String(a.AbsenceDate).slice(0, 7)] = true;
    });
    updateObjectsById_('MealAbsences', 'AbsenceId', patches);
    Object.keys(touched).forEach(k => { const [sch, sid, p] = k.split('|'); syncAbsenceCounts_(sch, sid, p, user); });
    audit_(action === 'CONFIRM' ? 'CONFIRM_ABSENCE' : 'REJECT_ABSENCE', 'MealAbsences', '', {count:list.length});
    return {ok:true, count:list.length};
  });
}

/** Cập nhật số ngày nghỉ trong bảng tiền ăn từ các ngày báo nghỉ đã xác nhận. Gọi trong khóa ghi. */
function syncAbsenceCounts_(schoolId, studentId, period, user) {
  const conf = readTable_('MealAbsences').filter(a => String(a.StudentId) === String(studentId) && String(a.AbsenceDate).slice(0, 7) === period && String(a.Status) === 'CONFIRMED');
  const onTime = conf.filter(a => truthy_(a.OnTime)).length, late = conf.length - onTime;
  const rec = readTable_('MealRecords').find(r => String(r.StudentId) === String(studentId) && String(r.Period).slice(0, 7) === period);
  const now = new Date();
  if (rec) updateObjectById_('MealRecords', 'RecordId', rec.RecordId, {ReportedAbsent:onTime, UnreportedAbsent:Math.max(Number(rec.UnreportedAbsent || 0), late), UpdatedAt:now, UpdatedBy:user.email});
  else appendObject_('MealRecords', {RecordId:nextId_('MEAL'), SchoolId:schoolId, Period:asText_(period), StudentId:studentId, Registered:true, PlannedDays:'',
    ReportedAbsent:onTime, UnreportedAbsent:late, Settled:false, AdjustInvoiceId:'', Note:'Từ báo nghỉ của phụ huynh', UpdatedAt:now, UpdatedBy:user.email});
}
