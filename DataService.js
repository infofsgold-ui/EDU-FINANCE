// Bộ nhớ đệm trong một lần thực thi (mỗi lời gọi google.script.run là một lần thực thi riêng).
const TABLE_CACHE_ = {};
const SHEET_READY_ = {};
const SHEET_OBJ_ = {};

/**
 * BỘ NHỚ ĐỆM DÙNG CHUNG (CacheService) — đọc bảng từ Cache thay vì Google Sheets.
 *  - Mỗi bảng có một "phiên bản" (TV:<bảng>). Ghi dữ liệu → đổi phiên bản → bản đệm cũ tự mất hiệu lực, người khác đọc ngay bản mới.
 *  - Phiên bản được đổi SAU khi SpreadsheetApp.flush() và TRƯỚC khi nhả khóa ghi, nên không ai đọc lại được dữ liệu cũ.
 *  - Bản đệm sống TC_TTL_ giây: sửa tay trực tiếp trên Google Sheets sẽ hiện sau tối đa 30 phút (hoặc bấm "Làm mới dữ liệu" ở Cài đặt).
 * Dữ liệu nén gzip rồi chia khối (CacheService giới hạn 100 KB mỗi khóa).
 */
const TC_TTL_ = 1800, TC_VERSION_TTL_ = 21600, TC_CHUNK_ = 90000, TC_MAX_CHUNKS_ = 400;
const PERF_ = {sheetReads:0, cacheHits:0, memoHits:0, sheetMs:0, tables:[]};
const DIRTY_ = {}, PRELOADED_ = {};
let TV_ = null, LOCK_DEPTH_ = 0, FORCE_SHEET_ = false;

function tableMetaKey_(name) { return 'T2M:' + name + ':' + (APP.HEADERS[name] || []).length; }

/** Phiên bản + thông tin bản đệm của mọi bảng: 1 lệnh duy nhất cho cả lần thực thi. */
function tableVersions_() {
  if (TV_) return TV_;
  const keys = [];
  Object.keys(APP.HEADERS).forEach(n => keys.push('TV:' + n, tableMetaKey_(n), 'TS:' + n + ':' + APP.HEADERS[n].length));
  try { TV_ = CacheService.getScriptCache().getAll(keys) || {}; } catch (e) { TV_ = {}; }
  return TV_;
}

/** Lưu chuỗi lớn: nén, chia khối, ghi theo lô. Trả về số khối, 0 nếu quá lớn. */
function cachePutBig_(key, text, ttl) {
  const b64 = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(text, 'application/json')).getBytes());
  const n = Math.ceil(b64.length / TC_CHUNK_) || 1;
  if (n > TC_MAX_CHUNKS_) return 0;
  const cache = CacheService.getScriptCache();
  for (let i = 0; i < n; i += 40) {
    const batch = {};
    for (let j = i; j < Math.min(n, i + 40); j++) batch[key + ':' + j] = b64.substr(j * TC_CHUNK_, TC_CHUNK_);
    cache.putAll(batch, ttl);
  }
  return n;
}
function cacheGetBig_(key, n) {
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + ':' + i);
  const got = {}, need = keys.filter(k => PRELOADED_[k] === undefined);
  keys.forEach(k => { if (PRELOADED_[k] !== undefined) got[k] = PRELOADED_[k]; });
  for (let i = 0; i < need.length; i += 100) Object.assign(got, CacheService.getScriptCache().getAll(need.slice(i, i + 100)));
  if (keys.some(k => got[k] === undefined || got[k] === null)) return null;
  const blob = Utilities.newBlob(Utilities.base64Decode(keys.map(k => got[k]).join('')), 'application/x-gzip');
  return Utilities.ungzip(blob).getDataAsString('UTF-8');
}

/** Lấy một lần các bảng nhỏ dùng ở mọi lời gọi (phiên đăng nhập, phân quyền). */
function preloadTables_(names) {
  try {
    const tv = tableVersions_(), keys = [];
    names.forEach(name => {
      const meta = tv[tableMetaKey_(name)];
      if (!meta) return;
      const m = JSON.parse(meta);
      if (m.v !== (tv['TV:' + name] || '0')) return;
      for (let i = 0; i < m.n; i++) keys.push('T2:' + name + ':' + m.v + ':' + i);
    });
    if (keys.length) Object.assign(PRELOADED_, CacheService.getScriptCache().getAll(keys));
  } catch (e) { Logger.log('preloadTables_: ' + e); }
}

function rowsFromValues_(headers, rows) {
  return rows.map(row => { const o = {}; headers.forEach((h, i) => o[h] = row[i]); return o; });
}

function tableFromCache_(name) {
  try {
    const tv = tableVersions_(), meta = tv[tableMetaKey_(name)];
    if (!meta) return null;
    const m = JSON.parse(meta);
    if (m.v !== (tv['TV:' + name] || '0')) return null;
    const text = cacheGetBig_('T2:' + name + ':' + m.v, m.n);
    if (text === null) return null;
    if (text.length !== m.l) return null; // sai độ dài = giải mã lỗi → đọc lại từ Sheets
    const d = JSON.parse(text);
    return rowsFromValues_(d.h, d.r);
  } catch (e) { Logger.log('tableFromCache_ ' + name + ': ' + e); return null; }
}

function tableToCache_(name, version, headers, rows) {
  try {
    const key = 'T2:' + name + ':' + version;
    const text = JSON.stringify({h:headers, r:rows});
    const n = cachePutBig_(key, text, TC_TTL_);
    if (n) CacheService.getScriptCache().put(tableMetaKey_(name), JSON.stringify({v:version, n, l:text.length}), TC_TTL_);
  } catch (e) { Logger.log('tableToCache_ ' + name + ': ' + e); }
}

/**
 * Lấy sheet theo tên; tự TẠO sheet còn thiếu và tự BỔ SUNG cột mới ở cuối theo APP.HEADERS
 * (nâng cấp phiên bản không phụ thuộc việc chạy tay setupDatabase). Đã kiểm tra thì nhớ 6 giờ, không gọi lại Sheets.
 */
function sheet_(sheetName) {
  if (SHEET_OBJ_[sheetName] && SHEET_READY_[sheetName]) return SHEET_OBJ_[sheetName];
  const ss = getDatabase_();
  let sh = SHEET_OBJ_[sheetName] || ss.getSheetByName(sheetName);
  const headers = APP.HEADERS[sheetName];
  if (!sh) {
    if (!headers) throw new Error('Thiếu sheet: ' + sheetName);
    sh = ss.insertSheet(sheetName);
  }
  SHEET_OBJ_[sheetName] = sh;
  if (headers && !SHEET_READY_[sheetName]) {
    const schemaKey = 'TS:' + sheetName + ':' + headers.length;
    if (!tableVersions_()[schemaKey]) {
      const width = Math.max(sh.getLastColumn(), headers.length);
      const existing = sh.getLastRow() ? sh.getRange(1, 1, 1, width).getValues()[0].map(v => String(v)) : [];
      const mismatch = headers.findIndex((h, i) => existing[i] !== h);
      if (mismatch > -1 && existing.slice(mismatch).every(v => v === '')) {
        // Sheet mới hoặc chỉ thiếu các cột cuối → ghi bổ sung tiêu đề, không đụng dữ liệu.
        sh.getRange(1, 1, 1, headers.length).setValues([headers])
          .setBackground('#435467').setFontColor('#FFFFFF').setFontWeight('bold');
        sh.setFrozenRows(1);
        delete TABLE_CACHE_[sheetName];
      }
      try { CacheService.getScriptCache().put(schemaKey, '1', TC_VERSION_TTL_); } catch (e) {}
    }
    SHEET_READY_[sheetName] = true;
  }
  return sh;
}

function readTable_(sheetName) {
  if (TABLE_CACHE_[sheetName]) return TABLE_CACHE_[sheetName];
  const started = Date.now();
  if (!DIRTY_[sheetName] && !FORCE_SHEET_) {
    const cached = tableFromCache_(sheetName);
    if (cached) { PERF_.cacheHits++; return (TABLE_CACHE_[sheetName] = cached); }
  }
  // Lấy phiên bản TRƯỚC khi đọc: nếu có người ghi trong lúc đọc, bản đệm này tự mất hiệu lực.
  const version = tableVersions_()['TV:' + sheetName] || '0';
  const sh = sheet_(sheetName);
  const values = sh.getDataRange().getValues();
  PERF_.sheetReads++; PERF_.tables.push(sheetName);
  const headers = values.length ? values[0].map(String) : [];
  const rows = values.slice(1).filter(row => row.some(v => v !== '' && v !== null)).map(row => row.map(normalizeValue_));
  if (!DIRTY_[sheetName] && values.length) tableToCache_(sheetName, version, headers, rows);
  PERF_.sheetMs += Date.now() - started;
  return (TABLE_CACHE_[sheetName] = rowsFromValues_(headers, rows));
}

/** Đánh dấu bảng đã đổi. Trong khóa ghi: công bố lúc nhả khóa; ngoài khóa: công bố ngay. */
function invalidateTable_(sheetName) {
  delete TABLE_CACHE_[sheetName];
  DIRTY_[sheetName] = true;
  if (!LOCK_DEPTH_) commitTables_();
}

/** Đẩy thay đổi xuống Sheets rồi đổi phiên bản các bảng đã ghi (mọi người sẽ đọc bản mới). */
function commitTables_() {
  const names = Object.keys(DIRTY_);
  if (!names.length) return;
  SpreadsheetApp.flush();
  const stamp = String(Date.now()) + Utilities.getUuid().slice(0, 6), put = {};
  names.forEach(n => { put['TV:' + n] = stamp; delete DIRTY_[n]; });
  CacheService.getScriptCache().putAll(put, TC_VERSION_TTL_);
  TV_ = null;
}

/** Bảng thay đổi thường xuyên nhưng không ảnh hưởng kết quả tính toán. */
const MEMO_IGNORE_ = ['AuditLog','Credentials','AlertReads'];

/**
 * Nhớ kết quả tính toán nặng (dashboard, tồn kho, cảnh báo). Khóa gồm phiên bản mọi bảng, nên dữ liệu đổi là tự tính lại.
 * keyParts: phải phân biệt phạm vi người dùng và tham số. Hỏng cache thì vẫn tính bình thường.
 */
function memo_(name, keyParts, fn) {
  if (Object.keys(DIRTY_).length) return fn();
  let key = '';
  try {
    const tv = tableVersions_();
    const sig = Object.keys(APP.HEADERS).filter(n => MEMO_IGNORE_.indexOf(n) < 0).map(n => tv['TV:' + n] || '0').join('|');
    const today = Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd');
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, name + JSON.stringify(keyParts) + today + sig, Utilities.Charset.UTF_8);
    key = 'M2:' + digest.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
    const cache = CacheService.getScriptCache(), n = cache.get(key);
    if (n) {
      const text = cacheGetBig_(key, Number(n));
      if (text !== null) { PERF_.memoHits++; return JSON.parse(text); }
    }
  } catch (e) { Logger.log('memo_ ' + name + ': ' + e); key = ''; }
  const result = fn();
  if (key) {
    try {
      const n = cachePutBig_(key, JSON.stringify(result), TC_TTL_);
      if (n) CacheService.getScriptCache().put(key, String(n), TC_TTL_);
    } catch (e) { Logger.log('memo_ put ' + name + ': ' + e); }
  }
  return result;
}

/** Xóa toàn bộ bản đệm (nút "Làm mới dữ liệu"): dùng sau khi sửa tay trên Google Sheets. */
function clearDataCache() {
  requireCap_('manageSettings');
  const stamp = String(Date.now()) + Utilities.getUuid().slice(0, 6), put = {};
  Object.keys(APP.HEADERS).forEach(n => put['TV:' + n] = stamp);
  CacheService.getScriptCache().putAll(put, TC_VERSION_TTL_);
  TV_ = null;
  return {ok:true};
}

/**
 * Giữ bộ nhớ đệm luôn sẵn sàng + cập nhật các sửa tay trên Sheets. Tùy chọn: thêm trình kích hoạt theo thời gian
 * (Apps Script → Triggers → hàm warmCache → mỗi 10 phút). Không có trình kích hoạt ứng dụng vẫn chạy bình thường.
 */
function warmCache() {
  FORCE_SHEET_ = true;
  try { ['Schools','Classes','Users','Credentials','Students','FeeTypes','Products','Warehouses','Settings','Discounts','FeeRates','Invoices','Payments','Expenses','Orders','SchoolBanners'].forEach(n => { delete TABLE_CACHE_[n]; readTable_(n); }); }
  finally { FORCE_SHEET_ = false; }
}

function normalizeValue_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, APP.TZ, 'yyyy-MM-dd');
  return v;
}

function appendObject_(sheetName, obj) {
  appendObjects_(sheetName, [obj]);
}

/** Ghi nhiều dòng bằng một lệnh setValues (nhanh hơn appendRow từng dòng). */
function appendObjects_(sheetName, objs) {
  if (!objs.length) return;
  const sh = sheet_(sheetName);
  const headers = APP.HEADERS[sheetName];
  if (!sh || !headers) throw new Error('Bảng không được hỗ trợ: ' + sheetName);
  const rows = objs.map(obj => headers.map(h => obj[h] === undefined ? '' : obj[h]));
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  invalidateTable_(sheetName);
}

function updateObjectById_(sheetName, idHeader, id, patch) {
  const patches = {};
  patches[id] = patch;
  return updateObjectsById_(sheetName, idHeader, patches) === 1;
}

/** patches: { id: {Cột: giá trị} }. Đọc sheet một lần, chỉ ghi các ô cần đổi. Trả về số dòng đã cập nhật. */
function updateObjectsById_(sheetName, idHeader, patches) {
  if (!Object.keys(patches).length) return 0;
  const sh = sheet_(sheetName);
  const data = sh.getDataRange().getValues();
  const headers = data[0].map(String);
  const idCol = headers.indexOf(idHeader);
  if (idCol < 0) throw new Error('Không tìm thấy cột ID.');
  let count = 0;
  for (let r = 1; r < data.length; r++) {
    const patch = patches[String(data[r][idCol])];
    if (!patch) continue;
    // Gom các cột liền kề thành một lệnh setValues; chỉ ghi đúng ô được sửa (không ghi lại ô khác để giữ định dạng văn bản).
    const cols = Object.keys(patch).map(k => [headers.indexOf(k), patch[k]]).filter(x => x[0] > -1).sort((a,b) => a[0] - b[0]);
    for (let i = 0; i < cols.length;) {
      let j = i;
      while (j + 1 < cols.length && cols[j+1][0] === cols[j][0] + 1) j++;
      sh.getRange(r+1, cols[i][0]+1, 1, j-i+1).setValues([cols.slice(i, j+1).map(x => x[1])]);
      i = j + 1;
    }
    count++;
  }
  invalidateTable_(sheetName);
  return count;
}

/** Xóa hẳn 1 dòng theo khóa. Chỉ dùng cho danh mục chưa phát sinh dữ liệu (đã kiểm tra trước khi gọi). */
function deleteRowById_(sheetName, idHeader, id) {
  const sh = sheet_(sheetName);
  const data = sh.getDataRange().getValues();
  const col = data[0].map(String).indexOf(idHeader);
  for (let r = data.length - 1; r >= 1; r--) {
    if (String(data[r][col]) === String(id)) { sh.deleteRow(r + 1); invalidateTable_(sheetName); return true; }
  }
  return false;
}

function nextId_(prefix) {
  return prefix + '-' + Utilities.getUuid().replace(/-/g,'').substring(0,12).toUpperCase();
}

function truthy_(v) {
  return v === true || String(v).toLowerCase() === 'true' || String(v) === '1' || String(v).toLowerCase() === 'yes';
}

function audit_(action, entity, entityId, details) {
  const u = currentUser_();
  appendObject_('AuditLog', {
    LogId: nextId_('LOG'), Timestamp: new Date(), UserEmail: u.email,
    Action: action, Entity: entity, EntityId: entityId || '',
    Details: typeof details === 'string' ? details : JSON.stringify(details || {})
  });
}

function withWriteLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  LOCK_DEPTH_++;
  try {
    // Sau khi giành được khóa, đọc lại dữ liệu mới nhất (người khác có thể vừa ghi).
    Object.keys(TABLE_CACHE_).forEach(k => { if (k !== 'Users') delete TABLE_CACHE_[k]; });
    TV_ = null;
    return fn();
  } finally {
    LOCK_DEPTH_--;
    try { if (!LOCK_DEPTH_) commitTables_(); } finally { lock.releaseLock(); }
  }
}

function getRows(entity) {
  const user = requireCap_('viewRawData');
  const allowed = {
    schools: ['Schools','SchoolId'],
    classes: ['Classes','ClassId'],
    students: ['Students','StudentId'],
    feeTypes: ['FeeTypes','FeeTypeId'],
    feeRates: ['FeeRates','RateId'],
    discounts: ['Discounts','DiscountId'],
    invoices: ['Invoices','InvoiceId'],
    invoiceLines: ['InvoiceLines','LineId'],
    payments: ['Payments','PaymentId'],
    allocations: ['Allocations','AllocationId'],
    products: ['Products','ProductId'],
    warehouses: ['Warehouses','WarehouseId'],
    stockMovements: ['StockMovements','MovementId'],
    expenses: ['Expenses','ExpenseId']
  };
  if (!allowed[entity]) throw new Error('Không hỗ trợ danh mục này.');
  let rows = readTable_(allowed[entity][0]);
  if (!isGroupWide_(user)) {
    const sid = String(user.schoolId);
    const inSchool = r => !r.SchoolId || r.SchoolId === '*' || String(r.SchoolId) === sid;
    if (entity === 'stockMovements') {
      // Phiếu kho không có SchoolId: lọc theo kho thuộc trường.
      const wh = new Set(readTable_('Warehouses').filter(inSchool).map(w => String(w.WarehouseId)));
      rows = rows.filter(r => wh.has(String(r.WarehouseId)));
    } else if (entity === 'invoiceLines' || entity === 'allocations') {
      // Không có SchoolId: lọc theo hóa đơn thuộc trường.
      const inv = new Set(readTable_('Invoices').filter(i => String(i.SchoolId) === sid).map(i => String(i.InvoiceId)));
      rows = rows.filter(r => inv.has(String(r.InvoiceId)));
    } else {
      rows = rows.filter(inSchool);
    }
  }
  return rows.slice(0, 2000);
}
