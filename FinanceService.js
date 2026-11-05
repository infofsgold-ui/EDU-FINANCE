/**
 * Xem trước tính phí cho một trường + kỳ thu.
 * - Bảng giá: đúng trường, Active, đúng cấp học (Level) và khối (Grade) nếu có khai báo,
 *   hiệu lực giao với tháng của kỳ thu (so theo ngày, chấp nhận YYYY-MM hoặc YYYY-MM-DD).
 *   Nếu nhiều giá cùng loại phí khớp: ưu tiên giá theo khối, rồi giá có ValidFrom mới nhất.
 * - Số lượng: FIXED = 1; PER_DAY = số ngày riêng của học sinh hoặc payload.defaultDays;
 *   QUANTITY = chỉ tính khi có số lượng đăng ký. Số lượng 0 thì không tạo dòng phí.
 * - Miễn giảm: áp dụng theo chính sách giá / hỗ trợ trong sheet Discounts (xem PolicyService.js).
 * - Học sinh đã có hóa đơn (không VOID) trong kỳ được đánh dấu và không phát hành lại.
 */
function calculatePreview(payload) {
  const user = requireCap_('calcFees');
  const schoolId = String(payload.schoolId || '');
  const periods = Array.from(new Set((Array.isArray(payload.periods) && payload.periods.length ? payload.periods : [payload.period])
    .map(p => String(p || '').slice(0,7)).filter(Boolean))).sort();
  if (!schoolId || !periods.length) throw new Error('Chọn trường và ít nhất một tháng thu.');
  periods.forEach(p => { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p)) throw new Error('Kỳ thu phải có dạng YYYY-MM: ' + p); });
  if (periods.length > 12) throw new Error('Chỉ tính tối đa 12 tháng mỗi lần.');
  assertSchoolAccess_(user, schoolId);
  const school = readTable_('Schools').find(s => String(s.SchoolId) === schoolId);
  if (!school) throw new Error('Không tìm thấy trường: ' + schoolId);
  const lines = [], skippedStudents = [], noFeeStudents = [], warnings = [], notices = [];
  const ratedFees = new Set(), zeroFees = {}, mealNotices = [];
  periods.forEach(period => {
    const r = previewPeriod_(school, schoolId, period, payload);
    r.lines.forEach(l => { l.period = period; lines.push(l); });
    r.skippedStudents.forEach(x => skippedStudents.push(Object.assign(x, {period})));
    r.noFee.forEach(x => noFeeStudents.push(Object.assign(x, {period})));
    if (!r.rateCount) warnings.push('Tháng ' + periodLabel_(period) + ': trường "' + school.SchoolName + '" chưa có bảng giá nào còn hiệu lực.');
    r.rateFeeIds.forEach(id => ratedFees.add(id));
    if (!r.meal && readTable_('MealMonths').some(m => String(m.SchoolId) === schoolId)) {
      mealNotices.push('Tháng ' + periodLabel_(period) + ' chưa thiết lập tiền ăn (trang Tiền ăn) — khoản phí theo ngày đang tính theo "Số ngày ăn bán trú" nhập ở đây.');
    }
    if (r.meal) {
      mealNotices.push('Tháng ' + periodLabel_(period) + ': "' + r.meal.feeName + '" tạm tính theo đăng ký ăn (' + r.meal.students + ' học sinh, ' + r.meal.planned + ' ngày dự kiến).');
      delete r.zeroQty[r.meal.feeName];
    }
    Object.keys(r.zeroQty).forEach(name => zeroFees[name] = r.zeroQty[name]);
  });
  // Khoản phí đang dùng nhưng chưa có mức giá tại trường trong các tháng đã chọn.
  readTable_('FeeTypes').filter(f => truthy_(f.Active) && String(f.FeeTypeId) !== 'SALE' && !ratedFees.has(String(f.FeeTypeId)))
    .forEach(f => notices.push('Khoản phí "' + f.FeeName + '" (' + f.FeeTypeId + ') chưa có mức giá tại trường này trong các tháng đã chọn nên không được tính. ' +
      'Nếu khoản này áp dụng cho trường, vào Danh mục → Bảng giá để thêm đơn giá.'));
  Object.keys(zeroFees).forEach(name => notices.push(zeroFees[name] === 'PER_DAY'
    ? 'Khoản phí theo ngày "' + name + '" chưa được tính vì "Số ngày ăn bán trú" đang là 0 — nhập số ngày rồi bấm Tính xem trước lại.'
    : 'Khoản phí theo số lượng "' + name + '" chỉ tính cho học sinh có đăng ký số lượng.'));
  if (!readTable_('FeeRates').some(r => String(r.SchoolId) === schoolId && truthy_(r.Active))) {
    const other = readTable_('FeeRates').filter(r => truthy_(r.Active) && String(r.SchoolId) !== schoolId);
    warnings.unshift('Trường "' + school.SchoolName + '" chưa có mức giá nào trong Bảng giá.' +
      (other.length ? ' Có ' + other.length + ' mức giá đang gán cho trường khác — kiểm tra lại cột Trường trong Danh mục → Bảng giá.' : ''));
  }
  // Hoàn tiền ăn của các tháng đã chốt → dòng âm trên hóa đơn đầu tiên (theo tháng) phát hành sau tháng được hoàn.
  const refunds = pendingMealRefunds_(schoolId);
  let refundApplied = 0, refundWaiting = 0;
  const groups = {};
  lines.forEach(l => { const k = l.studentId + '|' + l.period; (groups[k] = groups[k] || {sid:l.studentId, name:l.studentName, period:l.period, total:0}).total += l.netAmount; });
  const byStudent = {};
  Object.values(groups).sort((a,b) => a.period.localeCompare(b.period)).forEach(g => (byStudent[g.sid] = byStudent[g.sid] || []).push(g));
  Object.keys(refunds).forEach(sid => {
    refunds[sid].sort((a,b) => a.period.localeCompare(b.period)).forEach(rf => {
      const g = (byStudent[sid] || []).find(x => x.period > rf.period && x.total >= rf.amount);
      if (!g) { refundWaiting++; return; }
      g.total -= rf.amount; refundApplied += rf.amount;
      lines.push({studentId:sid, studentName:g.name, period:g.period, feeTypeId:MEAL_REFUND_FEE_ID,
        feeName:'Hoàn tiền ăn ' + periodLabel_(rf.period) + ' (' + rf.days + ' ngày nghỉ có báo)', quantity:rf.days, unitPrice:-rf.unit,
        grossAmount:-rf.amount, discountAmount:0, netAmount:-rf.amount, discountNote:'', mealRecordId:rf.recordId});
    });
  });
  if (refundApplied) mealNotices.push('Đã trừ ' + fmtMoney_(refundApplied) + 'đ hoàn tiền ăn các tháng đã chốt vào hóa đơn.');
  if (refundWaiting) mealNotices.push(refundWaiting + ' khoản hoàn tiền ăn chưa trừ được (học sinh không có hóa đơn tháng sau trong lần tính này hoặc không đủ để trừ) — sẽ trừ ở lần sau, hoặc xử lý hoàn tiền mặt ở trang Tiền ăn.');
  notices.unshift.apply(notices, mealNotices);
  const sum = k => roundMoney_(lines.reduce((s,l)=>s+l[k],0));
  return {
    schoolId, periods, period: periods[0], studentCount: new Set(lines.map(l => l.studentId)).size, lineCount:lines.length,
    invoiceCount: new Set(lines.map(l => l.studentId + '|' + l.period)).size,
    skippedCount:skippedStudents.length, skippedStudents:skippedStudents.slice(0,200),
    noFeeCount:noFeeStudents.length, noFeeStudents:noFeeStudents.slice(0,300), warnings, notices,
    filteredStudents: readTable_('Students').filter(x => String(x.SchoolId) === schoolId && String(x.Status).toUpperCase() === 'ACTIVE').length,
    totalGross:sum('grossAmount'), totalDiscount:sum('discountAmount'), totalNet:sum('netAmount'),
    lines:lines.slice(0,8000), truncated: lines.length > 8000
  };
}

/** Tính phí cho một tháng (dùng nội bộ bởi calculatePreview). */
function previewPeriod_(school, schoolId, period, payload) {
  const range = monthRange_(period);
  const classMap = Object.fromEntries(readTable_('Classes').map(c => [String(c.ClassId), c]));
  const classOf = s => classMap[String(s.ClassId)] || {};
  // Học sinh được tính phí trong tháng: đang học, hoặc đã nghỉ/chuyển trường nhưng ngày nghỉ (LeaveDate) rơi vào/sau tháng này;
  // và đã nhập học trước khi tháng kết thúc.
  const day = v => normalizeDateText_(v) || String(v || '').slice(0, 10);
  const billable = s => {
    const enroll = day(s.EnrollmentDate), leave = day(s.LeaveDate);
    if (enroll && enroll > range.end) return false;
    if (leave && leave < range.start) return false;
    return String(s.Status || 'ACTIVE').toUpperCase() === 'ACTIVE' || !!leave;
  };
  const totalDays = schoolDays_(schoolId, range.start, range.end);
  const prorate = !(payload.prorate === false || String(payload.prorate) === 'false');
  const students = readTable_('Students').filter(s => String(s.SchoolId)===schoolId && billable(s) &&
    (!payload.classId || String(s.ClassId) === String(payload.classId)) &&
    (!payload.level || levelOfClass_(classOf(s), school) === payload.level));
  const feeMap = Object.fromEntries(readTable_('FeeTypes').filter(f => truthy_(f.Active)).map(f => [String(f.FeeTypeId), f]));
  const rates = readTable_('FeeRates').filter(r => String(r.SchoolId)===schoolId && truthy_(r.Active) &&
    overlaps_(range, r.ValidFrom, r.ValidTo) && feeMap[String(r.FeeTypeId)]);
  const dctx = discountContext_(schoolId, range);
  const invoiced = new Set(readTable_('Invoices')
    .filter(i => String(i.SchoolId)===schoolId && String(i.Period).slice(0,7)===period && String(i.Status).toUpperCase() !== 'VOID' &&
      String(i.InvoiceType || 'TUITION').toUpperCase() === 'TUITION')
    .map(i => String(i.StudentId)));
  const quantities = payload.quantities || {};
  // Số ngày cho phí theo ngày: nhập tay, hoặc để trống/0 = số ngày học của tháng theo lịch trường.
  const defaultDays = Number(payload.defaultDays || 0) || totalDays;

  const lines = [];
  const skippedStudents = [], noFee = [], zeroQty = {};
  const meal = mealPlanFor_(schoolId, period);
  let mealUsed = 0;
  students.forEach(student => {
    const before = lines.length;
    const sid = String(student.StudentId);
    if (invoiced.has(sid)) { skippedStudents.push({studentId:sid, studentName:student.FullName}); return; }
    const cls = classMap[String(student.ClassId)] || {};
    const grade = String(cls.Grade || '');
    // Vào học / nghỉ học giữa tháng → chỉ tính số ngày học thực tế.
    const from = [range.start, day(student.EnrollmentDate)].filter(Boolean).sort().pop();
    const to = [range.end, day(student.LeaveDate)].filter(Boolean).sort()[0];
    const partial = prorate && (from > range.start || to < range.end);
    const attended = partial ? schoolDays_(schoolId, from, to) : totalDays;
    // Chọn một mức giá duy nhất cho mỗi loại phí.
    const best = {};
    const level = levelOfClass_(cls, school);
    let matchedRates = 0;
    // Giá theo cấp học so với cấp của lớp (trường liên cấp có nhiều cấp); chấp nhận cả giá ghi theo cấp của trường như bản cũ.
    rates.filter(r => (!r.Grade || String(r.Grade) === grade) &&
      (!r.Level || [level, normalizeLevel_(school.Level), String(school.Level || '')].includes(normalizeLevel_(r.Level) || String(r.Level)))).forEach(r => {
      matchedRates++;
      const k = String(r.FeeTypeId), cur = best[k];
      const score = [r.Grade ? 1 : 0, String(r.ValidFrom || '')];
      if (!cur || score[0] > cur.score[0] || (score[0] === cur.score[0] && score[1] > cur.score[1])) best[k] = {rate:r, score};
    });
    Object.keys(best).forEach(feeTypeId => {
      const rate = best[feeTypeId].rate, ft = feeMap[feeTypeId];
      const override = quantities[sid] && quantities[sid][feeTypeId];
      // Mức giá chu kỳ "Theo ngày" (DAILY) luôn tính = đơn giá × số ngày, kể cả khi khoản phí đang để cách tính khác.
      const method = String(rate.Frequency).toUpperCase() === 'DAILY' ? 'PER_DAY' : String(ft.CalculationMethod || 'FIXED').toUpperCase();
      let quantity;
      const isMeal = meal && feeTypeId === meal.feeTypeId;
      if (override !== undefined && override !== '') quantity = Number(override);
      else if (isMeal) { quantity = meal.days(sid); if (!meal.registered(sid)) return; if (partial) quantity = Math.min(quantity, attended); mealUsed++; }
      else if (method === 'PER_DAY') quantity = partial ? attended : defaultDays;
      else if (method === 'QUANTITY') quantity = 0;
      else quantity = 1;
      if (!(quantity > 0)) { zeroQty[ft.FeeName] = method; return; }
      let unitPrice = Number(rate.UnitPrice || 0), feeName = ft.FeeName;
      const freq = String(rate.Frequency || 'MONTHLY').toUpperCase();
      if (partial && method === 'FIXED' && freq === 'MONTHLY' && totalDays > 0) {
        // Phí tháng tính theo tỷ lệ ngày học thực tế.
        unitPrice = Math.round(unitPrice * attended / totalDays);
        feeName = ft.FeeName + ' (học ' + attended + '/' + totalDays + ' ngày)';
      } else if (partial && method === 'PER_DAY') feeName = ft.FeeName + ' (' + attended + ' ngày học)';
      if (!(unitPrice > 0) && Number(rate.UnitPrice) > 0) { zeroQty[ft.FeeName] = method; return; }
      const gross = roundMoney_(quantity * unitPrice);
      const d = matchDiscounts_(dctx, student, cls, level, feeTypeId, gross);
      const discount = Math.min(gross, d.amount);
      lines.push({
        studentId:sid, studentName:student.FullName, feeTypeId, feeName, quantity, unitPrice,
        grossAmount:gross, discountAmount:discount, netAmount:roundMoney_(gross - discount), discountNote:d.note
      });
    });
    if (lines.length === before) {
      // Giải thích vì sao học sinh không có khoản phí nào để kế toán sửa dữ liệu.
      const reason = !rates.length ? 'Trường chưa có bảng giá còn hiệu lực trong tháng này'
        : !matchedRates ? 'Không có mức giá khớp khối "' + grade + '" / cấp ' + (LEVELS[level] || level || '?') + ' của lớp'
        : 'Các khoản phí đều có số lượng 0 (phí theo ngày cần nhập số ngày, phí theo số lượng cần đăng ký)';
      noFee.push({studentId:sid, studentName:student.FullName, className:cls.ClassName || '', reason});
    }
  });
  return {lines, skippedStudents, noFee, rateCount: rates.length, zeroQty, rateFeeIds: rates.map(r => String(r.FeeTypeId)),
    meal: meal ? {feeName:(feeMap[meal.feeTypeId] || {}).FeeName || meal.feeTypeId, planned:meal.planned, students:mealUsed} : null};
}

/**
 * Phát hành công nợ. Chạy lại an toàn: học sinh đã có hóa đơn trong kỳ (không VOID) sẽ được bỏ qua.
 * Muốn phát hành lại cho một học sinh: đổi Status hóa đơn cũ thành VOID (có kiểm soát) rồi chạy lại.
 * Sau khi tạo hóa đơn, tiền thu trước/còn dư của học sinh được tự động phân bổ vào hóa đơn mới.
 */
function postInvoices(payload) {
  const user = requireCap_('calcFees');
  if (!payload.confirm) throw new Error('Cần xác nhận phát hành kỳ thu.');
  return withWriteLock_(() => {
    const preview = calculatePreview(payload); // tính lại trong khóa để kiểm tra trùng trên dữ liệu mới nhất
    if (preview.truncated) throw new Error('Quá nhiều dòng phí trong một lần phát hành. Hãy chọn ít tháng hơn.');
    // Mỗi học sinh × mỗi tháng = một hóa đơn (giữ chống trùng theo kỳ và báo cáo theo tháng).
    const groups = {};
    preview.lines.forEach(line => (groups[line.studentId + '|' + line.period] = groups[line.studentId + '|' + line.period] || []).push(line));
    const now = new Date();
    const invoices = [], invoiceLines = [], mealPatches = {};
    Object.keys(groups).forEach(key => {
      const lines = groups[key], studentId = lines[0].studentId, period = lines[0].period;
      const invoiceId = nextId_('INV');
      const gross = roundMoney_(lines.reduce((s,l)=>s+l.grossAmount,0));
      const disc = roundMoney_(lines.reduce((s,l)=>s+l.discountAmount,0));
      const net = roundMoney_(gross - disc);
      invoices.push({
        InvoiceId:invoiceId, SchoolId:preview.schoolId, StudentId:studentId, Period:asText_(period),
        IssueDate:now, DueDate:String(payload.dueDate||''), GrossAmount:gross, DiscountAmount:disc,
        NetAmount:net, PaidAmount:0, Balance:net, Status:net > 0 ? 'UNPAID' : 'PAID', CreatedAt:now, CreatedBy:user.email,
        InvoiceType:'TUITION', Notes: preview.periods.length > 1 ? 'Đợt thu ' + preview.periods.map(periodLabel_).join(', ') : ''
      });
      lines.forEach(line => { if (line.mealRecordId) mealPatches[line.mealRecordId] = {AdjustInvoiceId:invoiceId}; });
      lines.forEach(line => invoiceLines.push({
        LineId:nextId_('LIN'), InvoiceId:invoiceId, StudentId:studentId, FeeTypeId:line.feeTypeId,
        Description:line.feeName, Quantity:line.quantity, UnitPrice:line.unitPrice, GrossAmount:line.grossAmount,
        DiscountAmount:line.discountAmount, NetAmount:line.netAmount, DiscountNote:line.discountNote || ''
      }));
    });
    appendObjects_('Invoices', invoices);
    appendObjects_('InvoiceLines', invoiceLines);
    updateObjectsById_('MealRecords', 'RecordId', mealPatches);
    const alloc = allocateForStudents_(preview.schoolId, Array.from(new Set(preview.lines.map(l => l.studentId))), user);
    audit_('POST_INVOICES','Invoices',preview.periods.join(','),{
      schoolId:preview.schoolId, count:invoices.length, total:preview.totalNet, discount:preview.totalDiscount,
      skippedDuplicate:preview.skippedCount, autoAllocated:alloc.amount
    });
    return {ok:true, count:invoices.length, total:preview.totalNet, skipped:preview.skippedCount, allocated:alloc.amount};
  });
}

function recordPayment(payload) {
  const user = requireCap_('receivePayment');
  const schoolId = String(payload.SchoolId||'');
  const studentId = String(payload.StudentId||'').trim();
  assertSchoolAccess_(user,schoolId);
  const amount = Number(payload.Amount);
  if (!schoolId || !studentId || !(amount>0)) throw new Error('Trường, học sinh và số tiền hợp lệ là bắt buộc.');
  return withWriteLock_(() => {
    const student = readTable_('Students').find(s => String(s.StudentId) === studentId || String(s.StudentCode) === studentId);
    if (!student || String(student.SchoolId) !== schoolId) throw new Error('Không tìm thấy học sinh ' + studentId + ' trong trường đã chọn.');
    const reference = String(payload.Reference||'').trim();
    if (reference && readTable_('Payments').some(p => String(p.SchoolId)===schoolId && String(p.Reference).trim()===reference && p.Status!=='VOID'))
      throw new Error('Mã tham chiếu "' + reference + '" đã được ghi nhận trước đó. Kiểm tra để tránh ghi trùng.');
    const id = nextId_('PAY');
    appendObject_('Payments',{
      PaymentId:id, SchoolId:schoolId, StudentId:String(student.StudentId), PaymentDate:String(payload.PaymentDate||Utilities.formatDate(new Date(),APP.TZ,'yyyy-MM-dd')),
      Amount:roundMoney_(amount), Method:String(payload.Method||'BANK_TRANSFER'), Reference:asText_(reference),
      Notes:String(payload.Notes||''), Status:'RECORDED', CreatedAt:new Date(), CreatedBy:user.email
    });
    const alloc = allocateForStudents_(schoolId, [String(student.StudentId)], user);
    audit_('RECORD_PAYMENT','Payments',id,{schoolId,studentId:student.StudentId,amount,allocated:alloc.amount});
    return {ok:true, id, allocated:alloc.amount, credit:roundMoney_(alloc.credit), invoicesTouched:alloc.invoices};
  });
}

/**
 * Phân bổ FIFO: tiền chưa phân bổ của các khoản thu (theo ngày thu) vào hóa đơn còn nợ
 * (theo hạn thanh toán/kỳ thu cũ nhất trước). Ghi Allocations và cập nhật PaidAmount/Balance/Status.
 * Gọi bên trong withWriteLock_.
 */
function allocateForStudents_(schoolId, studentIds, user) {
  const ids = new Set(studentIds.map(String));
  const allocated = {};
  readTable_('Allocations').forEach(a => allocated[a.PaymentId] = (allocated[a.PaymentId]||0) + Number(a.Amount||0));
  const payments = readTable_('Payments')
    .filter(p => String(p.SchoolId)===schoolId && ids.has(String(p.StudentId)) && p.Status==='RECORDED')
    .map(p => ({id:p.PaymentId, student:String(p.StudentId), date:String(p.PaymentDate), left:roundMoney_(Number(p.Amount||0) - (allocated[p.PaymentId]||0))}))
    .filter(p => p.left > 0)
    .sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const invoices = readTable_('Invoices')
    .filter(i => String(i.SchoolId)===schoolId && ids.has(String(i.StudentId)) && Number(i.Balance||0) > 0 && String(i.Status).toUpperCase() !== 'VOID')
    .map(i => ({id:i.InvoiceId, student:String(i.StudentId), key:String(i.DueDate || i.Period) + '|' + String(i.Period),
                paid:Number(i.PaidAmount||0), balance:Number(i.Balance||0)}))
    .sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const rows = [], patches = {}, now = new Date();
  let total = 0;
  payments.forEach(p => {
    invoices.filter(i => i.student === p.student && i.balance > 0).forEach(inv => {
      if (p.left <= 0) return;
      const amt = roundMoney_(Math.min(p.left, inv.balance));
      p.left = roundMoney_(p.left - amt);
      inv.paid = roundMoney_(inv.paid + amt);
      inv.balance = roundMoney_(inv.balance - amt);
      total += amt;
      rows.push({AllocationId:nextId_('ALC'), PaymentId:p.id, InvoiceId:inv.id, Amount:amt, CreatedAt:now, CreatedBy:user.email});
      patches[inv.id] = {PaidAmount:inv.paid, Balance:inv.balance, Status:inv.balance <= 0 ? 'PAID' : 'PARTIAL'};
    });
  });
  appendObjects_('Allocations', rows);
  updateObjectsById_('Invoices', 'InvoiceId', patches);
  return {amount:roundMoney_(total), invoices:Object.keys(patches).length, credit:payments.reduce((s,p)=>s+p.left,0)};
}

/** Khoảng ngày của kỳ thu YYYY-MM. */
/**
 * Số ngày học trong khoảng [from, to] (YYYY-MM-DD) theo cấu hình trường:
 * SCHOOL_DAYS_PER_WEEK (5 = thứ 2–6, 6 = thứ 2–7; mặc định 5) và SCHOOL_HOLIDAYS (danh sách ngày nghỉ lễ, cách nhau dấu phẩy).
 */
function schoolDays_(schoolId, from, to) {
  if (!from || !to || from > to) return 0;
  const perWeek = Number(getSetting_(schoolId, 'SCHOOL_DAYS_PER_WEEK') || 5) >= 6 ? 6 : 5;
  const holidays = new Set(String(getSetting_(schoolId, 'SCHOOL_HOLIDAYS') || '').split(/[,;\s]+/).map(normalizeDateText_).filter(Boolean));
  let n = 0;
  const d = new Date(Number(from.slice(0,4)), Number(from.slice(5,7)) - 1, Number(from.slice(8,10)));
  const end = new Date(Number(to.slice(0,4)), Number(to.slice(5,7)) - 1, Number(to.slice(8,10)));
  for (; d <= end; d.setDate(d.getDate() + 1)) {
    const wd = d.getDay(); // 0 = CN
    if (wd === 0 || (wd === 6 && perWeek === 5)) continue;
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (!holidays.has(key)) n++;
  }
  return n;
}

/** Danh sách ngày học (YYYY-MM-DD) trong khoảng, theo cùng quy tắc schoolDays_. */
function schoolDayList_(schoolId, from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  const d = new Date(Number(from.slice(0,4)), Number(from.slice(5,7)) - 1, Number(from.slice(8,10)));
  const end = new Date(Number(to.slice(0,4)), Number(to.slice(5,7)) - 1, Number(to.slice(8,10)));
  for (; d <= end && out.length < 62; d.setDate(d.getDate() + 1)) {
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (schoolDays_(schoolId, key, key)) out.push(key);
  }
  return out;
}

/** Nhận 'YYYY-MM-DD' hoặc 'DD/MM/YYYY' → 'YYYY-MM-DD'. */
function normalizeDateText_(v) {
  const s = String(v || '').trim();
  // Số sê-ri ngày kiểu bảng tính (VD 46266 = 2026-09-01) khi ô ngày bị lưu dạng số.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return '';
}

function periodLabel_(p) { p = String(p).slice(0,7); return 'T' + Number(p.slice(5,7)) + '/' + p.slice(0,4); }

function monthRange_(period) {
  const y = Number(period.slice(0,4)), m = Number(period.slice(5,7));
  const last = new Date(y, m, 0).getDate();
  return {start: period + '-01', end: period + '-' + String(last).padStart(2,'0')};
}

/** Hiệu lực [from, to] có giao với khoảng range không. from/to dạng YYYY-MM hoặc YYYY-MM-DD; trống = không giới hạn. */
function overlaps_(range, from, to) {
  const f = from ? normDate_(from, false) : '0000-01-01';
  const t = to ? normDate_(to, true) : '9999-12-31';
  return f <= range.end && t >= range.start;
}

function normDate_(v, isEnd) {
  const s = String(v).trim();
  if (/^\d{4}-\d{2}$/.test(s)) return isEnd ? monthRange_(s).end : s + '-01';
  return s.slice(0,10);
}

function roundMoney_(n) { return Math.round((Number(n)+Number.EPSILON)*100)/100; }

function getFinanceSummary() {
  const user = currentUser_();
  const schoolAllowed = new Set(listSchoolsForUser_(user).map(s=>String(s.SchoolId)));
  const invoices = readTable_('Invoices').filter(i=>schoolAllowed.has(String(i.SchoolId)) && String(i.Status).toUpperCase()!=='VOID');
  const payments = readTable_('Payments').filter(p=>schoolAllowed.has(String(p.SchoolId)) && p.Status==='RECORDED');
  const allocatedByPayment = {};
  readTable_('Allocations').forEach(a => allocatedByPayment[a.PaymentId] = (allocatedByPayment[a.PaymentId]||0) + Number(a.Amount||0));
  const paid = payments.reduce((s,p)=>s+Number(p.Amount||0),0);
  const allocated = payments.reduce((s,p)=>s+(allocatedByPayment[p.PaymentId]||0),0);
  return {
    invoiceCount:invoices.length,
    receivable:roundMoney_(invoices.reduce((s,i)=>s+Number(i.NetAmount||0),0)),
    balance:roundMoney_(invoices.reduce((s,i)=>s+Number(i.Balance||0),0)),
    payments:roundMoney_(paid),
    unallocated:roundMoney_(paid - allocated)
  };
}

/** Ép Google Sheets lưu dạng văn bản (tránh tự đổi "2026-10" thành ngày hoặc "00123" thành số). */
function asText_(s) { return s === '' ? '' : "'" + s; }
