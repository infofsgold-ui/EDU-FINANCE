/**
 * LOGO VIET SCHOOL — dùng cho favicon trình duyệt và đầu email thông báo.
 * Ảnh PNG 128px nằm trong AssetLogo.html (chỉ đọc khi cần, không nạp ở mỗi lần chạy); lần đầu cần URL công khai sẽ tạo tệp trong thư mục Drive hồ sơ ("Banner trường"),
 * chia sẻ "Bất kỳ ai có liên kết" (chỉ xem) và lưu ID vào Script Properties.
 */
const LOGO_VERSION_ = 'vietschool-1';

/**
 * Ảnh nhúng sẵn → tệp công khai trên Drive (tạo 1 lần, lưu ID vào Script Properties; đổi version thì tạo lại).
 * Trả về URL thumbnail Drive, hoặc '' nếu chưa tạo được (VD chưa cấu hình thư mục Drive).
 */
function driveAsset_(key, version, assetFile, mime, name, size) {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(key + '_FILE_ID');
  if (!id || props.getProperty(key + '_VERSION') !== version) {
    try {
      const file = driveFolder_('DOCUMENTS_FOLDER_ID', 'Banner trường').createFile(Utilities.newBlob(Utilities.base64Decode(HtmlService.createHtmlOutputFromFile(assetFile).getContent().trim()), mime, name));
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
      const old = id;
      id = file.getId();
      const p = {}; p[key + '_FILE_ID'] = id; p[key + '_VERSION'] = version;
      props.setProperties(p);
      if (old) { try { DriveApp.getFileById(old).setTrashed(true); } catch (e) {} }
    } catch (e) { Logger.log('driveAsset_ ' + key + ': ' + e); return ''; }
  }
  return driveImageUrl_(id, size);
}

/** URL ảnh logo công khai. */
function logoUrl_(size) { return driveAsset_('LOGO', LOGO_VERSION_, 'AssetLogo', 'image/png', 'Logo Viet School.png', size || 128); }

/** Logo nhỏ đầu email tài khoản / mật khẩu. */
function emailLogo_() {
  const u = logoUrl_();
  return u ? '<div style="margin:0 0 14px"><img src="' + esc_(u) + '" width="56" height="56" alt="Viet School" style="display:block"></div>' : '';
}
