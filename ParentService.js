/**
 * CỔNG PHỤ HUYNH: xem thông báo & học phí của con, đăng ký suất ăn đầu tháng, đăng ký mua đồ dùng.
 * Đơn mua của phụ huynh ở trạng thái PENDING → kế toán/thủ quỹ xác nhận (tạo hóa đơn bán hàng + xuất kho) hoặc từ chối.
 */

function parentStudent_(user, studentId) {
  if (user.role !== 'PARENT') throw new Error('Chức năng dành cho phụ huynh.');
  const sid = String(studentId || user.studentIds[0]);
  if (user.studentIds.indexOf(sid) < 0) throw new Error('Bạn không có quyền với học sinh này.');
  const st = readTable_('Students').find(s => String(s.StudentId) === sid);
  if (!st) throw new Error('Không tìm thấy học sinh.');
  return st;
}

/** Tồn kho có thể bán theo mặt hàng tại các kho của trường. */
function schoolStock_(schoolId) {
  const wh = new Set(readTable_('Warehouses').filter(w => truthy_(w.Active) && String(w.SchoolId) === String(schoolId)).map(w => String(w.WarehouseId)));
  const out = {};
  readTable_('StockMovements').forEach(m => {
    if (m.Status !== 'POSTED' || !wh.has(String(m.WarehouseId))) return;
    out[m.ProductId] = (out[m.ProductId] || 0) + (MOVEMENT_SIGN_[String(m.MovementType).toUpperCase()] || 0) * Number(m.Quantity || 0);
  });
  return out;
}

/** Trạng thái đăng ký ăn của học sinh cho một tháng. */
function parentMealStatus_(st, period) {
  const sid = String(st.StudentId), sch = String(st.SchoolId);
  const month = mealMonthRow_(sch, period);
  const plan = mealPlanFor_(sch, period);
  const rec = readTable_('MealRecords').find(r => String(r.StudentId) === sid && String(r.Period).slice(0,7) === period);
  const prev = readTable_('MealRecords').find(r => String(r.StudentId) === sid && String(r.Period).slice(0,7) === prevPeriod_(period));
  const registered = plan ? plan.registered(sid) : rec ? truthy_(rec.Registered) : prev ? truthy_(prev.Registered) : true;
  const invoiced = readTable_('Invoices').some(i => String(i.StudentId) === sid && String(i.Period).slice(0,7) === period && invoiceLive_(i) &&
    String(i.InvoiceType || 'TUITION').toUpperCase() === 'TUITION');
  const closed = !!(month && String(month.Status).toUpperCase() === 'CLOSED');
  return {period, registered, plannedDays: month ? Number(month.PlannedDays || 0) : null, invoiced, closed,
    reportedAbsent: rec ? Number(rec.ReportedAbsent || 0) : 0, refundAmount: rec && truthy_(rec.Settled) ? Number(rec.RefundAmount || 0) : 0,
    canChange: !invoiced && !closed && period >= Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM'),
    lockReason: invoiced ? 'Nhà trường đã phát hành học phí tháng này' : closed ? 'Tháng đã chốt tiền ăn' : ''};
}

function getParentHome(params) {
  const user = requireCap_('parentPortal');
  const st = parentStudent_(user, params && params.studentId);
  const detail = getStudentDetail(String(st.StudentId));
  const now = Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM');
  const y = Number(now.slice(0,4)), m = Number(now.slice(5,7));
  const next = m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0');
  const stock = schoolStock_(st.SchoolId);
  const products = readTable_('Products').filter(p => truthy_(p.Active) && Number(p.SalePrice) > 0)
    .map(p => ({id:p.ProductId, image:p.ImageUrl || '', name:p.ProductName, category:p.Category || 'Khác', size:p.Size || '', unit:p.Unit || '', price:Number(p.SalePrice), available:Math.max(0, stock[p.ProductId] || 0)}))
    .sort((a,b) => (a.category + a.name + a.size).localeCompare(b.category + b.name + b.size, 'vi'));
  const linesBy = {};
  readTable_('OrderLines').forEach(l => (linesBy[l.OrderId] = linesBy[l.OrderId] || []).push({name:l.Description, qty:Number(l.Quantity), price:Number(l.UnitPrice), amount:Number(l.Amount)}));
  const orders = readTable_('Orders').filter(o => String(o.StudentId) === String(st.StudentId))
    .sort((a,b) => String(b.CreatedAt).localeCompare(String(a.CreatedAt)))
    .map(o => ({id:o.OrderId, date:String(o.CreatedAt).slice(0,10), status:o.Status, total:Number(o.Total || 0), note:o.Note || '', reason:o.Reason || '',
      invoiceId:o.InvoiceId || '', lines:linesBy[o.OrderId] || []}));
  const cmap = Object.fromEntries(readTable_('Classes').map(c => [String(c.ClassId), c.ClassName]));
  const smap = Object.fromEntries(readTable_('Schools').map(x => [String(x.SchoolId), x.SchoolName]));
  const children = user.studentIds.map(id => {
    const s = readTable_('Students').find(x => String(x.StudentId) === id) || {};
    const balance = readTable_('Invoices').filter(i => String(i.StudentId) === id && invoiceLive_(i)).reduce((t, i) => t + Number(i.Balance || 0), 0);
    return {studentId:id, name:s.FullName, code:String(s.StudentCode || ''), className:cmap[String(s.ClassId)] || '', school:smap[String(s.SchoolId)] || '', balance};
  });
  return {student:detail.student, children, detail, banner:bannerFor_(st.SchoolId), meals:[parentMealStatus_(st, now), parentMealStatus_(st, next)],
    mealRules:mealRules_(st.SchoolId), products, orders, absences:studentAbsences_(st.StudentId)};
}

/** Phụ huynh đăng ký / hủy đăng ký suất ăn cho tháng hiện tại hoặc tháng sau (trước khi trường phát hành học phí tháng đó). */
function parentRegisterMeal(payload) {
  const user = requireCap_('parentPortal');
  const st = parentStudent_(user, payload.studentId);
  const period = String(payload.period || '').slice(0,7);
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('Tháng không hợp lệ.');
  return withWriteLock_(() => {
    const s = parentMealStatus_(st, period);
    if (!s.canChange) throw new Error('Không thay đổi được đăng ký ăn tháng ' + periodLabel_(period) + (s.lockReason ? ': ' + s.lockReason : '') + '. Vui lòng liên hệ nhà trường.');
    const registered = !(payload.registered === false || String(payload.registered) === 'false');
    const rec = readTable_('MealRecords').find(r => String(r.StudentId) === String(st.StudentId) && String(r.Period).slice(0,7) === period);
    const now = new Date();
    if (rec) updateObjectById_('MealRecords', 'RecordId', rec.RecordId, {Registered:registered, UpdatedAt:now, UpdatedBy:user.email});
    else appendObject_('MealRecords', {RecordId:nextId_('MEAL'), SchoolId:st.SchoolId, Period:asText_(period), StudentId:st.StudentId,
      Registered:registered, PlannedDays:'', ReportedAbsent:0, UnreportedAbsent:0, Settled:false, AdjustInvoiceId:'',
      Note:'Phụ huynh đăng ký', UpdatedAt:now, UpdatedBy:user.email});
    audit_('PARENT_MEAL','MealRecords',st.StudentId + '|' + period,{registered});
    return {ok:true, registered};
  });
}

/** Phụ huynh đăng ký mua đồ dùng. payload: {studentId, items:[{ProductId, Quantity}], note} */
function createParentOrder(payload) {
  const user = requireCap_('parentPortal');
  const st = parentStudent_(user, payload.studentId);
  const pmap = Object.fromEntries(readTable_('Products').filter(p => truthy_(p.Active) && Number(p.SalePrice) > 0).map(p => [String(p.ProductId), p]));
  const items = (payload.items || []).map(i => ({id:String(i.ProductId), qty:Math.floor(Number(i.Quantity))})).filter(i => i.qty > 0);
  if (!items.length) throw new Error('Chọn ít nhất một mặt hàng.');
  if (items.some(i => !pmap[i.id])) throw new Error('Có mặt hàng không còn bán.');
  if (items.some(i => i.qty > 50)) throw new Error('Số lượng mỗi mặt hàng tối đa 50.');
  return withWriteLock_(() => {
    const pending = readTable_('Orders').filter(o => String(o.StudentId) === String(st.StudentId) && o.Status === 'PENDING').length;
    if (pending >= 5) throw new Error('Đang có ' + pending + ' đơn chờ nhà trường xác nhận. Vui lòng chờ xử lý trước khi đặt thêm.');
    const id = nextId_('ORD'), now = new Date();
    const lines = items.map(i => { const p = pmap[i.id], price = Number(p.SalePrice);
      return {OrderLineId:nextId_('ORL'), OrderId:id, ProductId:i.id, Description:p.ProductName + (p.Size ? ' (' + p.Size + ')' : ''),
        Quantity:i.qty, UnitPrice:price, Amount:roundMoney_(i.qty * price)}; });
    const total = roundMoney_(lines.reduce((s,l) => s + l.Amount, 0));
    appendObject_('Orders', {OrderId:id, SchoolId:st.SchoolId, StudentId:st.StudentId, Status:'PENDING', Total:total,
      Note:String(payload.note || '').slice(0, 300), InvoiceId:'', CreatedAt:now, CreatedBy:user.email});
    appendObjects_('OrderLines', lines);
    audit_('PARENT_ORDER','Orders',id,{total, items:lines.length});
    return {ok:true, id, total};
  });
}

function cancelParentOrder(orderId) {
  const user = requireCap_('parentPortal');
  return withWriteLock_(() => {
    const o = readTable_('Orders').find(x => String(x.OrderId) === String(orderId));
    if (!o || user.studentIds.indexOf(String(o.StudentId)) < 0) throw new Error('Không tìm thấy đơn.');
    if (o.Status !== 'PENDING') throw new Error('Đơn đã được nhà trường xử lý, không hủy được.');
    updateObjectById_('Orders', 'OrderId', o.OrderId, {Status:'CANCELLED', ProcessedAt:new Date(), ProcessedBy:user.email});
    return {ok:true};
  });
}

// ===================== PHÍA NHÀ TRƯỜNG =====================

function listParentOrders(params) {
  const user = requireCap_('sell');
  params = params || {};
  const allowed = new Set(listSchoolsForUser_(user).map(s => String(s.SchoolId)));
  const stu = Object.fromEntries(readTable_('Students').map(s => [String(s.StudentId), s]));
  const cls = Object.fromEntries(readTable_('Classes').map(c => [String(c.ClassId), c.ClassName]));
  const linesBy = {};
  readTable_('OrderLines').forEach(l => (linesBy[l.OrderId] = linesBy[l.OrderId] || []).push({productId:l.ProductId, name:l.Description, qty:Number(l.Quantity), price:Number(l.UnitPrice), amount:Number(l.Amount)}));
  return readTable_('Orders').filter(o => allowed.has(String(o.SchoolId)) && (!params.schoolId || String(o.SchoolId) === String(params.schoolId)) &&
      (!params.status || o.Status === params.status))
    .sort((a,b) => (a.Status === 'PENDING' ? 0 : 1) - (b.Status === 'PENDING' ? 0 : 1) || String(b.CreatedAt).localeCompare(String(a.CreatedAt)))
    .slice(0, 300).map(o => { const s = stu[String(o.StudentId)] || {};
      return {id:o.OrderId, schoolId:o.SchoolId, studentId:o.StudentId, student:s.FullName || o.StudentId, code:String(s.StudentCode || ''),
        className:cls[String(s.ClassId)] || '', date:String(o.CreatedAt).slice(0,10), status:o.Status, total:Number(o.Total || 0),
        note:o.Note || '', reason:o.Reason || '', invoiceId:o.InvoiceId || '', lines:linesBy[o.OrderId] || []}; });
}

/** Xác nhận đơn: tạo hóa đơn bán hàng + xuất kho (dùng createSale), ghi nợ hoặc thu ngay. */
function confirmParentOrder(payload) {
  const user = requireCap_('sell');
  const o = readTable_('Orders').find(x => String(x.OrderId) === String(payload.orderId));
  if (!o) throw new Error('Không tìm thấy đơn.');
  assertSchoolAccess_(user, o.SchoolId);
  if (o.Status !== 'PENDING') throw new Error('Đơn không còn ở trạng thái chờ xác nhận.');
  const lines = readTable_('OrderLines').filter(l => String(l.OrderId) === String(o.OrderId));
  const per = payload.lineWarehouses || {};
  const sale = createSale({SchoolId:o.SchoolId, StudentId:o.StudentId, WarehouseId:payload.warehouseId || 'AUTO', payNow:!!payload.payNow,
    Method:payload.method || 'CASH', Notes:'Đơn phụ huynh ' + o.OrderId,
    items:lines.map(l => ({ProductId:l.ProductId, Quantity:Number(l.Quantity), UnitPrice:Number(l.UnitPrice), WarehouseId:per[l.ProductId] || 'AUTO'}))});
  withWriteLock_(() => {
    updateObjectById_('Orders', 'OrderId', o.OrderId, {Status:'CONFIRMED', InvoiceId:sale.invoiceId, ProcessedAt:new Date(), ProcessedBy:user.email});
    audit_('CONFIRM_ORDER','Orders',o.OrderId,{invoiceId:sale.invoiceId});
  });
  return {ok:true, invoiceId:sale.invoiceId, total:sale.total, shipped:sale.shipped};
}

/** Tồn kho từng kho của trường cho các mặt hàng trong đơn (để chọn kho xuất khi xác nhận). */
function getOrderStock(orderId) {
  const user = requireCap_('sell');
  const o = readTable_('Orders').find(x => String(x.OrderId) === String(orderId));
  if (!o) throw new Error('Không tìm thấy đơn.');
  assertSchoolAccess_(user, o.SchoolId);
  const whs = readTable_('Warehouses').filter(w => truthy_(w.Active) && (!w.SchoolId || String(w.SchoolId) === String(o.SchoolId)));
  return readTable_('OrderLines').filter(l => String(l.OrderId) === String(o.OrderId)).map(l => {
    const stock = whs.map(w => ({warehouseId:String(w.WarehouseId), name:w.WarehouseName, qty:stockOnHand_(String(w.WarehouseId), String(l.ProductId))}));
    return {productId:String(l.ProductId), name:l.Description, qty:Number(l.Quantity), stock, total:stock.reduce((t, x) => t + Math.max(0, x.qty), 0)};
  });
}

function rejectParentOrder(payload) {
  const user = requireCap_('sell');
  return withWriteLock_(() => {
    const o = readTable_('Orders').find(x => String(x.OrderId) === String(payload.orderId));
    if (!o) throw new Error('Không tìm thấy đơn.');
    assertSchoolAccess_(user, o.SchoolId);
    if (o.Status !== 'PENDING') throw new Error('Đơn không còn ở trạng thái chờ xác nhận.');
    updateObjectById_('Orders', 'OrderId', o.OrderId, {Status:'REJECTED', Reason:String(payload.reason || ''), ProcessedAt:new Date(), ProcessedBy:user.email});
    audit_('REJECT_ORDER','Orders',o.OrderId,{reason:payload.reason});
    return {ok:true};
  });
}
