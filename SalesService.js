/**
 * Bán đồng phục / sách vở / phụ kiện cho học sinh.
 * payload: {SchoolId, StudentId, WarehouseId, items:[{ProductId, Quantity, UnitPrice}], payNow, Method, Reference, Notes}
 * Tạo trong một khóa ghi: hóa đơn bán hàng (InvoiceType = SALE) + dòng chi tiết + phiếu xuất kho (OUT, tham chiếu số hóa đơn).
 * Nếu payNow: ghi luôn giao dịch thu bằng số tiền hóa đơn và phân bổ FIFO như thu học phí.
 */
function createSale(payload) {
  const user = requireCap_('sell');
  const schoolId = String(payload.SchoolId || '');
  const warehouseId = String(payload.WarehouseId || '');
  assertSchoolAccess_(user, schoolId);
  const items = (payload.items || []).map(i => ({productId:String(i.ProductId||''), qty:Number(i.Quantity), price:Number(i.UnitPrice), warehouseId:String(i.WarehouseId || '')}))
    .filter(i => i.productId && i.qty > 0);
  if (!items.length) throw new Error('Chưa có mặt hàng nào.');
  if (items.some(i => !(i.price >= 0))) throw new Error('Đơn giá không hợp lệ.');
  return withWriteLock_(() => {
    const student = readTable_('Students').find(s => String(s.StudentId) === String(payload.StudentId) || String(s.StudentCode) === String(payload.StudentId));
    if (!student || String(student.SchoolId) !== schoolId) throw new Error('Không tìm thấy học sinh trong trường đã chọn.');
    const pmap = Object.fromEntries(readTable_('Products').filter(p => truthy_(p.Active)).map(p => [String(p.ProductId), p]));
    items.forEach(i => { if (!pmap[i.productId]) throw new Error('Mặt hàng không tồn tại hoặc đã ngừng: ' + i.productId); });
    // Kho được phép xuất: kho của trường hoặc kho không gắn trường, đang hoạt động.
    const whs = readTable_('Warehouses').filter(w => truthy_(w.Active) && (!w.SchoolId || String(w.SchoolId) === schoolId));
    const whName = Object.fromEntries(whs.map(w => [String(w.WarehouseId), w.WarehouseName]));
    const avail = {}; // "kho|mặt hàng" → tồn còn lại (trừ dần khi phân bổ)
    const left = (w, pid) => { const k = w + '|' + pid; if (avail[k] === undefined) avail[k] = stockOnHand_(w, pid); return avail[k]; };
    const elsewhere = pid => whs.map(w => [w.WarehouseName, left(String(w.WarehouseId), pid)]).filter(x => x[1] > 0)
      .map(x => x[0] + ' (' + x[1] + ')').join(', ') || 'không kho nào còn hàng';
    // Mỗi dòng có thể chọn kho riêng (item.WarehouseId); "AUTO" = tự lấy từ các kho còn hàng, nhiều nhất trước, tách dòng nếu cần.
    const picks = [];
    items.forEach(i => {
      const want = String(i.warehouseId || warehouseId || 'AUTO');
      if (want !== 'AUTO') {
        if (!whName[want]) throw new Error('Kho xuất của "' + pmap[i.productId].ProductName + '" không hợp lệ hoặc không thuộc trường.');
        const have = left(want, i.productId);
        if (i.qty > have) throw new Error('Không đủ tồn "' + pmap[i.productId].ProductName + '" ở kho ' + whName[want] + ': còn ' + have + ', cần ' + i.qty +
          '. Còn hàng ở: ' + elsewhere(i.productId) + '. Chọn kho khác hoặc "Tự động".');
        avail[want + '|' + i.productId] -= i.qty;
        picks.push({productId:i.productId, qty:i.qty, price:i.price, wh:want});
        return;
      }
      let rest = i.qty;
      const order = whs.map(w => String(w.WarehouseId)).sort((a, b) => left(b, i.productId) - left(a, i.productId));
      const total = order.reduce((t, w) => t + Math.max(0, left(w, i.productId)), 0);
      if (total < rest) throw new Error('Không đủ tồn "' + pmap[i.productId].ProductName + '": tổng các kho còn ' + total + ', cần ' + i.qty + '.');
      order.forEach(w => {
        const take = Math.min(rest, Math.max(0, left(w, i.productId)));
        if (take <= 0) return;
        avail[w + '|' + i.productId] -= take; rest -= take;
        picks.push({productId:i.productId, qty:take, price:i.price, wh:w});
      });
    });
    const now = new Date();
    const today = Utilities.formatDate(now, APP.TZ, 'yyyy-MM-dd');
    const invoiceId = nextId_('INV');
    const lines = picks.map(i => {
      const p = pmap[i.productId];
      const gross = roundMoney_(i.qty * i.price);
      return {LineId:nextId_('LIN'), InvoiceId:invoiceId, StudentId:String(student.StudentId), FeeTypeId:'SALE',
        Description:p.ProductName + (p.Size ? ' (' + p.Size + ')' : ''), Quantity:i.qty, UnitPrice:i.price,
        GrossAmount:gross, DiscountAmount:0, NetAmount:gross, ProductId:i.productId, WarehouseId:i.wh};
    });
    const net = roundMoney_(lines.reduce((s,l) => s + l.NetAmount, 0));
    appendObject_('Invoices', {InvoiceId:invoiceId, SchoolId:schoolId, StudentId:String(student.StudentId),
      Period:asText_(today.slice(0,7)), IssueDate:now, DueDate:today, GrossAmount:net, DiscountAmount:0, NetAmount:net,
      PaidAmount:0, Balance:net, Status:net > 0 ? 'UNPAID' : 'PAID', CreatedAt:now, CreatedBy:user.email,
      InvoiceType:'SALE', Notes:String(payload.Notes||'')});
    appendObjects_('InvoiceLines', lines);
    appendObjects_('StockMovements', picks.map(i => ({MovementId:nextId_('MOV'), WarehouseId:i.wh, ProductId:i.productId,
      MovementDate:today, MovementType:'OUT', Quantity:i.qty, UnitCost:0, Reference:invoiceId,
      Notes:'Bán cho ' + student.FullName, Status:'POSTED', CreatedAt:now, CreatedBy:user.email, TransferId:''})));
    let paymentId = '', allocated = 0;
    if (payload.payNow && net > 0) {
      paymentId = nextId_('PAY');
      appendObject_('Payments', {PaymentId:paymentId, SchoolId:schoolId, StudentId:String(student.StudentId), PaymentDate:today,
        Amount:net, Method:String(payload.Method||'CASH'), Reference:asText_(String(payload.Reference||'').trim()),
        Notes:'Thu tiền bán hàng ' + invoiceId, Status:'RECORDED', CreatedAt:now, CreatedBy:user.email});
      allocated = allocateForStudents_(schoolId, [String(student.StudentId)], user).amount;
    }
    audit_('CREATE_SALE','Invoices',invoiceId,{schoolId, studentId:student.StudentId, total:net, items:items.length, paymentId});
    return {ok:true, invoiceId, total:net, paymentId, allocated,
      shipped: picks.map(i => ({product:pmap[i.productId].ProductName, qty:i.qty, warehouse:whName[i.wh]}))};
  });
}

/** Danh sách đơn bán hàng gần đây trong phạm vi được xem. */
function getRecentSales(params) {
  const user = requireCap_('sell');
  const allowed = new Set(listSchoolsForUser_(user).map(s => String(s.SchoolId)));
  const smap = Object.fromEntries(readTable_('Students').map(s => [String(s.StudentId), s]));
  return readTable_('Invoices').filter(i => String(i.InvoiceType).toUpperCase() === 'SALE' && allowed.has(String(i.SchoolId)) &&
      (!params || !params.schoolId || String(i.SchoolId) === String(params.schoolId)))
    .sort((a,b) => String(b.CreatedAt).localeCompare(String(a.CreatedAt))).slice(0, 100)
    .map(i => ({invoiceId:i.InvoiceId, date:String(i.IssueDate).slice(0,10), student:(smap[String(i.StudentId)]||{}).FullName || i.StudentId,
      total:Number(i.NetAmount||0), balance:Number(i.Balance||0), status:i.Status}));
}

// ===================== CHI PHÍ =====================

const EXPENSE_CATEGORIES = ['Lương & phụ cấp','Bảo hiểm','Điện nước','Thuê mặt bằng','Ăn bán trú','Nhập hàng (đồng phục/sách)',
  'Cơ sở vật chất','Văn phòng phẩm','Marketing','Hoạt động ngoại khoá','Thuế & phí','Khác'];

function recordExpense(payload) {
  const user = requireCap_('recordExpense');
  const schoolId = String(payload.SchoolId || '');
  assertSchoolAccess_(user, schoolId);
  const amount = Number(payload.Amount);
  if (!schoolId || !(amount > 0) || !payload.ExpenseDate) throw new Error('Trường, ngày chi và số tiền hợp lệ là bắt buộc.');
  const tag = expenseTag_(schoolId, payload);
  return withWriteLock_(() => {
    const id = nextId_('EXP');
    const autoApprove = can_(user, 'approveExpense');
    appendObject_('Expenses', {ExpenseId:id, SchoolId:schoolId, ExpenseDate:String(payload.ExpenseDate),
      Category:String(payload.Category||'Khác'), Vendor:String(payload.Vendor||''), Description:String(payload.Description||''),
      Amount:roundMoney_(amount), BudgetPeriod:asText_(String(payload.ExpenseDate).slice(0,7)),
      Status:autoApprove ? 'APPROVED' : 'PENDING', ApprovedBy:autoApprove ? user.email : '', CreatedAt:new Date(), CreatedBy:user.email,
      Level:tag.Level, Grade:asText_(tag.Grade), ClassId:tag.ClassId});
    audit_('CREATE','Expenses',id,{schoolId, amount});
    return {ok:true, id, status:autoApprove ? 'APPROVED' : 'PENDING'};
  });
}

/** Cấp học / khối / lớp gắn với khoản chi (tùy chọn). Có lớp thì khối, cấp lấy theo lớp. */
function expenseTag_(schoolId, payload) {
  const classId = String(payload.ClassId || '').trim();
  let level = payload.Level ? normalizeLevel_(payload.Level) : '';
  let grade = String(payload.Grade || '').trim();
  if (payload.Level && !level) throw new Error('Cấp học không hợp lệ.');
  if (classId) {
    const cls = readTable_('Classes').find(c => String(c.ClassId) === classId);
    if (!cls || String(cls.SchoolId) !== String(schoolId)) throw new Error('Lớp không thuộc trường đã chọn.');
    const school = readTable_('Schools').find(s => String(s.SchoolId) === String(schoolId));
    grade = gradeOfClass_(cls) || grade;
    level = levelOfClass_(cls, school) || level;
  }
  return {Level:level, Grade:grade, ClassId:classId};
}

function setExpenseStatus(payload) {
  const user = requireCap_('approveExpense');
  const id = String(payload.ExpenseId || '');
  const status = String(payload.Status || '').toUpperCase();
  if (!['APPROVED','REJECTED','VOID'].includes(status)) throw new Error('Trạng thái không hợp lệ.');
  return withWriteLock_(() => {
    const e = readTable_('Expenses').find(x => String(x.ExpenseId) === id);
    if (!e) throw new Error('Không tìm thấy khoản chi.');
    assertSchoolAccess_(user, e.SchoolId);
    updateObjectById_('Expenses','ExpenseId',id,{Status:status, ApprovedBy:user.email});
    audit_('SET_STATUS','Expenses',id,{status});
    return {ok:true};
  });
}

function getExpenses(params) {
  const user = requireCap_('viewExpense');
  params = params || {};
  const schools = listSchoolsForUser_(user);
  const smap = Object.fromEntries(schools.map(s => [String(s.SchoolId), s.SchoolName]));
  const cmap = Object.fromEntries(readTable_('Classes').map(c => [String(c.ClassId), c.ClassName]));
  const rows = readTable_('Expenses').filter(e => smap[String(e.SchoolId)] !== undefined &&
      (!params.schoolId || String(e.SchoolId) === String(params.schoolId)) &&
      (!params.level || String(e.Level) === String(params.level)) && (!params.grade || String(e.Grade).trim() === String(params.grade).trim()) &&
      (!params.classId || String(e.ClassId) === String(params.classId)) &&
      (!params.from || String(e.ExpenseDate) >= params.from) && (!params.to || String(e.ExpenseDate) <= params.to))
    .sort((a,b) => String(b.ExpenseDate).localeCompare(String(a.ExpenseDate)))
    .map(e => ({id:e.ExpenseId, schoolId:e.SchoolId, school:smap[String(e.SchoolId)], date:e.ExpenseDate, category:e.Category,
      vendor:e.Vendor, description:e.Description, amount:Number(e.Amount||0), status:e.Status, approvedBy:e.ApprovedBy, by:e.CreatedBy,
      level:LEVELS[String(e.Level)] || '', grade:String(e.Grade || ''), classId:String(e.ClassId || ''), className:cmap[String(e.ClassId)] || ''}));
  return {categories:EXPENSE_CATEGORIES, rows:rows.slice(0, 1000)};
}

/** Khoản chi được tính vào báo cáo: đã duyệt (hoặc dữ liệu cũ chưa có trạng thái). */
function expenseCounts_(e) {
  const st = String(e.Status || '').toUpperCase();
  return !['PENDING','REJECTED','VOID'].includes(st);
}
