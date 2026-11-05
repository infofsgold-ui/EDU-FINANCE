function onOpen() {
  SpreadsheetApp.getUi().createMenu('EDU FINANCE')
    .addItem('Khởi tạo/kiểm tra cấu trúc dữ liệu', 'setupDatabase')
    .addItem('Tạo dữ liệu mẫu (chỉ khi chưa có trường nào)', 'seedDemoData')
    .addToUi();
}

/**
 * Chạy thủ công một lần từ Apps Script Editor sau khi gắn project với Google Sheet.
 * Nếu chạy standalone, hãy đặt Script Property EDU_FINANCE_SPREADSHEET_ID trước.
 * Chạy lại an toàn khi nâng cấp phiên bản: tạo sheet mới và bổ sung cột mới ở cuối.
 */
function setupDatabase() {
  if (!isScriptOwner_()) throw new Error('Chỉ chủ sở hữu script được chạy hàm này (từ Apps Script Editor).');
  const ss = getDatabase_();
  Object.keys(APP.HEADERS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = APP.HEADERS[name];
    const existing = sh.getLastRow() ? sh.getRange(1,1,1,Math.max(sh.getLastColumn(), headers.length)).getValues()[0] : [];
    const needsHeader = headers.some((h,i) => existing[i] !== h);
    if (needsHeader) {
      // Cho phép nâng cấp phiên bản: chỉ bổ sung cột mới ở cuối nếu các cột cũ giữ nguyên thứ tự.
      const firstMismatch = headers.findIndex((h,i) => existing[i] !== h);
      const onlyTrailingAdded = existing.slice(firstMismatch).every(v => v === '' || v === null);
      if (sh.getLastRow() > 1 && !onlyTrailingAdded) throw new Error('Không thể tự sửa header của sheet ' + name + ' vì đã có dữ liệu. Hãy kiểm tra thủ công.');
      sh.getRange(1,1,1,headers.length).setValues([headers]);
    }
    sh.setFrozenRows(1);
    sh.getRange(1,1,1,headers.length)
      .setBackground('#435467').setFontColor('#FFFFFF').setFontWeight('bold')
      .setWrap(true);
    sh.autoResizeColumns(1, headers.length);
  });
  const users = ss.getSheetByName('Users');
  if (users.getLastRow() === 1) {
    users.appendRow(['admin@example.com','Replace With Admin Name','GROUP_ADMIN','*',true]);
  }
  const note = 'Đã khởi tạo cấu trúc EDU FINANCE ' + APP.VERSION + ' trong: ' + ss.getName() +
    '\nHãy sửa admin@example.com trong sheet Users thành email quản trị thật trước khi triển khai.';
  // getUi() chỉ dùng được khi script gắn với Sheet và chạy từ giao diện; chạy từ editor standalone thì ghi log.
  try { SpreadsheetApp.getUi().alert(note); } catch (e) { Logger.log(note); }
}

let DB_ = null;
function getDatabase_() {
  if (DB_) return DB_;
  DB_ = openDatabase_();
  return DB_;
}
function openDatabase_() {
  const id = PropertiesService.getScriptProperties().getProperty(APP.SPREADSHEET_PROPERTY) || APP.DEFAULT_SPREADSHEET_ID;
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('Chưa cấu hình database. Đặt Script Property ' + APP.SPREADSHEET_PROPERTY + ' bằng ID Google Sheets.');
}

/**
 * Tạo dữ liệu mẫu để thử dashboard: 3 trường (mầm non, tiểu học, liên cấp THCS-THPT), lớp, học sinh,
 * khoản phí, bảng giá, kho, hàng hóa, hóa đơn 4 tháng gần nhất, thu tiền, bán hàng, chi phí.
 * Chỉ chạy khi sheet Schools còn trống. Người chạy được thêm làm GROUP_ADMIN nếu chưa có trong Users.
 */
function seedDemoData() {
  if (!isScriptOwner_()) throw new Error('Chỉ chủ sở hữu script được chạy hàm này (từ Apps Script Editor).');
  setupDatabase();
  if (readTable_('Schools').length) throw new Error('Đã có dữ liệu trường học — không tạo dữ liệu mẫu để tránh lẫn với dữ liệu thật.');
  const email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) throw new Error('Không xác định được email người chạy.');
  if (!readTable_('Users').some(u => String(u.UserEmail).toLowerCase() === email)) {
    appendObject_('Users', {UserEmail:email, FullName:'Quản trị hệ thống', Role:'GROUP_ADMIN', SchoolId:'*', Active:true, CreatedAt:new Date()});
  }
  CURRENT_USER_ = null;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const ho = ['Nguyễn','Trần','Lê','Phạm','Hoàng','Huỳnh','Phan','Vũ','Võ','Đặng','Bùi','Đỗ','Hồ','Ngô','Dương'];
  const dem = ['Văn','Thị','Minh','Gia','Ngọc','Quốc','Thanh','Bảo','Khánh','Hoài','Anh','Đức'];
  const ten = ['An','Bình','Châu','Dũng','Giang','Hà','Huy','Khoa','Linh','Mai','Nam','Ngân','Phúc','Quân','Sơn','Tâm','Thảo','Trang','Uyên','Vy','Yến','Khôi','Nhi','Long'];

  const schools = [
    {name:'Trường Mầm non Hoa Sen', level:'MAM_NON', grades:['Nhà trẻ','Mầm','Chồi','Lá'], tuition:2800000},
    {name:'Trường Tiểu học Ánh Dương', level:'TIEU_HOC', grades:['1','2','3','4','5'], tuition:3500000},
    {name:'Trường THCS - THPT Tương Lai', level:'LIEN_CAP', grades:['6','7','8','9','10','11','12'], tuition:4800000}
  ];
  const fees = [['HOCPHI','Học phí','Học phí','FIXED','tháng'],['BANTRU','Tiền ăn bán trú','Dịch vụ','PER_DAY','ngày'],
    ['XEBUS','Xe đưa đón','Dịch vụ','QUANTITY','tháng'],['CSVC','Cơ sở vật chất','Học phí','FIXED','tháng']];
  fees.forEach(f => saveFeeType({FeeTypeId:f[0], FeeName:f[1], Category:f[2], CalculationMethod:f[3], Unit:f[4]}));
  const central = saveWarehouse({WarehouseName:'Kho tổng', WarehouseType:'CENTRAL'}).id;
  const polSibling = savePolicy({PolicyType:'SIBLING', Name:'Giảm 10% học phí cho con thứ 2 trở đi', SchoolId:'*', Method:'PERCENT', Value:10, FeeTypeIds:['HOCPHI'], MinChildOrder:2, Stackable:true, Description:'Mẫu – theo tờ trình số 01/TTr'}).id;
  const polYear = savePolicy({PolicyType:'PREPAY_YEAR', Name:'Giảm 5% khi đóng học phí cả năm', SchoolId:'*', Method:'PERCENT', Value:5, FeeTypeIds:['HOCPHI'], Stackable:true}).id;
  const polStaff = savePolicy({PolicyType:'STAFF_CHILD', Name:'Hỗ trợ 50% học phí con CB-GV-NV', SchoolId:'*', Method:'PERCENT', Value:50, FeeTypeIds:['HOCPHI'], Stackable:false}).id;
  const products = [['DP-AO-S','Áo đồng phục','Đồng phục','S',120000],['DP-AO-M','Áo đồng phục','Đồng phục','M',130000],
    ['DP-QUAN-M','Quần đồng phục','Đồng phục','M',150000],['DP-TD','Bộ thể dục','Đồng phục','M',180000],
    ['SGK-1','Bộ SGK lớp 1','Sách giáo khoa','',250000],['SGK-6','Bộ SGK lớp 6','Sách giáo khoa','',320000],
    ['VO-200','Vở 200 trang','Vở / Văn phòng phẩm','',15000],['BALO','Balo học sinh','Phụ kiện','',290000]]
    .map(p => saveProduct({SKU:p[0], ProductName:p[1], Category:p[2], Size:p[3], Unit:'cái', SalePrice:p[4], ReorderLevel:20}).id);
  const year = Number(Utilities.formatDate(new Date(), APP.TZ, 'yyyy'));
  const month = Number(Utilities.formatDate(new Date(), APP.TZ, 'M'));
  const periods = [];
  for (let k = 3; k >= 0; k--) { const d = new Date(year, month - 1 - k, 1); periods.push(Utilities.formatDate(d, APP.TZ, 'yyyy-MM')); }

  schools.forEach((sc, si) => {
    const sid = saveSchool({SchoolName:sc.name, Level:sc.level, Address:(si+1)*12 + ' Nguyễn Văn Linh, TP. Hồ Chí Minh'}).id;
    saveFeeRate({SchoolId:sid, FeeTypeId:'HOCPHI', UnitPrice:sc.tuition, ValidFrom:periods[0]});
    saveFeeRate({SchoolId:sid, FeeTypeId:'BANTRU', UnitPrice:35000, ValidFrom:periods[0]});
    saveFeeRate({SchoolId:sid, FeeTypeId:'CSVC', UnitPrice:200000, ValidFrom:periods[0]});
    if (sc.level === 'LIEN_CAP') ['10','11','12'].forEach(g => saveFeeRate({SchoolId:sid, FeeTypeId:'HOCPHI', Grade:g, UnitPrice:5600000, ValidFrom:periods[0]}));
    const wh = saveWarehouse({WarehouseName:'Kho ' + sc.name.replace('Trường ',''), SchoolId:sid, WarehouseType:'SCHOOL'}).id;
    products.forEach((pid, i) => recordStockMovement({WarehouseId:central, ProductId:pid, MovementType:'IN', Quantity:300, UnitCost:[80000,85000,95000,120000,180000,230000,9000,190000][i], MovementDate:periods[0] + '-02', Reference:'PN-' + (si+1)}));
    products.forEach((pid, i) => recordStockMovement({WarehouseId:central, ToWarehouseId:wh, ProductId:pid, MovementType:'TRANSFER', Quantity:i === 6 ? 150 : i % 3 === 0 ? 25 : 60, MovementDate:periods[0] + '-05'}));
    const studentIds = [];
    sc.grades.forEach(g => ['A','B'].forEach(suf => {
      const cname = (isNaN(Number(g)) ? g + ' ' : g) + suf;
      const cid = saveClass({SchoolId:sid, ClassName:cname, Grade:g, SchoolYear:(month >= 8 ? year : year - 1) + '-' + (month >= 8 ? year + 1 : year), HomeroomTeacher:'GV ' + pick(ho) + ' ' + pick(ten), Capacity:35}).id;
      const n = 4 + Math.floor(rnd() * 4);
      for (let k = 0; k < n; k++) {
        const last = pick(ho);
        const id = saveStudent({SchoolId:sid, ClassId:cid, FullName:last + ' ' + pick(dem) + ' ' + pick(ten),
          StudentCode:['MN','TH','LC'][si] + String(studentIds.length + 1001), Gender:pick(['Nam','Nữ']),
          DOB:(year - 4 - si * 4 - Math.floor(rnd()*5)) + '-0' + (1 + Math.floor(rnd()*9)) + '-1' + Math.floor(rnd()*9),
          EnrollmentDate:(year - Math.floor(rnd()*3)) + '-08-15', ParentName:pick(ho) + ' ' + pick(dem) + ' ' + pick(ten),
          ParentPhone:'09' + String(10000000 + Math.floor(rnd()*89999999)), Address:'Quận ' + (1 + Math.floor(rnd()*12)) + ', TP. HCM'}).id;
        studentIds.push(id);
      }
    }));
    addPolicyMembers({DiscountId:polYear, StudentIds:studentIds.slice(0, 5), Note:'Đã đóng cả năm (mẫu)'});
    addPolicyMembers({DiscountId:polStaff, StudentIds:studentIds.slice(5, 7), Note:'Con giáo viên (mẫu)'});
    // Tạo vài cặp anh chị em: học sinh sau dùng chung SĐT phụ huynh với học sinh trước.
    const stuRows = readTable_('Students');
    [[10, 11], [20, 21]].forEach(([a, b]) => {
      const A = stuRows.find(x => x.StudentId === studentIds[a]), B = studentIds[b];
      if (A && B) updateStudent({StudentId:B, ParentPhone:A.ParentPhone, ParentName:A.ParentName});
    });
    periods.forEach((p, pi) => {
      postInvoices({schoolId:sid, period:p, dueDate:p + '-10', defaultDays:20, confirm:true});
      // Ghi thu tiền hàng loạt rồi phân bổ một lần (nhanh hơn gọi recordPayment cho từng học sinh).
      const invs = readTable_('Invoices').filter(i => String(i.SchoolId) === sid && String(i.Period).slice(0,7) === p && String(i.InvoiceType) === 'TUITION');
      const pays = [];
      invs.forEach(inv => {
        const r = rnd();
        if (pi === periods.length - 1 && r < 0.45) return;          // kỳ hiện tại: nhiều HS chưa nộp
        if (r < 0.12) return;                                       // một số HS nợ kéo dài
        const amt = r < 0.2 ? Math.round(Number(inv.NetAmount) / 2 / 1000) * 1000 : Number(inv.NetAmount);
        pays.push({PaymentId:nextId_('PAY'), SchoolId:sid, StudentId:String(inv.StudentId), PaymentDate:p + '-0' + (3 + Math.floor(rnd()*6)),
          Amount:amt, Method:pick(['BANK_TRANSFER','BANK_TRANSFER','CASH','QR']), Reference:'', Notes:'Dữ liệu mẫu', Status:'RECORDED',
          CreatedAt:new Date(), CreatedBy:email});
      });
      withWriteLock_(() => { appendObjects_('Payments', pays); allocateForStudents_(sid, studentIds, currentUser_()); });
      ['Lương & phụ cấp','Điện nước','Ăn bán trú','Cơ sở vật chất','Văn phòng phẩm'].forEach((cat, ci) => recordExpense({SchoolId:sid, ExpenseDate:p + '-2' + ci,
        Category:cat, Amount:Math.round(studentIds.length * [1100000, 120000, 450000, 200000, 30000][ci] * (0.85 + rnd()*0.3) / 1000) * 1000,
        Vendor:['Nhân sự','EVN / Sawaco','Công ty suất ăn','Nhà thầu','Văn phòng phẩm Hồng Hà'][ci], Description:cat + ' tháng ' + p}));
    });
    studentIds.slice(0, 8).forEach((stu, k) => createSale({SchoolId:sid, StudentId:stu, WarehouseId:wh, payNow:k % 3 !== 0, Method:'CASH',
      items:[{ProductId:products[k % 4], Quantity:2, UnitPrice:[120000,130000,150000,180000][k % 4]}, {ProductId:products[6], Quantity:10, UnitPrice:15000}]}));
  });
  saveNotificationSettings({SchoolId:'*', values:{BANK_BIN:'970436', BANK_ACCOUNT:'0123456789', BANK_ACCOUNT_NAME:'TRUONG HOC MAU', HOTLINE:'1900 0000'}});
  const note = 'Đã tạo dữ liệu mẫu. Tài khoản ngân hàng mẫu (0123456789) chỉ để thử — hãy thay bằng tài khoản thật trong Cài đặt.';
  try { SpreadsheetApp.getUi().alert(note); } catch (e) { Logger.log(note); }
}
