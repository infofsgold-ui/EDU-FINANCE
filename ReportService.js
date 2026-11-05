/**
 * Phạm vi dữ liệu theo người dùng + bộ lọc {schoolId, level, classId}.
 * Trả về các map dùng chung cho dashboard, danh sách học sinh và báo cáo.
 */
function scope_(user, filter) {
  filter = filter || {};
  let schools = listSchoolsForUser_(user);
  if (filter.schoolId) schools = schools.filter(s => String(s.SchoolId) === String(filter.schoolId));
  const schoolMap = Object.fromEntries(schools.map(s => [String(s.SchoolId), s]));
  const classMap = {};
  readTable_('Classes').forEach(c => {
    if (!schoolMap[String(c.SchoolId)]) return;
    const lv = levelOfClass_(c, schoolMap[String(c.SchoolId)]);
    if (filter.level && lv !== filter.level) return;
    if (filter.classId && String(c.ClassId) !== String(filter.classId)) return;
    classMap[String(c.ClassId)] = Object.assign({}, c, {Level: lv});
  });
  const personal = personalStudentSet_(user);
  const narrowed = !!(filter.level || filter.classId);
  const students = readTable_('Students').filter(s => {
    if (!schoolMap[String(s.SchoolId)]) return false;
    if (personal && !personal.has(String(s.StudentId))) return false;
    if (classMap[String(s.ClassId)]) return true;
    if (narrowed) return false;
    // Học sinh có ClassId không còn tồn tại vẫn thuộc trường khi không lọc theo lớp/cấp.
    return true;
  });
  const studentMap = Object.fromEntries(students.map(s => [String(s.StudentId), s]));
  return {schools, schoolMap, classMap, students, studentMap, personal, narrowed};
}

function isActiveStudent_(s) { return String(s.Status || 'ACTIVE').toUpperCase() === 'ACTIVE'; }
function invoiceLive_(i) { return String(i.Status).toUpperCase() !== 'VOID'; }
function yearOf_(d) { return String(d || '').slice(0,4); }
function monthIdx_(d) { return Number(String(d || '').slice(5,7)) - 1; }

/** Dashboard lãnh đạo. filter: {schoolId, level, classId, year} */
function getDashboardData(filter) {
  const user = requireCap_('viewDashboard');
  filter = filter || {};
  return memo_('dashboard', [user.role, listSchoolsForUser_(user).map(x => String(x.SchoolId)), filter], () => dashboardData_(user, filter));
}

function dashboardData_(user, filter) {
  const year = String(filter.year || Utilities.formatDate(new Date(), APP.TZ, 'yyyy'));
  const sc = scope_(user, filter);
  const inScope = id => !!sc.studentMap[String(id)];

  const invoices = readTable_('Invoices').filter(i => invoiceLive_(i) && inScope(i.StudentId));
  const payments = readTable_('Payments').filter(p => p.Status === 'RECORDED' && inScope(p.StudentId));
  const expenses = readTable_('Expenses').filter(e => sc.schoolMap[String(e.SchoolId)] && expenseCounts_(e));

  const revenue = Array(12).fill(0), expense = Array(12).fill(0), billed = Array(12).fill(0);
  payments.forEach(p => { if (yearOf_(p.PaymentDate) === year) revenue[monthIdx_(p.PaymentDate)] += Number(p.Amount||0); });
  expenses.forEach(e => { if (yearOf_(e.ExpenseDate) === year) expense[monthIdx_(e.ExpenseDate)] += Number(e.Amount||0); });
  invoices.forEach(i => { if (yearOf_(i.Period) === year) billed[monthIdx_(i.Period)] += Number(i.NetAmount||0); });

  // Tổng hợp theo học sinh
  const perStudent = {};
  const today = Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd');
  invoices.forEach(i => {
    const k = String(i.StudentId), a = perStudent[k] || (perStudent[k] = {net:0, paid:0, balance:0, overdue:0});
    a.net += Number(i.NetAmount||0); a.paid += Number(i.PaidAmount||0); a.balance += Number(i.Balance||0);
    if (Number(i.Balance||0) > 0 && i.DueDate && String(i.DueDate).slice(0,10) < today) a.overdue += Number(i.Balance||0);
  });

  const group = (keyFn, labelFn) => {
    const g = {};
    sc.students.forEach(s => {
      const k = keyFn(s); if (k === null) return;
      const row = g[k] || (g[k] = {key:k, label:labelFn(s, k), students:0, net:0, paid:0, balance:0, overdue:0, debtors:0});
      if (isActiveStudent_(s)) row.students++;
      const a = perStudent[String(s.StudentId)];
      if (a) { row.net += a.net; row.paid += a.paid; row.balance += a.balance; row.overdue += a.overdue; if (a.balance > 0) row.debtors++; }
    });
    return Object.values(g).map(r => Object.assign(r, {rate: r.net ? r.paid / r.net : 0}));
  };

  const expBySchool = {}, revBySchool = {};
  expenses.forEach(e => { if (yearOf_(e.ExpenseDate) === year) expBySchool[e.SchoolId] = (expBySchool[e.SchoolId]||0) + Number(e.Amount||0); });
  payments.forEach(p => { if (yearOf_(p.PaymentDate) === year) revBySchool[p.SchoolId] = (revBySchool[p.SchoolId]||0) + Number(p.Amount||0); });
  const bySchool = group(s => String(s.SchoolId), s => (sc.schoolMap[String(s.SchoolId)]||{}).SchoolName || s.SchoolId)
    .map(r => Object.assign(r, {revenueYear: revBySchool[r.key]||0, expenseYear: expBySchool[r.key]||0,
      level: LEVELS[normalizeLevel_((sc.schoolMap[r.key]||{}).Level)] || ''}));
  const byLevel = group(s => (sc.classMap[String(s.ClassId)]||{}).Level || normalizeLevel_((sc.schoolMap[String(s.SchoolId)]||{}).Level) || 'KHAC',
    (s, k) => LEVELS[k] || 'Chưa phân cấp');
  const byClass = group(s => String(s.ClassId || ''), s => {
    const c = sc.classMap[String(s.ClassId)];
    return c ? c.ClassName + (sc.schools.length > 1 ? ' · ' + (sc.schoolMap[String(c.SchoolId)]||{}).SchoolName : '') : '(Chưa xếp lớp)';
  }).sort((a,b) => b.balance - a.balance);

  // Cơ cấu phải thu theo khoản phí trong năm
  const yearInvoiceIds = new Set(invoices.filter(i => yearOf_(i.Period) === year).map(i => String(i.InvoiceId)));
  const feeMix = {};
  readTable_('InvoiceLines').forEach(l => {
    if (!yearInvoiceIds.has(String(l.InvoiceId))) return;
    const k = String(l.FeeTypeId) === 'SALE' ? 'Bán hàng (đồng phục, sách...)' : String(l.FeeTypeId) === 'MEAL_REFUND' ? 'Hoàn tiền ăn' : (l.Description || l.FeeTypeId);
    feeMix[k] = (feeMix[k]||0) + Number(l.NetAmount||0);
  });

  const topDebtors = Object.keys(perStudent).filter(k => perStudent[k].balance > 0)
    .sort((a,b) => perStudent[b].balance - perStudent[a].balance).slice(0, 10)
    .map(k => {
      const s = sc.studentMap[k], c = sc.classMap[String(s.ClassId)] || {};
      return {studentId:k, name:s.FullName, code:String(s.StudentCode||''), className:c.ClassName||'',
        school:(sc.schoolMap[String(s.SchoolId)]||{}).SchoolName||'', balance:perStudent[k].balance,
        overdue:perStudent[k].overdue, rate: perStudent[k].net ? perStudent[k].paid / perStudent[k].net : 0};
    });

  const smap = sc.studentMap;
  const recentPayments = payments.slice().sort((a,b) => String(b.PaymentDate + b.CreatedAt).localeCompare(String(a.PaymentDate + a.CreatedAt)))
    .slice(0, 8).map(p => ({date:p.PaymentDate, name:(smap[String(p.StudentId)]||{}).FullName||p.StudentId, amount:Number(p.Amount||0), method:p.Method}));

  const yearInv = invoices.filter(i => yearOf_(i.Period) === year);
  const netYear = yearInv.reduce((s,i)=>s+Number(i.NetAmount||0),0);
  const paidYear = yearInv.reduce((s,i)=>s+Number(i.PaidAmount||0),0);
  const sumArr = a => a.reduce((s,v)=>s+v,0);
  let lowStock = 0;
  try { if (can_(user,'viewStock')) lowStock = getInventoryReport({schoolId: filter.schoolId}).totals.lowStock; } catch (e) {}

  const active = sc.students.filter(isActiveStudent_);
  return {
    year, filter,
    kpi: {
      schools: sc.schools.length, classes: Object.keys(sc.classMap).length, students: active.length,
      revenueYear: roundMoney_(sumArr(revenue)), expenseYear: roundMoney_(sumArr(expense)),
      profitYear: roundMoney_(sumArr(revenue) - sumArr(expense)),
      billedYear: roundMoney_(netYear), collectedOnBilled: roundMoney_(paidYear),
      collectionRate: netYear ? paidYear / netYear : 0,
      balance: roundMoney_(Object.values(perStudent).reduce((s,a)=>s+a.balance,0)),
      overdue: roundMoney_(Object.values(perStudent).reduce((s,a)=>s+a.overdue,0)),
      debtors: Object.values(perStudent).filter(a => a.balance > 0).length,
      lowStock, expenseScopeNote: sc.narrowed ? 'Chi phí được tính theo cấp trường (không phân bổ theo lớp/cấp học).' : ''
    },
    monthly: {revenue, expense, billed},
    bySchool: bySchool.sort((a,b) => b.balance - a.balance),
    byLevel, byClass: byClass.slice(0, 200),
    feeMix: Object.keys(feeMix).map(k => ({label:k, value:feeMix[k]})).sort((a,b) => b.value - a.value),
    topDebtors, recentPayments
  };
}

/** Danh sách học sinh kèm công nợ. filter: {schoolId, level, classId, q, debtOnly, status} */
function getStudentList(filter) {
  const user = requireCap_('viewStudents');
  filter = filter || {};
  const sc = scope_(user, filter);
  const per = {};
  readTable_('Invoices').forEach(i => {
    if (!invoiceLive_(i) || !sc.studentMap[String(i.StudentId)]) return;
    const a = per[i.StudentId] || (per[i.StudentId] = {net:0, paid:0, balance:0});
    a.net += Number(i.NetAmount||0); a.paid += Number(i.PaidAmount||0); a.balance += Number(i.Balance||0);
  });
  const q = foldText_(filter.q || '');
  let rows = sc.students.map(s => {
    const c = sc.classMap[String(s.ClassId)] || {}, a = per[s.StudentId] || {net:0, paid:0, balance:0};
    return {studentId:String(s.StudentId), code:String(s.StudentCode||''), name:s.FullName, classId:String(s.ClassId||''),
      className:c.ClassName||'', grade:String(c.Grade||''), level:c.Level || normalizeLevel_((sc.schoolMap[String(s.SchoolId)]||{}).Level),
      schoolId:String(s.SchoolId), school:(sc.schoolMap[String(s.SchoolId)]||{}).SchoolName||'', status:String(s.Status||'ACTIVE'),
      parentName:s.ParentName||'', parentPhone:String(s.ParentPhone||''), parentEmail:s.ParentEmail||'',
      year:String(s.EnrollmentDate||'').slice(0,4), net:a.net, paid:a.paid, balance:a.balance};
  });
  if (q) rows = rows.filter(r => foldText_([r.name, r.code, r.parentName, r.parentPhone, r.className].join(' ')).indexOf(q) > -1);
  if (filter.debtOnly) rows = rows.filter(r => r.balance > 0);
  if (filter.policyId) {
    const mem = new Set(readTable_('PolicyMembers').filter(m => String(m.DiscountId) === String(filter.policyId) && truthy_(m.Active)).map(m => String(m.StudentId)));
    rows = rows.filter(r => mem.has(r.studentId));
  }
  if (filter.status) rows = rows.filter(r => r.status.toUpperCase() === String(filter.status).toUpperCase());
  rows.sort((a,b) => (a.school + a.className + a.name).localeCompare(b.school + b.className + b.name, 'vi'));
  const offset = Math.max(0, Number(filter.offset) || 0), limit = Math.min(1500, Number(filter.limit) || 1500);
  return {total: rows.length, offset, rows: rows.slice(offset, offset + limit)};
}

/** Hồ sơ chi tiết một học sinh: thông tin, hóa đơn + dòng phí, thanh toán, mua hàng, thông báo đã gửi. */
function getStudentDetail(studentId) {
  const user = requireCap_('viewStudents');
  const s = readTable_('Students').find(x => String(x.StudentId) === String(studentId));
  if (!s) throw new Error('Không tìm thấy học sinh.');
  assertStudentAccess_(user, s);
  const school = readTable_('Schools').find(x => String(x.SchoolId) === String(s.SchoolId)) || {};
  const cls = readTable_('Classes').find(x => String(x.ClassId) === String(s.ClassId)) || {};
  const invoices = readTable_('Invoices').filter(i => String(i.StudentId) === String(s.StudentId) && invoiceLive_(i))
    .sort((a,b) => String(b.Period).localeCompare(String(a.Period)));
  const invIds = new Set(invoices.map(i => String(i.InvoiceId)));
  const linesBy = {};
  readTable_('InvoiceLines').forEach(l => { if (invIds.has(String(l.InvoiceId))) (linesBy[l.InvoiceId] = linesBy[l.InvoiceId] || []).push(l); });
  const payments = readTable_('Payments').filter(p => String(p.StudentId) === String(s.StudentId) && p.Status === 'RECORDED')
    .sort((a,b) => String(b.PaymentDate).localeCompare(String(a.PaymentDate)));
  const notifications = readTable_('Notifications').filter(n => String(n.StudentId) === String(s.StudentId))
    .sort((a,b) => String(b.SentAt).localeCompare(String(a.SentAt))).slice(0, 50);
  const sum = (arr,k) => roundMoney_(arr.reduce((t,x)=>t+Number(x[k]||0),0));
  const paidTotal = sum(payments,'Amount');
  const byPeriod = {};
  invoices.forEach(i => {
    const p = String(i.Period).slice(0,7), a = byPeriod[p] || (byPeriod[p] = {period:p, net:0, paid:0});
    a.net += Number(i.NetAmount||0); a.paid += Number(i.PaidAmount||0);
  });
  const mapInvoice = i => ({invoiceId:i.InvoiceId, type:String(i.InvoiceType||'TUITION').toUpperCase(), period:String(i.Period).slice(0,7),
    issueDate:String(i.IssueDate).slice(0,10), dueDate:String(i.DueDate||'').slice(0,10), gross:Number(i.GrossAmount||0),
    discount:Number(i.DiscountAmount||0), net:Number(i.NetAmount||0), paid:Number(i.PaidAmount||0), balance:Number(i.Balance||0), status:i.Status,
    lines:(linesBy[i.InvoiceId]||[]).map(l => ({description:l.Description, quantity:Number(l.Quantity||0), unitPrice:Number(l.UnitPrice||0),
      gross:Number(l.GrossAmount||0), discount:Number(l.DiscountAmount||0), net:Number(l.NetAmount||0), discountNote:l.DiscountNote||''}))});
  const balance = sum(invoices,'Balance');
  return {
    student: {studentId:s.StudentId, code:String(s.StudentCode||''), name:s.FullName, dob:s.DOB, gender:s.Gender||'', address:s.Address||'',
      enrollmentDate:s.EnrollmentDate, leaveDate:s.LeaveDate||'', status:s.Status||'ACTIVE', parentName:s.ParentName, parentPhone:String(s.ParentPhone||''),
      parentEmail:s.ParentEmail||'', notes:s.Notes||'', classId:String(s.ClassId||''), className:cls.ClassName||'', grade:String(cls.Grade||''),
      homeroom:cls.HomeroomTeacher||'', schoolId:String(s.SchoolId), school:school.SchoolName||'', level:LEVELS[levelOfClass_(cls, school)]||''},
    totals: {net:sum(invoices,'NetAmount'), discount:sum(invoices,'DiscountAmount'), paid:paidTotal, balance,
      credit: roundMoney_(Math.max(0, paidTotal - sum(invoices,'PaidAmount')))},
    series: Object.values(byPeriod).sort((a,b) => a.period.localeCompare(b.period)),
    invoices: invoices.filter(i => String(i.InvoiceType||'TUITION').toUpperCase() !== 'SALE').map(mapInvoice),
    sales: invoices.filter(i => String(i.InvoiceType||'').toUpperCase() === 'SALE').map(mapInvoice),
    payments: payments.map(p => ({paymentId:p.PaymentId, date:p.PaymentDate, amount:Number(p.Amount||0), method:p.Method, reference:String(p.Reference||''), notes:p.Notes})),
    notifications: notifications.map(n => ({date:String(n.SentAt), channel:n.Channel, recipient:String(n.Recipient), status:n.Status, error:n.Error, subject:n.Subject})),
    policies: (() => {
      const dmap = Object.fromEntries(readTable_('Discounts').map(d => [String(d.DiscountId), d]));
      return readTable_('PolicyMembers').filter(m => String(m.StudentId) === String(s.StudentId) && truthy_(m.Active) && dmap[String(m.DiscountId)])
        .map(m => { const d = dmap[String(m.DiscountId)];
          return {name:d.Name, type:(POLICY_TYPES[String(d.PolicyType).toUpperCase()] || {}).label || '', note:m.Note || '',
            value: String(d.Method).toUpperCase() === 'PERCENT' ? Number(d.Value) + '%' : fmtMoney_(d.Value) + 'đ',
            status: !truthy_(d.Active) ? 'INACTIVE_POL' : policyApproved_(d) ? 'ACTIVE_POL' : 'PENDING',
            validFrom:String(m.ValidFrom || d.ValidFrom || '').slice(0,10), validTo:String(m.ValidTo || d.ValidTo || '').slice(0,10)}; });
    })(),
    account: can_(user, 'manageParentAccounts') ? parentAccountInfo_(s.StudentId) : null,
    payInfo: balance > 0 ? paymentInfoForStudent_(s, school, balance, null) : null
  };
}

/**
 * Báo cáo tổng hợp & chi tiết. params: {type, schoolId, level, classId, from, to, year}
 * type: SCHOOL_SUMMARY | CLASS_SUMMARY | STUDENT_DEBT | INVOICE_DETAIL | PAYMENTS | EXPENSES | INVENTORY | SALES | FEE_MIX
 * Trả về {title, columns:[{key,label,type}], rows, totals}
 */
function getReport(params) {
  const user = requireCap_('viewReports');
  params = params || {};
  const type = String(params.type || 'SCHOOL_SUMMARY');
  const from = String(params.from || ''), to = String(params.to || '');
  const inRange = d => { d = String(d||'').slice(0,10); return (!from || d >= from) && (!to || d <= to); };
  const M = 'money', N = 'number', P = 'percent';
  const out = (title, columns, rows, totalKeys) => {
    const totals = {};
    (totalKeys || columns.filter(c => c.type === M || c.type === N).map(c => c.key)).forEach(k => totals[k] = roundMoney_(rows.reduce((s,r)=>s+Number(r[k]||0),0)));
    return {title, generatedAt: Utilities.formatDate(new Date(), APP.TZ, 'dd/MM/yyyy HH:mm'), by:user.name, params, columns, rows, totals};
  };

  if (type === 'INVENTORY') {
    const r = getInventoryReport({schoolId:params.schoolId, from, to});
    return out('Báo cáo nhập - xuất - tồn kho', [
      {key:'warehouse',label:'Kho'},{key:'sku',label:'Mã SKU'},{key:'product',label:'Mặt hàng'},{key:'category',label:'Nhóm'},
      {key:'size',label:'Cỡ'},{key:'unit',label:'ĐVT'},{key:'opening',label:'Tồn đầu',type:N},{key:'inQty',label:'Nhập',type:N},
      {key:'outQty',label:'Xuất',type:N},{key:'closing',label:'Tồn cuối',type:N},{key:'avgCost',label:'Giá vốn BQ',type:M},
      {key:'stockValue',label:'Giá trị tồn',type:M}], r.rows, ['opening','inQty','outQty','closing','stockValue']);
  }
  if (type === 'EXPENSES') {
    if (!can_(user,'viewExpense')) throw new Error('Bạn không có quyền xem chi phí.');
    const rows = getExpenses({schoolId:params.schoolId, level:params.level, classId:params.classId, from, to}).rows;
    return out('Báo cáo chi phí', [{key:'date',label:'Ngày'},{key:'school',label:'Trường'},{key:'level',label:'Cấp học'},{key:'grade',label:'Khối'},{key:'className',label:'Lớp'},{key:'category',label:'Hạng mục'},
      {key:'vendor',label:'Nhà cung cấp'},{key:'description',label:'Diễn giải'},{key:'amount',label:'Số tiền',type:M},{key:'status',label:'Trạng thái'}],
      rows.filter(r => expenseCounts_({Status:r.status})).concat(rows.filter(r => !expenseCounts_({Status:r.status}))), ['amount']);
  }

  const sc = scope_(user, params);
  const inScope = id => !!sc.studentMap[String(id)];
  const schoolName = id => (sc.schoolMap[String(id)]||{}).SchoolName || id;
  const className = s => ((sc.classMap[String(s.ClassId)]||{}).ClassName) || '';
  const invoices = readTable_('Invoices').filter(i => invoiceLive_(i) && inScope(i.StudentId));
  const periodIn = i => { const p = String(i.Period).slice(0,7); return (!from || p >= from.slice(0,7)) && (!to || p <= to.slice(0,7)); };

  if (type === 'SCHOOL_SUMMARY' || type === 'CLASS_SUMMARY' || type === 'LEVEL_SUMMARY') {
    const keyFn = type === 'SCHOOL_SUMMARY' ? s => String(s.SchoolId)
      : type === 'LEVEL_SUMMARY' ? s => (sc.classMap[String(s.ClassId)]||{}).Level || normalizeLevel_((sc.schoolMap[String(s.SchoolId)]||{}).Level) || 'KHAC'
      : s => String(s.SchoolId) + '|' + String(s.ClassId);
    const g = {};
    sc.students.forEach(s => {
      const k = keyFn(s);
      g[k] = g[k] || {school:schoolName(s.SchoolId), className:className(s) || '(Chưa xếp lớp)', level:LEVELS[k] || LEVELS[(sc.classMap[String(s.ClassId)]||{}).Level] || '',
        students:0, gross:0, discount:0, net:0, paid:0, balance:0, debtors:0, revenue:0, expense:0, _debt:{}};
      if (isActiveStudent_(s)) g[k].students++;
    });
    const keyOfStudent = {};
    sc.students.forEach(s => keyOfStudent[String(s.StudentId)] = keyFn(s));
    invoices.filter(periodIn).forEach(i => {
      const r = g[keyOfStudent[String(i.StudentId)]]; if (!r) return;
      r.gross += Number(i.GrossAmount||0); r.discount += Number(i.DiscountAmount||0); r.net += Number(i.NetAmount||0);
      r.paid += Number(i.PaidAmount||0); r.balance += Number(i.Balance||0);
      if (Number(i.Balance||0) > 0) r._debt[i.StudentId] = 1;
    });
    readTable_('Payments').forEach(p => {
      if (p.Status !== 'RECORDED' || !inScope(p.StudentId) || !inRange(p.PaymentDate)) return;
      const r = g[keyOfStudent[String(p.StudentId)]]; if (r) r.revenue += Number(p.Amount||0);
    });
    if (type === 'SCHOOL_SUMMARY') readTable_('Expenses').forEach(e => {
      if (!expenseCounts_(e) || !inRange(e.ExpenseDate) || !g[String(e.SchoolId)]) return;
      g[String(e.SchoolId)].expense += Number(e.Amount||0);
    });
    const rows = Object.values(g).map(r => { r.debtors = Object.keys(r._debt).length; delete r._debt; r.rate = r.net ? r.paid / r.net : 0; r.profit = r.revenue - r.expense; return r; });
    const base = [{key:'students',label:'Sĩ số',type:N},{key:'gross',label:'Phải thu gốc',type:M},{key:'discount',label:'Miễn giảm',type:M},
      {key:'net',label:'Phải thu',type:M},{key:'paid',label:'Đã thu',type:M},{key:'balance',label:'Còn nợ',type:M},
      {key:'debtors',label:'HS còn nợ',type:N},{key:'rate',label:'Tỷ lệ thu',type:P},{key:'revenue',label:'Tiền thu trong kỳ',type:M}];
    if (type === 'SCHOOL_SUMMARY') return out('Báo cáo tổng hợp theo trường', [{key:'school',label:'Trường'}].concat(base,
      [{key:'expense',label:'Chi phí',type:M},{key:'profit',label:'Chênh lệch thu - chi',type:M}]), rows.sort((a,b)=>a.school.localeCompare(b.school,'vi')));
    if (type === 'LEVEL_SUMMARY') return out('Báo cáo tổng hợp theo cấp học', [{key:'level',label:'Cấp học'}].concat(base), rows);
    return out('Báo cáo tổng hợp theo lớp', [{key:'school',label:'Trường'},{key:'className',label:'Lớp'}].concat(base),
      rows.sort((a,b)=>(a.school+a.className).localeCompare(b.school+b.className,'vi')));
  }

  if (type === 'STUDENT_DEBT') {
    const per = {};
    invoices.filter(periodIn).forEach(i => {
      const a = per[i.StudentId] || (per[i.StudentId] = {net:0, paid:0, balance:0, periods:[]});
      a.net += Number(i.NetAmount||0); a.paid += Number(i.PaidAmount||0); a.balance += Number(i.Balance||0);
      if (Number(i.Balance||0) > 0) a.periods.push(String(i.Period).slice(0,7));
    });
    let rows = sc.students.map(s => {
      const a = per[s.StudentId] || {net:0, paid:0, balance:0, periods:[]};
      return {school:schoolName(s.SchoolId), className:className(s), code:String(s.StudentCode||''), name:s.FullName,
        parent:s.ParentName||'', phone:String(s.ParentPhone||''), net:a.net, paid:a.paid, balance:a.balance,
        periods:Array.from(new Set(a.periods)).sort().join(', ')};
    });
    if (params.debtOnly !== false) rows = rows.filter(r => r.balance > 0);
    return out('Báo cáo công nợ chi tiết theo học sinh', [{key:'school',label:'Trường'},{key:'className',label:'Lớp'},{key:'code',label:'Mã HS'},
      {key:'name',label:'Họ tên'},{key:'parent',label:'Phụ huynh'},{key:'phone',label:'Điện thoại'},{key:'net',label:'Phải thu',type:M},
      {key:'paid',label:'Đã thu',type:M},{key:'balance',label:'Còn nợ',type:M},{key:'periods',label:'Kỳ còn nợ'}],
      rows.sort((a,b)=>(a.school+a.className+a.name).localeCompare(b.school+b.className+b.name,'vi')));
  }

  if (type === 'INVOICE_DETAIL' || type === 'SALES' || type === 'FEE_MIX') {
    const invMap = Object.fromEntries(invoices.filter(periodIn).map(i => [String(i.InvoiceId), i]));
    const lines = readTable_('InvoiceLines').filter(l => invMap[String(l.InvoiceId)] &&
      (type !== 'SALES' || String(invMap[String(l.InvoiceId)].InvoiceType).toUpperCase() === 'SALE'));
    if (type === 'FEE_MIX' || type === 'SALES') {
      const g = {};
      lines.forEach(l => {
        const k = type === 'SALES' ? String(l.ProductId || l.Description) : String(l.FeeTypeId) === 'SALE' ? 'SALE' : String(l.FeeTypeId);
        g[k] = g[k] || {item: type === 'FEE_MIX' && k === 'SALE' ? 'Bán hàng (đồng phục, sách...)' : k === 'MEAL_REFUND' ? 'Hoàn tiền ăn (nghỉ có báo)' : l.Description, quantity:0, gross:0, discount:0, net:0, students:{}};
        g[k].quantity += Number(l.Quantity||0); g[k].gross += Number(l.GrossAmount||0); g[k].discount += Number(l.DiscountAmount||0);
        g[k].net += Number(l.NetAmount||0); g[k].students[l.StudentId] = 1;
      });
      const rows = Object.values(g).map(r => { r.studentCount = Object.keys(r.students).length; delete r.students; return r; }).sort((a,b)=>b.net-a.net);
      return out(type === 'SALES' ? 'Báo cáo bán hàng theo mặt hàng' : 'Báo cáo cơ cấu khoản thu theo loại phí',
        [{key:'item',label:type === 'SALES' ? 'Mặt hàng' : 'Khoản phí'},{key:'studentCount',label:'Số HS',type:N},{key:'quantity',label:'Số lượng',type:N},
         {key:'gross',label:'Thành tiền gốc',type:M},{key:'discount',label:'Miễn giảm',type:M},{key:'net',label:'Phải thu',type:M}], rows,
        ['quantity','gross','discount','net']);
    }
    const rows = lines.map(l => {
      const i = invMap[String(l.InvoiceId)], s = sc.studentMap[String(l.StudentId)] || {};
      return {school:schoolName(i.SchoolId), className:className(s), code:String(s.StudentCode||''), name:s.FullName||l.StudentId,
        period:String(i.Period).slice(0,7), invoiceId:i.InvoiceId, item:l.Description, quantity:Number(l.Quantity||0),
        unitPrice:Number(l.UnitPrice||0), discount:Number(l.DiscountAmount||0), net:Number(l.NetAmount||0), status:i.Status};
    }).sort((a,b)=>(a.school+a.className+a.name+a.period).localeCompare(b.school+b.className+b.name+b.period,'vi'));
    return out('Báo cáo chi tiết khoản thu theo học sinh', [{key:'school',label:'Trường'},{key:'className',label:'Lớp'},{key:'code',label:'Mã HS'},
      {key:'name',label:'Họ tên'},{key:'period',label:'Kỳ'},{key:'item',label:'Khoản phí'},{key:'quantity',label:'SL',type:N},
      {key:'unitPrice',label:'Đơn giá',type:M},{key:'discount',label:'Miễn giảm',type:M},{key:'net',label:'Thành tiền',type:M},{key:'status',label:'Trạng thái HĐ'}],
      rows.slice(0, 20000), ['discount','net']);
  }

  if (type === 'PAYMENTS') {
    const rows = readTable_('Payments').filter(p => p.Status === 'RECORDED' && inScope(p.StudentId) && inRange(p.PaymentDate)).map(p => {
      const s = sc.studentMap[String(p.StudentId)];
      return {date:p.PaymentDate, school:schoolName(p.SchoolId), className:className(s), code:String(s.StudentCode||''), name:s.FullName,
        amount:Number(p.Amount||0), method:METHOD_LABELS_[p.Method] || p.Method, reference:String(p.Reference||''), by:p.CreatedBy};
    }).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    return out('Báo cáo thu tiền', [{key:'date',label:'Ngày thu'},{key:'school',label:'Trường'},{key:'className',label:'Lớp'},{key:'code',label:'Mã HS'},
      {key:'name',label:'Họ tên'},{key:'amount',label:'Số tiền',type:M},{key:'method',label:'Hình thức'},{key:'reference',label:'Tham chiếu'},{key:'by',label:'Người thu'}],
      rows, ['amount']);
  }
  throw new Error('Loại báo cáo không hỗ trợ: ' + type);
}

const METHOD_LABELS_ = {BANK_TRANSFER:'Chuyển khoản', CASH:'Tiền mặt', CARD:'Thẻ', QR:'QR', OTHER:'Khác'};

/** Xuất báo cáo ra một Google Sheet mới trong Drive của người dùng. */
function exportReportToSheet(params) {
  const r = getReport(params);
  const ss = SpreadsheetApp.create(r.title + ' - ' + r.generatedAt);
  const sh = ss.getSheets()[0];
  const header = r.columns.map(c => c.label);
  const data = r.rows.map(row => r.columns.map(c => row[c.key] === undefined ? '' : row[c.key]));
  const totalRow = r.columns.map((c,i) => i === 0 ? 'TỔNG CỘNG' : (r.totals[c.key] !== undefined ? r.totals[c.key] : ''));
  sh.getRange(1,1).setValue(r.title).setFontSize(14).setFontWeight('bold');
  sh.getRange(2,1).setValue('Lập lúc ' + r.generatedAt + ' bởi ' + r.by);
  sh.getRange(4,1,1,header.length).setValues([header]).setBackground('#435467').setFontColor('#FFFFFF').setFontWeight('bold');
  if (data.length) sh.getRange(5,1,data.length,header.length).setValues(data);
  sh.getRange(5 + data.length,1,1,header.length).setValues([totalRow]).setFontWeight('bold').setBackground('#FFF4DC');
  r.columns.forEach((c,i) => {
    const rg = sh.getRange(5, i+1, data.length + 1, 1);
    if (c.type === 'money') rg.setNumberFormat('#,##0');
    if (c.type === 'percent') rg.setNumberFormat('0.0%');
  });
  sh.setFrozenRows(4);
  sh.autoResizeColumns(1, header.length);
  // Lưu vào thư mục hồ sơ (Config.gs → DRIVE.DOCUMENTS_FOLDER_ID / "Báo cáo"); nếu lỗi vẫn giữ ở thư mục gốc Drive.
  try { DriveApp.getFileById(ss.getId()).moveTo(driveFolder_('DOCUMENTS_FOLDER_ID', 'Báo cáo')); } catch (e) { Logger.log('moveTo: ' + e); }
  // Web app chạy bằng tài khoản chủ sở hữu → chia sẻ file cho cán bộ đã xuất báo cáo (nếu là tài khoản Google).
  const u = currentUser_();
  if (u.email && u.email.indexOf('@') > 0 && !isScriptOwner_()) { try { ss.addEditor(u.email); } catch (e) {} }
  return {url: ss.getUrl(), name: ss.getName()};
}

/** Bỏ dấu tiếng Việt, viết thường — dùng cho tìm kiếm và nội dung chuyển khoản. */
function foldText_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g,'d').replace(/Đ/g,'D').toLowerCase().trim();
}
