/**
 * THÔNG BÁO HỌC PHÍ: Email (MailApp), Zalo OA (ZNS), SMS (eSMS.vn) + mã QR chuyển khoản VietQR.
 *
 * Cấu hình KHÔNG bí mật (sheet Settings, SchoolId = '*' là mặc định, hoặc riêng cho từng trường):
 *   BANK_BIN, BANK_ACCOUNT, BANK_ACCOUNT_NAME, BANK_NAME, EMAIL_SUBJECT, SMS_TEMPLATE, ZNS_TEMPLATE_ID, HOTLINE
 * Thông tin BÍ MẬT lưu trong Script Properties (không bao giờ trả về trình duyệt):
 *   ZALO_APP_ID, ZALO_APP_SECRET, ZALO_REFRESH_TOKEN, ZALO_ACCESS_TOKEN, ZALO_TOKEN_EXPIRES,
 *   SMS_API_KEY, SMS_SECRET_KEY, SMS_BRANDNAME
 */

const SECRET_KEYS_ = ['ZALO_APP_ID','ZALO_APP_SECRET','ZALO_REFRESH_TOKEN','SMS_API_KEY','SMS_SECRET_KEY','SMS_BRANDNAME'];
const SETTING_KEYS_ = ['BANK_BIN','BANK_ACCOUNT','BANK_ACCOUNT_NAME','BANK_NAME','EMAIL_SUBJECT','SMS_TEMPLATE','ZNS_TEMPLATE_ID','HOTLINE','ZNS_ACCOUNT_TEMPLATE_ID','APP_URL','SCHOOL_DAYS_PER_WEEK','SCHOOL_HOLIDAYS'];
const DEFAULT_SMS_TEMPLATE_ = '{school}: Thong bao hoc phi {period} cua HS {student} ({class}): {amount}d. Han nop {due}. CK {bank} STK {account}, ND: {content}';
const DEFAULT_EMAIL_SUBJECT_ = '[{school}] Thông báo học phí {period} - {student}';

/** Ngân hàng phổ biến (mã BIN theo chuẩn VietQR/NAPAS). */
const BANKS_ = [
  ['970436','Vietcombank'],['970415','VietinBank'],['970418','BIDV'],['970405','Agribank'],['970407','Techcombank'],
  ['970422','MB Bank'],['970416','ACB'],['970432','VPBank'],['970423','TPBank'],['970403','Sacombank'],['970437','HDBank'],
  ['970441','VIB'],['970443','SHB'],['970448','OCB'],['970426','MSB'],['970440','SeABank'],['970431','Eximbank'],
  ['970449','LPBank'],['970428','Nam A Bank'],['970409','Bac A Bank']
];

function getSetting_(schoolId, key) {
  const rows = readTable_('Settings');
  const own = rows.find(r => String(r.SchoolId) === String(schoolId) && r.Key === key && String(r.Value) !== '');
  if (own) return String(own.Value);
  const def = rows.find(r => (String(r.SchoolId) === '*' || !r.SchoolId) && r.Key === key);
  return def ? String(def.Value) : '';
}

function getNotificationSettings() {
  const user = requireCap_('notify');
  const props = PropertiesService.getScriptProperties();
  const schools = [{SchoolId:'*', SchoolName:'Mặc định (áp dụng mọi trường)'}].concat(listSchoolsForUser_(user).map(s => ({SchoolId:s.SchoolId, SchoolName:s.SchoolName})));
  const rows = readTable_('Settings');
  const values = {};
  schools.forEach(s => { values[s.SchoolId] = {}; SETTING_KEYS_.forEach(k => {
    const r = rows.find(x => String(x.SchoolId || '*') === String(s.SchoolId) && x.Key === k);
    values[s.SchoolId][k] = r ? String(r.Value) : '';
  }); });
  return {
    banks: BANKS_.map(b => ({bin:b[0], name:b[1]})), schools, values, canEdit: can_(user,'manageSettings'),
    defaults: {SMS_TEMPLATE: DEFAULT_SMS_TEMPLATE_, EMAIL_SUBJECT: DEFAULT_EMAIL_SUBJECT_},
    channels: {
      EMAIL: {configured:true, quota: MailApp.getRemainingDailyQuota()},
      ZALO: {configured: !!(props.getProperty('ZALO_APP_ID') && props.getProperty('ZALO_APP_SECRET') && props.getProperty('ZALO_REFRESH_TOKEN'))},
      SMS: {configured: !!(props.getProperty('SMS_API_KEY') && props.getProperty('SMS_SECRET_KEY'))}
    },
    secretsSet: Object.fromEntries(SECRET_KEYS_.map(k => [k, !!props.getProperty(k)]))
  };
}

/** payload: {SchoolId, values:{KEY:value}, secrets:{KEY:value}} — secret rỗng = giữ nguyên. */
function saveNotificationSettings(payload) {
  const user = requireCap_('manageSettings');
  const schoolId = String(payload.SchoolId || '*');
  if (schoolId !== '*') assertSchoolAccess_(user, schoolId);
  return withWriteLock_(() => {
    const sh = sheet_('Settings');
    const data = sh.getDataRange().getValues();
    const now = new Date();
    const values = payload.values || {};
    Object.keys(values).forEach(k => {
      if (!SETTING_KEYS_.includes(k)) return;
      const v = asText_(String(values[k] == null ? '' : values[k]).trim());
      let found = false;
      for (let r = 1; r < data.length; r++) {
        if (String(data[r][0] || '*') === schoolId && data[r][1] === k) {
          sh.getRange(r+1, 3, 1, 3).setValues([[v, now, user.email]]); found = true; break;
        }
      }
      if (!found) sh.appendRow([schoolId, k, v, now, user.email]);
    });
    invalidateTable_('Settings');
    const props = PropertiesService.getScriptProperties();
    const secrets = payload.secrets || {};
    Object.keys(secrets).forEach(k => {
      if (!SECRET_KEYS_.includes(k)) return;
      const v = String(secrets[k] || '').trim();
      if (v) props.setProperty(k, v);
    });
    if (secrets.ZALO_REFRESH_TOKEN) { props.deleteProperty('ZALO_ACCESS_TOKEN'); props.deleteProperty('ZALO_TOKEN_EXPIRES'); }
    audit_('UPDATE','Settings',schoolId,{keys:Object.keys(values), secrets:Object.keys(secrets).filter(k => secrets[k])});
    return {ok:true};
  });
}

/** Nội dung chuyển khoản không dấu, ngắn gọn để đối soát: "HP <mã HS> <MMYYYY>". */
/** Nội dung chuyển khoản không dấu, ngắn gọn để đối soát: "HP <mã HS> <MMYYYY>" hoặc "HP <mã HS> <MM>-<MMYYYY>" khi nhiều tháng. */
function paymentContent_(student, period) {
  const code = foldText_(student.StudentCode || student.StudentId).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const ps = (Array.isArray(period) ? period : [period]).map(p => String(p || '').slice(0,7)).filter(Boolean).sort();
  const mmyyyy = p => p.slice(5,7) + p.slice(0,4);
  let tail = '';
  if (ps.length === 1) tail = ' ' + mmyyyy(ps[0]);
  else if (ps.length > 1) {
    const a = ps[0], b = ps[ps.length - 1];
    tail = ' ' + (a.slice(0,4) === b.slice(0,4) ? a.slice(5,7) : mmyyyy(a)) + '-' + mmyyyy(b);
  }
  return ('HP ' + code + tail).slice(0, 50);
}

// ===================== TÀI KHOẢN NGÂN HÀNG THU TIỀN =====================
// Sheet BankAccounts: mỗi trường có thể có nhiều tài khoản; SchoolId = '*' là tài khoản dùng chung cho mọi trường.
// Purpose: ALL (mọi khoản) | TUITION (học phí, bán trú) | SALE (bán hàng). IsDefault: tài khoản mặc định của trường cho mục đích đó.
// Thứ tự chọn khi không chỉ định: tài khoản của trường (đúng mục đích > ALL, mặc định trước) → tài khoản dùng chung '*' → cấu hình cũ BANK_* trong Settings.

const BANK_PURPOSES_ = {ALL:'Mọi khoản thu', TUITION:'Học phí & bán trú', SALE:'Bán hàng (đồng phục, sách…)'};

function bankName_(bin, fallback) { return (BANKS_.find(b => b[0] === String(bin)) || [])[1] || fallback || ''; }

function bankAccountView_(a, smap) {
  return {id:String(a.AccountId), schoolId:String(a.SchoolId || '*'), school:String(a.SchoolId || '*') === '*' ? 'Dùng chung mọi trường' : (smap[String(a.SchoolId)] || a.SchoolId),
    bin:String(a.BankBin || ''), bank:bankName_(a.BankBin, a.BankName), accountNo:String(a.AccountNo || ''), accountName:String(a.AccountName || ''),
    purpose:String(a.Purpose || 'ALL').toUpperCase(), purposeLabel:BANK_PURPOSES_[String(a.Purpose || 'ALL').toUpperCase()] || 'Mọi khoản thu',
    isDefault:truthy_(a.IsDefault), active:a.Active === '' || a.Active === undefined || truthy_(a.Active), note:String(a.Note || '')};
}

/** Các tài khoản dùng được cho một trường (của trường + dùng chung), đã sắp theo ưu tiên cho mục đích purpose. */
function bankAccountsFor_(schoolId, purpose) {
  purpose = String(purpose || 'TUITION').toUpperCase();
  const smap = Object.fromEntries(readTable_('Schools').map(s => [String(s.SchoolId), s.SchoolName]));
  const rank = a => (a.schoolId === String(schoolId) ? 0 : 10) + (a.purpose === purpose ? 0 : a.purpose === 'ALL' ? 2 : 5) + (a.isDefault ? 0 : 1);
  return readTable_('BankAccounts').map(a => bankAccountView_(a, smap))
    .filter(a => a.active && a.bin && a.accountNo && (a.schoolId === '*' || a.schoolId === String(schoolId)))
    .map(a => Object.assign(a, {rank:rank(a), fits:a.purpose === 'ALL' || a.purpose === purpose}))
    .sort((a, b) => a.rank - b.rank || a.bank.localeCompare(b.bank));
}

/**
 * Tài khoản nhận tiền cho trường. accountId (tùy chọn) = tài khoản người dùng chọn; phải thuộc trường hoặc dùng chung.
 * Trả về {id, bin, bank, accountNo, accountName} hoặc null nếu chưa cấu hình.
 */
function resolveBankAccount_(schoolId, purpose, accountId) {
  const list = bankAccountsFor_(schoolId, purpose);
  if (accountId) {
    const a = list.find(x => x.id === String(accountId));
    if (!a) throw new Error('Tài khoản nhận tiền đã chọn không tồn tại, đã ngừng dùng hoặc không thuộc trường này.');
    return a;
  }
  const best = list.find(a => a.fits) || list[0];
  if (best) return best;
  const bin = getSetting_(schoolId, 'BANK_BIN'), acc = getSetting_(schoolId, 'BANK_ACCOUNT');
  if (!bin || !acc) return null;
  return {id:'', bin, bank:bankName_(bin, getSetting_(schoolId, 'BANK_NAME')), accountNo:acc, accountName:getSetting_(schoolId, 'BANK_ACCOUNT_NAME'), legacy:true};
}

function vietQrUrl_(acct, amount, content) {
  if (!acct || !acct.bin || !acct.accountNo) return '';
  const name = foldText_(acct.accountName).toUpperCase();
  return 'https://img.vietqr.io/image/' + encodeURIComponent(acct.bin) + '-' + encodeURIComponent(acct.accountNo) + '-compact2.png?amount=' +
    Math.round(amount) + '&addInfo=' + encodeURIComponent(content) + '&accountName=' + encodeURIComponent(name);
}

/** opts: {accountId, purpose: TUITION|SALE} */
function paymentInfoForStudent_(student, school, amount, period, opts) {
  opts = opts || {};
  const sid = String(student.SchoolId);
  const content = paymentContent_(student, period);
  const acct = resolveBankAccount_(sid, opts.purpose || 'TUITION', opts.accountId) || {};
  return {amount, content, bank:acct.bank || '', bankBin:acct.bin || '', account:acct.accountNo || '', accountName:acct.accountName || '',
    accountId:acct.id || '', qrUrl: vietQrUrl_(acct, amount, content)};
}

/** Danh sách tài khoản thu tiền (Cài đặt). params: {schoolId} (trống = tất cả trong phạm vi). */
function listBankAccounts(params) {
  const user = requireCap_('notify');
  params = params || {};
  migrateLegacyBankAccounts_(user);
  const schools = listSchoolsForUser_(user);
  const allowed = new Set(schools.map(s => String(s.SchoolId)));
  const smap = Object.fromEntries(readTable_('Schools').map(s => [String(s.SchoolId), s.SchoolName]));
  const rows = readTable_('BankAccounts').map(a => bankAccountView_(a, smap))
    .filter(a => (a.schoolId === '*' || allowed.has(a.schoolId)) && (!params.schoolId || a.schoolId === String(params.schoolId) || a.schoolId === '*'))
    .sort((a, b) => (a.schoolId === '*' ? '' : a.school).localeCompare(b.schoolId === '*' ? '' : b.school, 'vi') || Number(b.isDefault) - Number(a.isDefault));
  return {rows, banks:BANKS_.map(b => ({bin:b[0], name:b[1]})), purposes:Object.keys(BANK_PURPOSES_).map(k => ({code:k, label:BANK_PURPOSES_[k]})),
    canEdit:can_(user, 'manageSettings'), groupWide:isGroupWide_(user),
    schools:schools.map(s => ({SchoolId:s.SchoolId, SchoolName:s.SchoolName}))};
}

/** Lần đầu: chuyển tài khoản cũ (Settings BANK_*) sang sheet BankAccounts để quản lý chung. */
function migrateLegacyBankAccounts_(user) {
  if (readTable_('BankAccounts').length) return;
  const legacy = readTable_('Settings').filter(r => r.Key === 'BANK_ACCOUNT' && String(r.Value).trim());
  if (!legacy.length || !can_(user, 'manageSettings')) return;
  withWriteLock_(() => {
    if (readTable_('BankAccounts').length) return;
    const now = new Date();
    appendObjects_('BankAccounts', legacy.map(r => {
      const sid = String(r.SchoolId || '*');
      const val = k => { const x = readTable_('Settings').find(y => String(y.SchoolId || '*') === sid && y.Key === k); return x ? String(x.Value) : ''; };
      return {AccountId:nextId_('BAC'), SchoolId:sid, BankBin:asText_(val('BANK_BIN')), BankName:bankName_(val('BANK_BIN'), val('BANK_NAME')),
        AccountNo:asText_(String(r.Value).trim()), AccountName:val('BANK_ACCOUNT_NAME'), Purpose:'ALL', IsDefault:true, Active:true,
        Note:'Chuyển từ cấu hình cũ', CreatedAt:now, CreatedBy:user.email};
    }).filter(a => a.BankBin));
    audit_('MIGRATE','BankAccounts','',{count:legacy.length});
  });
}

/** payload: {AccountId?, SchoolId ('*' = dùng chung), BankBin, AccountNo, AccountName, Purpose, IsDefault, Active, Note} */
function saveBankAccount(payload) {
  const user = requireCap_('manageSettings');
  const schoolId = String(payload.SchoolId || '*');
  if (schoolId === '*') { if (!isGroupWide_(user)) throw new Error('Chỉ tài khoản cấp hệ thống mới tạo được tài khoản dùng chung mọi trường.'); }
  else assertSchoolAccess_(user, schoolId);
  const bin = String(payload.BankBin || '').trim();
  const accNo = String(payload.AccountNo || '').replace(/\s+/g, '');
  const name = foldText_(String(payload.AccountName || '').trim()).toUpperCase();
  const purpose = String(payload.Purpose || 'ALL').toUpperCase();
  if (!BANKS_.some(b => b[0] === bin)) throw new Error('Chọn ngân hàng.');
  if (!/^[0-9A-Za-z]{4,30}$/.test(accNo)) throw new Error('Số tài khoản không hợp lệ (chỉ gồm chữ số/chữ, 4–30 ký tự).');
  if (!name) throw new Error('Nhập tên chủ tài khoản.');
  if (!BANK_PURPOSES_[purpose]) throw new Error('Mục đích thu không hợp lệ.');
  const isDefault = truthy_(payload.IsDefault), active = payload.Active === undefined ? true : truthy_(payload.Active);
  return withWriteLock_(() => {
    const all = readTable_('BankAccounts');
    const id = String(payload.AccountId || '');
    const old = id ? all.find(a => String(a.AccountId) === id) : null;
    if (id && !old) throw new Error('Không tìm thấy tài khoản.');
    if (old) { const os = String(old.SchoolId || '*'); if (os === '*' ? !isGroupWide_(user) : !listSchoolsForUser_(user).some(s => String(s.SchoolId) === os)) throw new Error('Không có quyền sửa tài khoản này.'); }
    if (all.some(a => String(a.AccountId) !== id && String(a.SchoolId || '*') === schoolId && String(a.BankBin) === bin && String(a.AccountNo) === accNo))
      throw new Error('Tài khoản này đã được khai báo cho trường.');
    // Mỗi trường + mục đích chỉ có 1 tài khoản mặc định.
    if (isDefault && active) all.filter(a => String(a.AccountId) !== id && String(a.SchoolId || '*') === schoolId &&
        String(a.Purpose || 'ALL').toUpperCase() === purpose && truthy_(a.IsDefault))
      .forEach(a => updateObjectById_('BankAccounts', 'AccountId', a.AccountId, {IsDefault:false}));
    const rec = {SchoolId:schoolId, BankBin:asText_(bin), BankName:bankName_(bin), AccountNo:asText_(accNo), AccountName:name, Purpose:purpose,
      IsDefault:isDefault && active, Active:active, Note:String(payload.Note || '')};
    let newId = id;
    if (old) updateObjectById_('BankAccounts', 'AccountId', id, rec);
    else { newId = nextId_('BAC'); appendObject_('BankAccounts', Object.assign({AccountId:newId, CreatedAt:new Date(), CreatedBy:user.email}, rec)); }
    audit_(old ? 'UPDATE' : 'CREATE', 'BankAccounts', newId, {schoolId, bin, accNo, purpose, isDefault});
    return {ok:true, id:newId};
  });
}

function deleteBankAccount(id) {
  const user = requireCap_('manageSettings');
  return withWriteLock_(() => {
    const a = readTable_('BankAccounts').find(x => String(x.AccountId) === String(id));
    if (!a) throw new Error('Không tìm thấy tài khoản.');
    const sid = String(a.SchoolId || '*');
    if (sid === '*' ? !isGroupWide_(user) : !listSchoolsForUser_(user).some(s => String(s.SchoolId) === sid)) throw new Error('Không có quyền xóa tài khoản này.');
    deleteRowById_('BankAccounts', 'AccountId', String(id));
    audit_('DELETE', 'BankAccounts', String(id), {bin:a.BankBin, accNo:a.AccountNo});
    return {ok:true};
  });
}

/**
 * Danh sách hóa đơn cần thông báo. params: {schoolId, period, classId, level, onlyUnpaid(=true), type: TUITION|SALE|ALL}
 */
/**
 * Danh sách thông báo cần gửi. params: {schoolId, periods:[YYYY-MM...] (hoặc period), classId, level, onlyUnpaid(=true), type}
 * Gộp theo học sinh: mỗi học sinh một thông báo liệt kê đủ các tháng đã chọn.
 */
function previewNotifications(params) {
  const user = requireCap_('notify');
  params = params || {};
  if (!params.schoolId) throw new Error('Chọn trường.');
  assertSchoolAccess_(user, params.schoolId);
  const sc = scope_(user, params);
  const school = sc.schoolMap[String(params.schoolId)];
  const periods = new Set((Array.isArray(params.periods) ? params.periods : [params.period]).filter(Boolean).map(p => String(p).slice(0,7)));
  const sent = {};
  readTable_('Notifications').forEach(n => { if (n.Status === 'SENT') (sent[n.InvoiceId] = sent[n.InvoiceId] || []).push(n.Channel); });
  const onlyUnpaid = params.onlyUnpaid !== false;
  const type = String(params.type || 'TUITION').toUpperCase();
  const purpose = type === 'SALE' ? 'SALE' : 'TUITION';
  const groups = {};
  readTable_('Invoices').filter(i => invoiceLive_(i) && sc.studentMap[String(i.StudentId)] &&
      (!periods.size || periods.has(String(i.Period).slice(0,7))) &&
      (type === 'ALL' || String(i.InvoiceType || 'TUITION').toUpperCase() === type) &&
      (!onlyUnpaid || Number(i.Balance||0) > 0))
    .forEach(i => {
      const s = sc.studentMap[String(i.StudentId)], c = sc.classMap[String(s.ClassId)] || {};
      const g = groups[s.StudentId] || (groups[s.StudentId] = {invoiceIds:[], studentId:s.StudentId, code:String(s.StudentCode||''), name:s.FullName,
        className:c.ClassName||'', periods:[], net:0, balance:0, dueDate:'', parentName:s.ParentName||'', phone:normalizePhone_(s.ParentPhone),
        email:emailList_(s.ParentEmail).join(', '), _sent:null});
      g.invoiceIds.push(String(i.InvoiceId)); g.periods.push(String(i.Period).slice(0,7));
      g.net += Number(i.NetAmount||0); g.balance += Number(i.Balance||0);
      const due = String(i.DueDate||'').slice(0,10);
      if (due && (!g.dueDate || due < g.dueDate)) g.dueDate = due;
      // Kênh coi là "đã gửi" khi mọi hóa đơn trong nhóm đều đã gửi qua kênh đó.
      const ch = new Set(sent[i.InvoiceId] || []);
      g._sent = g._sent === null ? ch : new Set(Array.from(g._sent).filter(x => ch.has(x)));
    });
  const rows = Object.values(groups).map(g => {
    g.periods = Array.from(new Set(g.periods)).sort();
    g.periodLabel = g.periods.map(periodLabel_).join(', ');
    g.sentChannels = Array.from(g._sent || []); delete g._sent;
    g.invoiceId = g.invoiceIds[0];
    return g;
  }).sort((a,b) => (a.className + a.name).localeCompare(b.className + b.name, 'vi'));
  const settings = getNotificationSettings().channels;
  return {school:school ? school.SchoolName : '', rows:rows.slice(0, 2000), channels:settings,
    bankReady: !!resolveBankAccount_(params.schoolId, purpose),
    accounts: bankAccountsFor_(params.schoolId, purpose).map(a => ({id:a.id, label:a.bank + ' · ' + a.accountNo + ' · ' + a.accountName +
      (a.schoolId === '*' ? ' (dùng chung)' : '') + (a.fits ? '' : ' · ' + a.purposeLabel), fits:a.fits})),
    defaultAccountId: (resolveBankAccount_(params.schoolId, purpose) || {}).id || ''};
}

/** Nội dung thông báo cho 1 hóa đơn (dùng cả để xem trước trên giao diện). */
/** Nội dung thông báo cho một hoặc nhiều hóa đơn của CÙNG một học sinh (gộp nhiều tháng vào một thông báo). */
function buildNotice_(invoiceIds, accountId) {
  const ids = (Array.isArray(invoiceIds) ? invoiceIds : String(invoiceIds).split(',')).map(String).filter(Boolean);
  const all = readTable_('Invoices');
  const invs = ids.map(id => all.find(i => String(i.InvoiceId) === id)).filter(Boolean)
    .sort((a,b) => String(a.Period).localeCompare(String(b.Period)));
  if (!invs.length) throw new Error('Không tìm thấy hóa đơn ' + ids.join(', '));
  if (invs.some(i => String(i.StudentId) !== String(invs[0].StudentId))) throw new Error('Chỉ gộp được các hóa đơn của cùng một học sinh.');
  const first = invs[0];
  const s = readTable_('Students').find(x => String(x.StudentId) === String(first.StudentId)) || {};
  const school = readTable_('Schools').find(x => String(x.SchoolId) === String(first.SchoolId)) || {};
  const cls = readTable_('Classes').find(x => String(x.ClassId) === String(s.ClassId)) || {};
  const multi = invs.length > 1;
  const pmap = Object.fromEntries(invs.map(i => [String(i.InvoiceId), String(i.Period).slice(0,7)]));
  const lines = readTable_('InvoiceLines').filter(l => pmap[String(l.InvoiceId)])
    .sort((a,b) => pmap[a.InvoiceId].localeCompare(pmap[b.InvoiceId]))
    .map(l => multi ? Object.assign({}, l, {Description: l.Description + ' – ' + periodLabel_(pmap[l.InvoiceId])}) : l);
  const periods = Array.from(new Set(invs.map(i => String(i.Period).slice(0,7))));
  const sum = k => roundMoney_(invs.reduce((t,i) => t + Number(i[k] || 0), 0));
  const balance = sum('Balance');
  const amount = balance > 0 ? balance : sum('NetAmount');
  const dueRaw = invs.map(i => String(i.DueDate || '').slice(0,10)).filter(Boolean).sort()[0] || '';
  // Hóa đơn "gộp" dùng cho nội dung thông báo (InvoiceId chứa danh sách số hóa đơn).
  const inv = {InvoiceId: ids.join(','), SchoolId:first.SchoolId, StudentId:first.StudentId, NetAmount:sum('NetAmount'),
    PaidAmount:sum('PaidAmount'), Balance:balance, DueDate:dueRaw};
  const purpose = invs.every(i => String(i.InvoiceType).toUpperCase() === 'SALE') ? 'SALE' : 'TUITION';
  const pay = paymentInfoForStudent_(s, school, amount, periods, {accountId, purpose});
  const due = dueRaw ? Utilities.formatDate(new Date(dueRaw + 'T00:00:00'), APP.TZ, 'dd/MM/yyyy') : '';
  const periodText = periods.length === 1 ? 'tháng ' + periods[0].slice(5,7) + '/' + periods[0].slice(0,4)
    : 'tháng ' + periods.map(p => Number(p.slice(5,7))).join(', ') + (periods.every(p => p.slice(0,4) === periods[0].slice(0,4)) ? '/' + periods[0].slice(0,4) : '');
  const vars = {school:school.SchoolName||'', student:s.FullName||'', code:String(s.StudentCode||''), class:cls.ClassName||'',
    period:periodText, amount:fmtMoney_(amount), due:due || '—', bank:pay.bank||'', account:pay.account||'', content:pay.content,
    hotline:getSetting_(first.SchoolId,'HOTLINE')};
  return {inv, invoices:invs, student:s, school, cls, lines, period:periods[0], periods, amount, pay, due, vars};
}

/** Đường dẫn web app (cấu hình APP_URL trong Cài đặt, nếu trống lấy theo bản triển khai hiện tại). */
function appUrl_() {
  const v = getSetting_('*', 'APP_URL');
  if (v) return v;
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

function fillTemplate_(tpl, vars) { return String(tpl).replace(/\{(\w+)\}/g, (m,k) => vars[k] !== undefined ? vars[k] : m); }
function fmtMoney_(n) { return Math.round(Number(n||0)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function noticeEmailHtml_(n, qrCid) {
  const v = n.vars, i = n.inv;
  const rows = n.lines.map(l => '<tr><td style="padding:8px;border-bottom:1px solid #eef1f5">' + esc_(l.Description) +
    (l.DiscountNote ? '<div style="font-size:11px;color:#8a97a8">Áp dụng: ' + esc_(l.DiscountNote) + '</div>' : '') + '</td>' +
    '<td style="padding:8px;border-bottom:1px solid #eef1f5;text-align:right">' + esc_(l.Quantity) + '</td>' +
    '<td style="padding:8px;border-bottom:1px solid #eef1f5;text-align:right">' + fmtMoney_(l.UnitPrice) + '</td>' +
    '<td style="padding:8px;border-bottom:1px solid #eef1f5;text-align:right">' + (Number(l.DiscountAmount) ? '-' + fmtMoney_(l.DiscountAmount) : '') + '</td>' +
    '<td style="padding:8px;border-bottom:1px solid #eef1f5;text-align:right;font-weight:600">' + fmtMoney_(l.NetAmount) + '</td></tr>').join('');
  const qr = qrCid ? '<img src="cid:' + qrCid + '" width="220" alt="QR chuyển khoản" style="display:block;margin:0 auto">'
    : (n.pay.qrUrl ? '<img src="' + esc_(n.pay.qrUrl) + '" width="220" alt="QR chuyển khoản" style="display:block;margin:0 auto">' : '');
  return '<div style="font-family:Arial,sans-serif;background:#eef2f6;padding:24px;color:#2d3a4a">' +
    '<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">' +
    '<div style="background:#435467;color:#fff;padding:22px 26px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
    (logoUrl_() ? '<td style="padding-right:16px;vertical-align:middle"><img src="' + esc_(logoUrl_()) + '" width="64" height="64" alt="Viet School" style="display:block;background:#fff;border-radius:14px;padding:4px"></td>' : '') +
    '<td style="vertical-align:middle"><div style="font-size:13px;opacity:.8;color:#fff">' + esc_(v.school) + '</div>' +
    '<div style="font-size:22px;font-weight:700;margin-top:4px;color:#fff">Thông báo học phí ' + esc_(v.period) + '</div></td></tr></table></div>' +
    '<div style="padding:22px 26px">' +
    '<p>Kính gửi Quý phụ huynh <b>' + esc_(n.student.ParentName || '') + '</b>,</p>' +
    '<p>Nhà trường xin thông báo các khoản phí của học sinh <b>' + esc_(v.student) + '</b> (Mã HS: ' + esc_(v.code) + ', Lớp ' + esc_(v.class) + ') như sau:</p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr style="background:#f5f7fa;color:#6b7a8c;font-size:12px">' +
    '<th style="padding:8px;text-align:left">Khoản phí</th><th style="padding:8px;text-align:right">SL</th><th style="padding:8px;text-align:right">Đơn giá</th>' +
    '<th style="padding:8px;text-align:right">Miễn giảm</th><th style="padding:8px;text-align:right">Thành tiền</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<table style="width:100%;margin-top:14px;font-size:14px">' +
    '<tr><td>Tổng phải nộp</td><td style="text-align:right">' + fmtMoney_(i.NetAmount) + ' đ</td></tr>' +
    (Number(i.PaidAmount) ? '<tr><td>Đã nộp</td><td style="text-align:right">' + fmtMoney_(i.PaidAmount) + ' đ</td></tr>' : '') +
    '<tr><td style="font-weight:700;font-size:16px">Số tiền cần thanh toán</td><td style="text-align:right;font-weight:700;font-size:18px;color:#e5566c">' + v.amount + ' đ</td></tr>' +
    (n.due ? '<tr><td>Hạn nộp</td><td style="text-align:right;font-weight:600">' + esc_(n.due) + '</td></tr>' : '') + '</table>' +
    (n.pay.account ? '<div style="margin-top:20px;padding:18px;border:1px dashed #f3c46b;border-radius:12px;background:#fffaf0;text-align:center">' +
      '<div style="font-weight:700;margin-bottom:10px">Quét mã QR bằng ứng dụng ngân hàng để thanh toán</div>' + qr +
      '<div style="margin-top:10px;font-size:13px;line-height:1.7">Ngân hàng: <b>' + esc_(n.pay.bank) + '</b><br>Số tài khoản: <b>' + esc_(n.pay.account) +
      '</b><br>Chủ tài khoản: <b>' + esc_(n.pay.accountName) + '</b><br>Nội dung: <b style="color:#e5566c">' + esc_(n.pay.content) + '</b></div></div>' : '') +
    '<p style="font-size:12px;color:#8a97a8;margin-top:20px">Vui lòng giữ nguyên nội dung chuyển khoản để nhà trường đối soát tự động.' +
    (v.hotline ? ' Mọi thắc mắc xin liên hệ ' + esc_(v.hotline) + '.' : '') + ' Nếu Quý phụ huynh đã thanh toán, xin bỏ qua thông báo này.</p>' +
    (appUrl_() ? '<p style="font-size:13px;margin-top:10px"><a href="' + esc_(appUrl_()) + '" style="color:#435467;font-weight:700">Xem chi tiết học phí, đăng ký suất ăn &amp; mua đồ dùng</a> — đăng nhập bằng mã học sinh <b>' + esc_(v.code) + '</b>.</p>' : '') +
    '</div></div></div>';
}

/** Xem trước nội dung 1 thông báo (email HTML + SMS + dữ liệu ZNS). */
/** arg: [invoiceId...] | "id,id" | {invoiceIds, accountId} */
function previewNotice(arg) {
  const user = requireCap_('notify');
  const o = arg && !Array.isArray(arg) && typeof arg === 'object' ? arg : {invoiceIds:arg};
  const n = buildNotice_(o.invoiceIds, o.accountId || '');
  assertSchoolAccess_(user, n.inv.SchoolId);
  return {html: noticeEmailHtml_(n, null), sms: smsText_(n), zns: znsData_(n), pay: n.pay,
    subject: fillTemplate_(getSetting_(n.inv.SchoolId,'EMAIL_SUBJECT') || DEFAULT_EMAIL_SUBJECT_, n.vars)};
}

function smsText_(n) {
  const tpl = getSetting_(n.inv.SchoolId, 'SMS_TEMPLATE') || DEFAULT_SMS_TEMPLATE_;
  const vars = {};
  Object.keys(n.vars).forEach(k => vars[k] = foldText_(n.vars[k]).replace(/\b\w/g, c => c.toUpperCase()));
  vars.amount = n.vars.amount; vars.content = n.pay.content; vars.account = n.pay.account; vars.code = n.vars.code;
  return fillTemplate_(tpl, vars).slice(0, 459);
}

/** Tham số gửi sang mẫu ZNS. Khi đăng ký mẫu trên Zalo, đặt đúng tên các tham số này. */
function znsData_(n) {
  return {student_name:n.vars.student, student_code:n.vars.code, class_name:n.vars.class, school_name:n.vars.school,
    period:n.vars.period, amount:String(Math.round(n.amount)), due_date:n.due || '', payment_content:n.pay.content,
    bank_account:n.pay.account || '', invoice_id:String(n.invoices[0].InvoiceId) + (n.invoices.length > 1 ? ' (+' + (n.invoices.length - 1) + ')' : '')};
}

function normalizePhone_(p) {
  let s = String(p || '').replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) s = '84' + s.slice(1);
  return /^84\d{9,10}$/.test(s) ? s : '';
}

/**
 * Gửi thông báo. payload: {invoiceIds:[...], channels:['EMAIL','ZALO','SMS'], skipSent:true}
 * Gửi tối đa ~4,5 phút mỗi lần gọi; phần còn lại trả về trong `remaining` để giao diện gọi tiếp.
 */
/**
 * Gửi thông báo. payload: {groups:[[invoiceId...], ...] (mỗi nhóm = 1 học sinh, 1 thông báo) hoặc invoiceIds:[...],
 *   channels:['EMAIL','ZALO','SMS'], skipSent:true}
 * Mỗi hóa đơn trong nhóm được ghi một dòng nhật ký để lịch sử theo hóa đơn vẫn đầy đủ.
 * Gửi tối đa ~4,5 phút mỗi lần gọi; phần còn lại trả về trong `remaining` để giao diện gọi tiếp.
 */
function sendNotifications(payload) {
  const user = requireCap_('notify');
  const groups = (Array.isArray(payload.groups) && payload.groups.length ? payload.groups : (payload.invoiceIds || []).map(id => [id]))
    .map(g => (Array.isArray(g) ? g : [g]).map(String).filter(Boolean)).filter(g => g.length);
  const channels = (payload.channels || []).map(c => String(c).toUpperCase()).filter(c => ['EMAIL','ZALO','SMS'].includes(c));
  if (!groups.length || !channels.length) throw new Error('Chọn hóa đơn và kênh gửi.');
  const started = Date.now();
  const sentBefore = new Set(readTable_('Notifications').filter(n => n.Status === 'SENT').map(n => n.InvoiceId + '|' + n.Channel));
  const logs = [], summary = {sent:0, failed:0, skipped:0}, errors = [];
  let idx = 0;
  for (; idx < groups.length; idx++) {
    if (Date.now() - started > 270000) break;
    let n;
    try { n = buildNotice_(groups[idx], String(payload.accountId || '')); assertSchoolAccess_(user, n.inv.SchoolId); }
    catch (e) { summary.failed++; errors.push({invoiceId:groups[idx].join(','), channel:'-', error:String(e.message || e)}); continue; }
    channels.forEach(ch => {
      if (payload.skipSent !== false && n.invoices.every(i => sentBefore.has(i.InvoiceId + '|' + ch))) { summary.skipped++; return; }
      const log = {SchoolId:n.inv.SchoolId, StudentId:n.inv.StudentId, Channel:ch, Recipient:'', Subject:'', Message:'',
        Status:'', Error:'', SentAt:new Date(), CreatedBy:user.email};
      try {
        if (ch === 'EMAIL') sendEmail_(n, log);
        else if (ch === 'ZALO') sendZns_(n, log);
        else sendSms_(n, log);
        log.Status = 'SENT'; summary.sent++;
      } catch (e) {
        log.Status = 'FAILED'; log.Error = String(e && e.message || e).slice(0, 500); summary.failed++;
        errors.push({invoiceId:n.inv.InvoiceId, channel:ch, error:log.Error});
      }
      log.Recipient = asText_(String(log.Recipient));
      n.invoices.forEach(i => logs.push(Object.assign({}, log, {NotificationId:nextId_('NTF'), InvoiceId:i.InvoiceId})));
    });
  }
  withWriteLock_(() => {
    appendObjects_('Notifications', logs);
    audit_('SEND_NOTIFICATIONS','Notifications','',{groups:idx, channels, sent:summary.sent, failed:summary.failed});
  });
  return Object.assign(summary, {processed: idx, remaining: groups.slice(idx), errors: errors.slice(0, 30)});
}

function sendEmail_(n, log) {
  const to = emailList_(n.student.ParentEmail).join(',');
  log.Recipient = to;
  if (!to) throw new Error('Học sinh chưa có email phụ huynh.');
  const subject = fillTemplate_(getSetting_(n.inv.SchoolId,'EMAIL_SUBJECT') || DEFAULT_EMAIL_SUBJECT_, n.vars);
  log.Subject = subject;
  let inline = null;
  if (n.pay.qrUrl) {
    try { inline = {qr: UrlFetchApp.fetch(n.pay.qrUrl, {muteHttpExceptions:true}).getBlob().setName('qr.png')}; } catch (e) { inline = null; }
  }
  MailApp.sendEmail({to, subject, name:n.vars.school || APP.NAME, htmlBody: noticeEmailHtml_(n, inline ? 'qr' : null),
    inlineImages: inline || undefined});
  log.Message = 'Email ' + n.vars.amount + 'đ';
}

function sendSms_(n, log) {
  const phone = normalizePhone_(n.student.ParentPhone);
  log.Recipient = phone;
  const content = smsText_(n);
  log.Message = content;
  smsSendRaw_(phone, content);
}

/** Gửi 1 tin SMS qua eSMS (phone dạng 84xxxxxxxxx, nội dung không dấu). */
function smsSendRaw_(phone, content) {
  const props = PropertiesService.getScriptProperties();
  if (!phone) throw new Error('Số điện thoại phụ huynh không hợp lệ.');
  const key = props.getProperty('SMS_API_KEY'), secret = props.getProperty('SMS_SECRET_KEY');
  if (!key || !secret) throw new Error('Chưa cấu hình SMS (eSMS).');
  const res = UrlFetchApp.fetch('https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/', {
    method:'post', contentType:'application/json', muteHttpExceptions:true,
    payload: JSON.stringify({ApiKey:key, SecretKey:secret, Content:content, Phone:'0' + phone.slice(2),
      Brandname:props.getProperty('SMS_BRANDNAME') || '', SmsType:'2', IsUnicode:'0'})
  });
  const body = JSON.parse(res.getContentText() || '{}');
  if (String(body.CodeResult) !== '100') throw new Error('eSMS lỗi ' + (body.CodeResult || res.getResponseCode()) + ': ' + (body.ErrorMessage || res.getContentText().slice(0,200)));
}

function sendZns_(n, log) {
  const phone = normalizePhone_(n.student.ParentPhone);
  log.Recipient = phone;
  const templateId = getSetting_(n.inv.SchoolId, 'ZNS_TEMPLATE_ID');
  if (!templateId) throw new Error('Chưa cấu hình ZNS_TEMPLATE_ID.');
  const data = znsData_(n);
  log.Message = 'ZNS ' + templateId + ' ' + data.amount;
  znsSendRaw_(phone, templateId, data, String(n.invoices[0].InvoiceId));
}

/** Gửi 1 tin Zalo ZNS theo mẫu đã duyệt. */
function znsSendRaw_(phone, templateId, data, trackingId) {
  if (!phone) throw new Error('Số điện thoại phụ huynh không hợp lệ.');
  if (!templateId) throw new Error('Chưa cấu hình mã mẫu ZNS.');
  const res = UrlFetchApp.fetch('https://business.openapi.zalo.me/message/template', {
    method:'post', contentType:'application/json', muteHttpExceptions:true,
    headers:{access_token: zaloAccessToken_()},
    payload: JSON.stringify({phone, template_id:templateId, template_data:data, tracking_id:String(trackingId || '')})
  });
  const body = JSON.parse(res.getContentText() || '{}');
  if (Number(body.error) !== 0) throw new Error('Zalo ZNS lỗi ' + body.error + ': ' + (body.message || ''));
}

/** Lấy access token Zalo OA, tự làm mới bằng refresh token (refresh token chỉ dùng được 1 lần nên lưu lại token mới). */
function zaloAccessToken_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('ZALO_ACCESS_TOKEN');
  const exp = Number(props.getProperty('ZALO_TOKEN_EXPIRES') || 0);
  if (token && exp > Date.now() + 120000) return token;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t2 = props.getProperty('ZALO_ACCESS_TOKEN'), e2 = Number(props.getProperty('ZALO_TOKEN_EXPIRES') || 0);
    if (t2 && e2 > Date.now() + 120000) return t2;
    const appId = props.getProperty('ZALO_APP_ID'), secret = props.getProperty('ZALO_APP_SECRET'), refresh = props.getProperty('ZALO_REFRESH_TOKEN');
    if (!appId || !secret || !refresh) throw new Error('Chưa cấu hình Zalo OA (App ID, Secret, Refresh token).');
    const res = UrlFetchApp.fetch('https://oauth.zaloapp.com/v4/oa/access_token', {
      method:'post', muteHttpExceptions:true, headers:{secret_key: secret},
      payload:{refresh_token:refresh, app_id:appId, grant_type:'refresh_token'}
    });
    const body = JSON.parse(res.getContentText() || '{}');
    if (!body.access_token) throw new Error('Không làm mới được token Zalo: ' + (body.error_description || body.error_name || res.getContentText().slice(0,200)));
    props.setProperties({ZALO_ACCESS_TOKEN: body.access_token, ZALO_REFRESH_TOKEN: body.refresh_token || refresh,
      ZALO_TOKEN_EXPIRES: String(Date.now() + Number(body.expires_in || 3600) * 1000)});
    return body.access_token;
  } finally { lock.releaseLock(); }
}
