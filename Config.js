const APP = {
  NAME: 'EDU FINANCE',
  VERSION: '3.8.0',
  SPREADSHEET_PROPERTY: 'EDU_FINANCE_SPREADSHEET_ID',
  DEFAULT_SPREADSHEET_ID: '18zfc6AOqpQIqM7t38uMM2RPtK9BJA-Fty_G3CdmdTuw',
  TZ: 'Asia/Ho_Chi_Minh',
  // ===== THƯ MỤC GOOGLE DRIVE =====
  // Có thể ghi đè bằng Script Property cùng tên (VD: DOCUMENTS_FOLDER_ID) mà không cần sửa code.
  DRIVE: {
    // Hồ sơ / file lưu trữ: tờ trình chính sách giá (thư mục con "Tờ trình chính sách"), báo cáo xuất Google Sheets ("Báo cáo")
    DOCUMENTS_FOLDER_ID: '1YRxLHJo1bV1um6FJo8AqhYGu0NlAJUUv',
    // Ảnh hàng hóa (đồng phục, sách vở, phụ kiện) — hiển thị ở Kho hàng và cửa hàng trên Trang phụ huynh
    PRODUCT_IMAGES_FOLDER_ID: '1eh688FzXeOQ2kE68wY5jvfLdlkQASVom'
  },
  MAX_UPLOAD_MB: 10,        // Tờ trình / hồ sơ
  MAX_IMAGE_MB: 5,          // Ảnh hàng hóa
  // Cột mới luôn được thêm ở CUỐI để setupDatabase nâng cấp được sheet đã có dữ liệu.
  HEADERS: {
    Users: ['UserEmail','FullName','Role','SchoolId','Active','Phone','CreatedAt','SchoolIds'],
    Schools: ['SchoolId','SchoolName','Level','Address','Active','CreatedAt','CreatedBy'],
    Classes: ['ClassId','SchoolId','SchoolYear','Grade','ClassName','HomeroomTeacher','Capacity','Active','CreatedAt','CreatedBy','TeacherEmails'],
    Students: ['StudentId','SchoolId','ClassId','StudentCode','FullName','DOB','EnrollmentDate','Status','ParentName','ParentPhone','Notes','CreatedAt','CreatedBy','Gender','Address','ParentEmail','LeaveDate'],
    FeeTypes: ['FeeTypeId','FeeName','Category','CalculationMethod','Unit','Active','Description'],
    FeeRates: ['RateId','SchoolId','Level','Grade','FeeTypeId','UnitPrice','Frequency','ValidFrom','ValidTo','Active','CreatedAt','CreatedBy'],
    Discounts: ['DiscountId','SchoolId','Name','Method','Value','FeeTypeId','ValidFrom','ValidTo','ApprovalRequired','Active','StudentId','ClassId','ApprovedBy',
      'PolicyType','Level','Grade','MaxAmount','Stackable','MinChildOrder','Description','CreatedAt','CreatedBy','ApprovedAt','SiblingScope'],
    PolicyMembers: ['MemberId','DiscountId','StudentId','SchoolId','Note','ValidFrom','ValidTo','Active','CreatedAt','CreatedBy'],
    Attachments: ['AttachmentId','Entity','EntityId','FileId','FileName','Url','MimeType','Size','UploadedAt','UploadedBy'],
    Invoices: ['InvoiceId','SchoolId','StudentId','Period','IssueDate','DueDate','GrossAmount','DiscountAmount','NetAmount','PaidAmount','Balance','Status','CreatedAt','CreatedBy','InvoiceType','Notes'],
    InvoiceLines: ['LineId','InvoiceId','StudentId','FeeTypeId','Description','Quantity','UnitPrice','GrossAmount','DiscountAmount','NetAmount','ProductId','WarehouseId','DiscountNote'],
    Payments: ['PaymentId','SchoolId','StudentId','PaymentDate','Amount','Method','Reference','Notes','Status','CreatedAt','CreatedBy'],
    Allocations: ['AllocationId','PaymentId','InvoiceId','Amount','CreatedAt','CreatedBy'],
    Products: ['ProductId','SKU','ProductName','Category','Unit','Size','ReorderLevel','Active','SalePrice','ImageFileId','ImageUrl'],
    Warehouses: ['WarehouseId','SchoolId','WarehouseName','WarehouseType','Active'],
    StockMovements: ['MovementId','WarehouseId','ProductId','MovementDate','MovementType','Quantity','UnitCost','Reference','Notes','Status','CreatedAt','CreatedBy','TransferId','ReceiptId','Vendor'],
    Expenses: ['ExpenseId','SchoolId','ExpenseDate','Category','Vendor','Description','Amount','BudgetPeriod','Status','ApprovedBy','CreatedAt','CreatedBy','Level','Grade','ClassId'],
    Notifications: ['NotificationId','SchoolId','StudentId','InvoiceId','Channel','Recipient','Subject','Message','Status','Error','SentAt','CreatedBy'],
    Settings: ['SchoolId','Key','Value','UpdatedAt','UpdatedBy'],
    Credentials: ['Username','Type','StudentId','UserEmail','PasswordHash','Salt','MustChange','Active','FailedCount','LockedUntil','LastLogin','CreatedAt','UpdatedAt','StudentIds'],
    Orders: ['OrderId','SchoolId','StudentId','Status','Total','Note','InvoiceId','CreatedAt','CreatedBy','ProcessedAt','ProcessedBy','Reason'],
    OrderLines: ['OrderLineId','OrderId','ProductId','Description','Quantity','UnitPrice','Amount'],
    BankAccounts: ['AccountId','SchoolId','BankBin','BankName','AccountNo','AccountName','Purpose','IsDefault','Active','Note','CreatedAt','CreatedBy'],
    AlertReads: ['UserKey','Data','UpdatedAt'],
    SchoolBanners: ['SchoolId','Eyebrow','Title','TitleAccent','Description','ImageFileId','ImageUrl','CtaLabel','CtaLink','VideoLabel','VideoUrl','Stats','Tagline','Active','UpdatedAt','UpdatedBy'],
    ChatMessages: ['MessageId','ThreadId','FromUser','FromName','ToUser','Body','SentAt','ReadAt'],
    MealAbsences: ['AbsenceId','SchoolId','StudentId','AbsenceDate','Reason','OnTime','Status','ReportedAt','ReportedBy','ConfirmedAt','ConfirmedBy','Note'],
    MealMonths: ['MonthId','SchoolId','Period','FeeTypeId','PlannedDays','Status','ClosedAt','ClosedBy','Notes','CreatedAt','CreatedBy'],
    MealRecords: ['RecordId','SchoolId','Period','StudentId','Registered','PlannedDays','ReportedAbsent','UnreportedAbsent','RefundDays',
      'UnitNet','RefundAmount','Settled','AdjustInvoiceId','Note','UpdatedAt','UpdatedBy'],
    AuditLog: ['LogId','Timestamp','UserEmail','Action','Entity','EntityId','Details']
  }
};

/** Vai trò người dùng. group = xem toàn hệ thống (không giới hạn theo SchoolId). */
const ROLES = {
  GROUP_ADMIN:       {label:'Quản trị hệ thống', group:true},
  EXECUTIVE:         {label:'Ban lãnh đạo (xem toàn hệ thống)', group:true},
  FINANCE_MANAGER:   {label:'Kế toán trưởng / Tài chính tập đoàn', group:true},
  AUDITOR:           {label:'Kiểm soát nội bộ (chỉ xem)', group:true},
  PRINCIPAL:         {label:'Hiệu trưởng / Lãnh đạo trường', group:false},
  SCHOOL_ACCOUNTANT: {label:'Kế toán trường', group:false},
  CASHIER:           {label:'Thủ quỹ', group:false},
  STOREKEEPER:       {label:'Thủ kho', group:false},
  TEACHER:           {label:'Giáo viên chủ nhiệm', group:false},
  PARENT:            {label:'Phụ huynh', group:false}
};

/** Quyền theo nghiệp vụ → danh sách vai trò được phép. */
const CAPS = {
  viewDashboard:  ['GROUP_ADMIN','EXECUTIVE','FINANCE_MANAGER','AUDITOR','PRINCIPAL','SCHOOL_ACCOUNTANT','CASHIER'],
  viewStudents:   ['GROUP_ADMIN','EXECUTIVE','FINANCE_MANAGER','AUDITOR','PRINCIPAL','SCHOOL_ACCOUNTANT','CASHIER','TEACHER','PARENT'],
  manageStudents: ['GROUP_ADMIN','FINANCE_MANAGER','PRINCIPAL','SCHOOL_ACCOUNTANT'],
  calcFees:       ['GROUP_ADMIN','FINANCE_MANAGER','SCHOOL_ACCOUNTANT'],
  receivePayment: ['GROUP_ADMIN','FINANCE_MANAGER','SCHOOL_ACCOUNTANT','CASHIER'],
  sell:           ['GROUP_ADMIN','FINANCE_MANAGER','SCHOOL_ACCOUNTANT','CASHIER'],
  viewStock:      ['GROUP_ADMIN','EXECUTIVE','FINANCE_MANAGER','AUDITOR','PRINCIPAL','SCHOOL_ACCOUNTANT','CASHIER','STOREKEEPER'],
  manageStock:    ['GROUP_ADMIN','FINANCE_MANAGER','STOREKEEPER'],
  recordExpense:  ['GROUP_ADMIN','FINANCE_MANAGER','SCHOOL_ACCOUNTANT'],
  approveExpense: ['GROUP_ADMIN','FINANCE_MANAGER','PRINCIPAL'],
  viewExpense:    ['GROUP_ADMIN','EXECUTIVE','FINANCE_MANAGER','AUDITOR','PRINCIPAL','SCHOOL_ACCOUNTANT'],
  notify:         ['GROUP_ADMIN','FINANCE_MANAGER','SCHOOL_ACCOUNTANT'],
  parentPortal:   ['PARENT'],
  manageParentAccounts: ['GROUP_ADMIN','FINANCE_MANAGER','PRINCIPAL','SCHOOL_ACCOUNTANT'],
  manageMeals:    ['GROUP_ADMIN','FINANCE_MANAGER','SCHOOL_ACCOUNTANT'],
  recordMealAbsence: ['GROUP_ADMIN','FINANCE_MANAGER','SCHOOL_ACCOUNTANT','PRINCIPAL','TEACHER'],
  viewReports:    ['GROUP_ADMIN','EXECUTIVE','FINANCE_MANAGER','AUDITOR','PRINCIPAL','SCHOOL_ACCOUNTANT','CASHIER','STOREKEEPER'],
  manageMaster:   ['GROUP_ADMIN','FINANCE_MANAGER'],
  managePolicy:   ['GROUP_ADMIN','FINANCE_MANAGER','PRINCIPAL','SCHOOL_ACCOUNTANT'],
  approvePolicy:  ['GROUP_ADMIN','FINANCE_MANAGER','PRINCIPAL'],
  manageClasses:  ['GROUP_ADMIN','FINANCE_MANAGER','PRINCIPAL'],
  manageUsers:    ['GROUP_ADMIN','PRINCIPAL'],
  manageSettings: ['GROUP_ADMIN','FINANCE_MANAGER'],
  manageBanner:   ['GROUP_ADMIN','EXECUTIVE','FINANCE_MANAGER','PRINCIPAL'],
  viewRawData:    ['GROUP_ADMIN','EXECUTIVE','FINANCE_MANAGER','AUDITOR','PRINCIPAL','SCHOOL_ACCOUNTANT']
};

const LEVELS = {MAM_NON:'Mầm non', TIEU_HOC:'Tiểu học', THCS:'THCS', THPT:'THPT', LIEN_CAP:'Liên cấp'};
