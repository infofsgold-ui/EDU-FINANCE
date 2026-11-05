// Dấu của từng loại phiếu kho. ADJUSTMENT (bản 0.1) được giữ lại để đọc dữ liệu cũ, tính là tăng.
const MOVEMENT_SIGN_ = {IN:1, TRANSFER_IN:1, ADJUSTMENT_IN:1, ADJUSTMENT:1, OUT:-1, TRANSFER_OUT:-1, ADJUSTMENT_OUT:-1};

function saveProduct(payload) {
  const user = requireCap_('manageStock');
  if (!payload.ProductName) throw new Error('Tên hàng hóa là bắt buộc.');
  return withWriteLock_(() => {
    const id = nextId_('PRD');
    const sku = String(payload.SKU||'').trim() || id;
    if (readTable_('Products').some(p => String(p.SKU).trim().toLowerCase() === sku.toLowerCase()))
      throw new Error('Mã SKU "' + sku + '" đã tồn tại.');
    appendObject_('Products',{
      ProductId:id, SKU:asText_(sku), ProductName:String(payload.ProductName).trim(),
      Category:String(payload.Category||''), Unit:String(payload.Unit||'cái'), Size:String(payload.Size||''),
      ReorderLevel:Number(payload.ReorderLevel||0), Active:true, SalePrice:Number(payload.SalePrice||0)
    });
    audit_('CREATE','Products',id,payload);
    return {ok:true,id};
  });
}

/**
 * Ghi phiếu kho. MovementType:
 *  IN, OUT, ADJUSTMENT_IN (kiểm kê thừa), ADJUSTMENT_OUT (kiểm kê thiếu/hỏng),
 *  TRANSFER (cần ToWarehouseId) → tạo đồng thời TRANSFER_OUT ở kho đi và TRANSFER_IN ở kho đến, chung TransferId.
 * Các phiếu làm giảm tồn bị chặn nếu tồn hiện tại không đủ (chống âm kho).
 */
function recordStockMovement(payload) {
  const user = requireCap_('manageStock');
  const warehouseId = String(payload.WarehouseId||'');
  const productId = String(payload.ProductId||'');
  const type = String(payload.MovementType||'').toUpperCase();
  const qty = Number(payload.Quantity);
  if (!warehouseId || !productId || !['IN','OUT','ADJUSTMENT_IN','ADJUSTMENT_OUT','TRANSFER'].includes(type) || !(qty>0))
    throw new Error('Thông tin phiếu kho chưa hợp lệ.');
  const warehouses = readTable_('Warehouses');
  const warehouse = warehouses.find(w=>String(w.WarehouseId)===warehouseId && truthy_(w.Active));
  if (!warehouse) throw new Error('Không tìm thấy kho đang hoạt động.');
  if (warehouse.SchoolId) assertSchoolAccess_(user,warehouse.SchoolId);
  if (!readTable_('Products').some(p=>String(p.ProductId)===productId && truthy_(p.Active))) throw new Error('Không tìm thấy mặt hàng đang hoạt động.');
  let target = null;
  if (type === 'TRANSFER') {
    const toId = String(payload.ToWarehouseId||'');
    target = warehouses.find(w=>String(w.WarehouseId)===toId && truthy_(w.Active));
    if (!target) throw new Error('Chuyển kho cần chọn kho đến hợp lệ.');
    if (toId === warehouseId) throw new Error('Kho đến phải khác kho đi.');
  }
  return withWriteLock_(() => {
    if (['OUT','ADJUSTMENT_OUT','TRANSFER'].includes(type)) {
      const onHand = stockOnHand_(warehouseId, productId);
      if (qty > onHand) throw new Error('Không đủ tồn kho: hiện có ' + onHand + ', yêu cầu ' + qty + '.');
    }
    const now = new Date();
    const base = {
      ProductId:productId, MovementDate:String(payload.MovementDate||Utilities.formatDate(now,APP.TZ,'yyyy-MM-dd')),
      Quantity:qty, UnitCost:Number(payload.UnitCost||0), Reference:String(payload.Reference||''),
      Notes:String(payload.Notes||''), Status:'POSTED', CreatedAt:now, CreatedBy:user.email
    };
    const rows = [];
    if (type === 'TRANSFER') {
      const transferId = nextId_('TRF');
      rows.push(Object.assign({}, base, {MovementId:nextId_('MOV'), WarehouseId:warehouseId, MovementType:'TRANSFER_OUT', TransferId:transferId}));
      rows.push(Object.assign({}, base, {MovementId:nextId_('MOV'), WarehouseId:String(target.WarehouseId), MovementType:'TRANSFER_IN', TransferId:transferId}));
    } else {
      rows.push(Object.assign({}, base, {MovementId:nextId_('MOV'), WarehouseId:warehouseId, MovementType:type}));
    }
    appendObjects_('StockMovements', rows);
    const ids = rows.map(r=>r.MovementId);
    audit_('STOCK_MOVEMENT', 'StockMovements', ids.join(','), payload);
    return {ok:true, id:ids[0], ids};
  });
}

function stockOnHand_(warehouseId, productId) {
  return readTable_('StockMovements')
    .filter(m=>m.Status==='POSTED' && String(m.WarehouseId)===warehouseId && String(m.ProductId)===productId)
    .reduce((s,m)=>s + (MOVEMENT_SIGN_[String(m.MovementType).toUpperCase()]||0) * Number(m.Quantity||0), 0);
}

function getStockBalances() {
  return getInventoryReport({}).rows.map(r => ({warehouse:r.warehouse, product:r.product, quantity:r.closing, lowStock:r.lowStock}));
}

/**
 * Báo cáo nhập - xuất - tồn theo kho × mặt hàng trong khoảng [from, to] (YYYY-MM-DD, trống = không giới hạn).
 * Tồn đầu = phát sinh trước from; Nhập = phiếu tăng trong kỳ; Xuất = phiếu giảm trong kỳ; Tồn cuối = đầu + nhập - xuất.
 * Giá vốn bình quân theo mặt hàng (toàn hệ thống) = tổng (SL × giá vốn) / tổng SL các phiếu nhập mua (IN) đến hết kỳ,
 * để hàng chuyển từ kho tổng về kho trường vẫn có giá trị tồn.
 */
function getInventoryReport(params) {
  const user = requireCap_('viewStock');
  params = params || {};
  return memo_('inventory', [user.role, listSchoolsForUser_(user).map(s => String(s.SchoolId)), params], () => inventoryReport_(user, params));
}

function inventoryReport_(user, params) {
  const from = String(params.from || ''), to = String(params.to || '');
  const allowed = new Set(listSchoolsForUser_(user).map(s=>String(s.SchoolId)));
  let warehouses = readTable_('Warehouses').filter(w => (!w.SchoolId && isGroupWide_(user)) || allowed.has(String(w.SchoolId)) ||
    (!w.SchoolId && can_(user,'manageStock')));
  if (params.schoolId) warehouses = warehouses.filter(w => String(w.SchoolId) === String(params.schoolId));
  const warehouseChoices = warehouses.filter(w => truthy_(w.Active)).map(w => ({id:String(w.WarehouseId), name:w.WarehouseName, schoolId:String(w.SchoolId || '')}));
  if (params.warehouseId) warehouses = warehouses.filter(w => String(w.WarehouseId) === String(params.warehouseId));
  const wmap = Object.fromEntries(warehouses.map(w=>[String(w.WarehouseId),w]));
  const pmap = Object.fromEntries(readTable_('Products').map(p=>[String(p.ProductId),p]));
  const acc = {}, cost = {};
  const movements = [];
  readTable_('StockMovements').forEach(m => {
    if (m.Status !== 'POSTED') return;
    if (String(m.MovementType).toUpperCase() === 'IN' && Number(m.UnitCost) > 0 && (!to || String(m.MovementDate).slice(0,10) <= to)) {
      const c = cost[m.ProductId] || (cost[m.ProductId] = {q:0, v:0});
      c.q += Number(m.Quantity || 0); c.v += Number(m.Quantity || 0) * Number(m.UnitCost);
    }
    if (!wmap[String(m.WarehouseId)]) return;
    if (params.category && String((pmap[String(m.ProductId)]||{}).Category) !== String(params.category)) return;
    const d = String(m.MovementDate || '').slice(0,10);
    if (to && d > to) return;
    const sign = MOVEMENT_SIGN_[String(m.MovementType).toUpperCase()] || 0;
    const q = Number(m.Quantity || 0);
    const key = m.WarehouseId + '|' + m.ProductId;
    const a = acc[key] || (acc[key] = {opening:0, inQty:0, outQty:0, buy:0, trIn:0, sale:0, trOut:0, adj:0});
    const type = String(m.MovementType).toUpperCase();
    if (from && d < from) a.opening += sign * q;
    else {
      if (sign > 0) a.inQty += q; else a.outQty += q;
      // Tách từng loại để báo cáo rõ: chuyển kho là luân chuyển nội bộ, không phải nhập mua / xuất bán.
      if (type === 'IN') a.buy += q; else if (type === 'TRANSFER_IN') a.trIn += q;
      else if (type === 'OUT') a.sale += q; else if (type === 'TRANSFER_OUT') a.trOut += q;
      else a.adj += sign * q;
      movements.push(m);
    }
  });
  const rows = Object.keys(acc).map(k => {
    const [wid,pid] = k.split('|');
    const p = pmap[pid] || {}, a = acc[k];
    const closing = a.opening + a.inQty - a.outQty;
    const c = cost[pid];
    const avgCost = c && c.q ? roundMoney_(c.v / c.q) : 0;
    const reorder = Number(p.ReorderLevel || 0);
    return {warehouseId:wid, warehouse:wmap[wid].WarehouseName, productId:pid, sku:String(p.SKU||''), product:p.ProductName||pid,
      category:p.Category||'', size:p.Size||'', unit:p.Unit||'', opening:a.opening, inQty:a.inQty, outQty:a.outQty, closing,
      buy:a.buy, trIn:a.trIn, sale:a.sale, trOut:a.trOut, adj:a.adj,
      avgCost, stockValue:roundMoney_(closing * avgCost), salePrice:Number(p.SalePrice||0), lowStock: reorder > 0 && closing <= reorder};
  }).sort((x,y) => (x.warehouse + x.product).localeCompare(y.warehouse + y.product, 'vi'));
  // Mặt hàng đang kinh doanh nhưng chưa có phiếu kho nào trong phạm vi → vẫn liệt kê với tồn 0 để dễ nhập kho.
  if (!params.warehouseId) {
    const has = new Set(rows.map(r => String(r.productId)));
    readTable_('Products').filter(p => truthy_(p.Active) && !has.has(String(p.ProductId)) && (!params.category || String(p.Category) === String(params.category)))
      .sort((a,b) => String(a.ProductName).localeCompare(String(b.ProductName), 'vi'))
      .forEach(p => rows.push({warehouseId:'', warehouse:'(Chưa nhập kho)', productId:String(p.ProductId), sku:String(p.SKU||''), product:p.ProductName,
        category:p.Category||'', size:p.Size||'', unit:p.Unit||'', opening:0, inQty:0, outQty:0, closing:0, avgCost:0, stockValue:0,
        buy:0, trIn:0, sale:0, trOut:0, adj:0,
        salePrice:Number(p.SalePrice||0), lowStock:false, noStock:true}));
  }
  movements.sort((x,y) => String(y.MovementDate).localeCompare(String(x.MovementDate)));
  return {
    from, to, rows,
    warehouseCount: warehouses.length, productCount: readTable_('Products').filter(p => truthy_(p.Active)).length,
    totals: {opening:sum_(rows,'opening'), inQty:sum_(rows,'inQty'), outQty:sum_(rows,'outQty'), closing:sum_(rows,'closing'),
             buy:sum_(rows,'buy'), trIn:sum_(rows,'trIn'), sale:sum_(rows,'sale'), trOut:sum_(rows,'trOut'), adj:sum_(rows,'adj'),
             stockValue:roundMoney_(sum_(rows,'stockValue')), lowStock:rows.filter(r=>r.lowStock).length},
    warehouses: warehouseChoices,
    movements: movements.slice(0, 300).map(m => ({date:m.MovementDate, type:m.MovementType, warehouse:wmap[String(m.WarehouseId)].WarehouseName,
      sign: MOVEMENT_SIGN_[String(m.MovementType).toUpperCase()] || 0,
      product:(pmap[String(m.ProductId)]||{}).ProductName || m.ProductId, quantity:Number(m.Quantity||0), unitCost:Number(m.UnitCost||0),
      reference:m.Reference, notes:m.Notes, by:m.CreatedBy}))
  };
}

function sum_(rows, k) { return rows.reduce((s,r) => s + Number(r[k] || 0), 0); }

// ===================== NHẬP HÀNG (phiếu nhập nhiều dòng) =====================

/**
 * Phiếu nhập hàng: nhiều mặt hàng vào 1 kho trong 1 lần, cùng nhà cung cấp / số chứng từ.
 * payload: {WarehouseId, MovementDate, Vendor, Reference, Notes, items:[{ProductId, Quantity, UnitCost}], createExpense}
 * Mỗi dòng ghi 1 phiếu kho loại IN, chung ReceiptId. createExpense = TRUE → ghi thêm 1 khoản chi "Nhập hàng"
 * bằng tổng tiền phiếu (cần quyền nhập chi phí và kho thuộc một trường).
 */
function recordGoodsReceipt(payload) {
  const user = requireCap_('manageStock');
  const warehouseId = String(payload.WarehouseId || '');
  const wh = readTable_('Warehouses').find(w => String(w.WarehouseId) === warehouseId && truthy_(w.Active));
  if (!wh) throw new Error('Chọn kho nhập hàng.');
  if (wh.SchoolId) assertSchoolAccess_(user, wh.SchoolId);
  const pmap = Object.fromEntries(readTable_('Products').filter(p => truthy_(p.Active)).map(p => [String(p.ProductId), p]));
  const items = (payload.items || []).map(i => ({id:String(i.ProductId || ''), qty:Number(i.Quantity), cost:Number(i.UnitCost || 0)}))
    .filter(i => i.id && i.qty);
  if (!items.length) throw new Error('Phiếu nhập chưa có mặt hàng nào.');
  items.forEach(i => {
    if (!pmap[i.id]) throw new Error('Mặt hàng không tồn tại hoặc đã ngừng: ' + i.id);
    if (!(i.qty > 0) || Math.floor(i.qty) !== i.qty) throw new Error('Số lượng của "' + pmap[i.id].ProductName + '" phải là số nguyên dương.');
    if (!(i.cost >= 0)) throw new Error('Đơn giá vốn của "' + pmap[i.id].ProductName + '" không hợp lệ.');
  });
  const date = String(payload.MovementDate || Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd')).slice(0, 10);
  const wantExpense = !!payload.createExpense && can_(user, 'recordExpense');
  if (payload.createExpense && !wantExpense) throw new Error('Bạn không có quyền ghi nhận chi phí — bỏ chọn “Ghi nhận chi phí nhập hàng”.');
  if (wantExpense && !wh.SchoolId) throw new Error('Kho tổng không thuộc trường nào — không ghi chi phí tự động được. Bỏ chọn hoặc nhập chi phí ở trang Chi phí.');
  return withWriteLock_(() => {
    const now = new Date(), receiptId = nextId_('PNK');
    const rows = items.map(i => ({MovementId:nextId_('MOV'), WarehouseId:warehouseId, ProductId:i.id, MovementDate:date, MovementType:'IN',
      Quantity:i.qty, UnitCost:i.cost, Reference:String(payload.Reference || ''), Notes:String(payload.Notes || ''), Status:'POSTED',
      CreatedAt:now, CreatedBy:user.email, TransferId:'', ReceiptId:receiptId, Vendor:String(payload.Vendor || '')}));
    appendObjects_('StockMovements', rows);
    const total = roundMoney_(items.reduce((s, i) => s + i.qty * i.cost, 0));
    let expenseId = '';
    if (wantExpense && total > 0) {
      expenseId = nextId_('EXP');
      const auto = can_(user, 'approveExpense');
      appendObject_('Expenses', {ExpenseId:expenseId, SchoolId:wh.SchoolId, ExpenseDate:date, Category:'Nhập hàng (đồng phục/sách)',
        Vendor:String(payload.Vendor || ''), Description:'Phiếu nhập ' + receiptId + (payload.Reference ? ' · CT ' + payload.Reference : '') + ' · ' + items.length + ' mặt hàng',
        Amount:total, BudgetPeriod:asText_(date.slice(0, 7)), Status:auto ? 'APPROVED' : 'PENDING', ApprovedBy:auto ? user.email : '',
        CreatedAt:now, CreatedBy:user.email});
    }
    audit_('GOODS_RECEIPT', 'StockMovements', receiptId, {warehouseId, items:items.length, total, expenseId});
    return {ok:true, receiptId, lines:rows.length, totalQty:items.reduce((s, i) => s + i.qty, 0), total, expenseId};
  });
}

/** Danh sách phiếu nhập (gộp theo ReceiptId; phiếu nhập lẻ cũ ghi bằng "Ghi phiếu kho" được coi là 1 phiếu 1 dòng) + giá vốn gần nhất. */
function getGoodsReceipts(params) {
  const user = requireCap_('viewStock');
  params = params || {};
  const allowed = new Set(listSchoolsForUser_(user).map(s => String(s.SchoolId)));
  const wmap = Object.fromEntries(readTable_('Warehouses').filter(w => isGroupWide_(user) || !w.SchoolId || allowed.has(String(w.SchoolId)))
    .map(w => [String(w.WarehouseId), w]));
  const pmap = Object.fromEntries(readTable_('Products').map(p => [String(p.ProductId), p]));
  const groups = {}, lastCost = {};
  readTable_('StockMovements').forEach(m => {
    if (m.Status !== 'POSTED' || String(m.MovementType).toUpperCase() !== 'IN') return;
    if (Number(m.UnitCost) > 0) { const c = lastCost[m.ProductId]; if (!c || String(m.MovementDate) >= c.date) lastCost[m.ProductId] = {date:String(m.MovementDate), cost:Number(m.UnitCost)}; }
    const w = wmap[String(m.WarehouseId)];
    if (!w) return;
    if (params.schoolId && String(w.SchoolId) !== String(params.schoolId)) return;
    const d = String(m.MovementDate).slice(0, 10);
    if ((params.from && d < params.from) || (params.to && d > params.to)) return;
    const key = m.ReceiptId || m.MovementId;
    const g = groups[key] || (groups[key] = {receiptId:key, date:d, warehouse:w.WarehouseName, vendor:m.Vendor || '', reference:String(m.Reference || ''),
      notes:m.Notes || '', by:m.CreatedBy, createdAt:String(m.CreatedAt), lines:[], totalQty:0, total:0});
    const qty = Number(m.Quantity || 0), cost = Number(m.UnitCost || 0), p = pmap[String(m.ProductId)] || {};
    g.lines.push({product:p.ProductName || m.ProductId, sku:String(p.SKU || ''), size:p.Size || '', unit:p.Unit || '', qty, cost, amount:roundMoney_(qty * cost)});
    g.totalQty += qty; g.total = roundMoney_(g.total + qty * cost);
  });
  return {
    rows: Object.values(groups).sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt)).slice(0, 300),
    lastCost: Object.fromEntries(Object.keys(lastCost).map(k => [k, lastCost[k].cost]))
  };
}
