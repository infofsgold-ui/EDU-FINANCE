/**
 * Truy cập các thư mục Google Drive khai báo trong APP.DRIVE (Config.gs).
 * key: 'DOCUMENTS_FOLDER_ID' | 'PRODUCT_IMAGES_FOLDER_ID'; subName: tên thư mục con (tự tạo nếu chưa có).
 */
function driveFolderId_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || APP.DRIVE[key] || '';
}

function driveFolder_(key, subName) {
  const id = driveFolderId_(key);
  if (!id) throw new Error('Chưa cấu hình thư mục Drive ' + key + ' trong Config.gs.');
  let folder;
  try { folder = DriveApp.getFolderById(id); }
  catch (e) { throw new Error('Không mở được thư mục Drive ' + key + ' (' + id + '). Kiểm tra thư mục còn tồn tại và tài khoản chạy web app có quyền chỉnh sửa.'); }
  if (!subName) return folder;
  const it = folder.getFoldersByName(subName);
  return it.hasNext() ? it.next() : folder.createFolder(subName);
}

/** Kiểm tra kết nối các thư mục Drive (trang Cài đặt). */
function checkDriveFolders() {
  requireCap_('manageSettings');
  return Object.keys(APP.DRIVE).map(key => {
    const id = driveFolderId_(key);
    try {
      const f = DriveApp.getFolderById(id);
      return {key, id, ok:true, name:f.getName(), url:f.getUrl()};
    } catch (e) { return {key, id, ok:false, error:String(e.message || e)}; }
  });
}

/** URL ảnh xem được không cần đăng nhập Google (file đã chia sẻ "Bất kỳ ai có đường liên kết"). */
function driveImageUrl_(fileId, size) { return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(fileId) + '&sz=w' + (size || 600); }

/** Tải ảnh mặt hàng lên thư mục ảnh hàng hóa. payload: {ProductId, fileName, mimeType, base64} */
function uploadProductImage(payload) {
  const user = requireCap_('manageStock');
  const p = readTable_('Products').find(x => String(x.ProductId) === String(payload.ProductId));
  if (!p) throw new Error('Không tìm thấy mặt hàng.');
  const mime = String(payload.mimeType || '').toLowerCase();
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) throw new Error('Chỉ nhận ảnh JPG, PNG, WEBP hoặc GIF.');
  const bytes = Utilities.base64Decode(String(payload.base64 || ''));
  if (!bytes.length) throw new Error('Tệp ảnh rỗng.');
  if (bytes.length > APP.MAX_IMAGE_MB * 1024 * 1024) throw new Error('Ảnh vượt quá ' + APP.MAX_IMAGE_MB + ' MB.');
  const ext = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'}[mime];
  const safe = s => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
  const name = [safe(p.SKU), safe(p.ProductName), safe(p.Size)].filter(Boolean).join(' - ') + '.' + ext;
  const file = driveFolder_('PRODUCT_IMAGES_FOLDER_ID').createFile(Utilities.newBlob(bytes, mime, name));
  // Phụ huynh không đăng nhập Google → ảnh cần chia sẻ "Bất kỳ ai có đường liên kết" (chỉ xem) để hiển thị.
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { Logger.log('setSharing: ' + e); }
  file.setDescription('Ảnh mặt hàng ' + p.ProductId + ' - tải lên bởi ' + user.email);
  const oldId = String(p.ImageFileId || '');
  withWriteLock_(() => {
    updateObjectById_('Products', 'ProductId', p.ProductId, {ImageFileId:file.getId(), ImageUrl:driveImageUrl_(file.getId())});
    audit_('UPLOAD_IMAGE', 'Products', p.ProductId, {file:name});
  });
  // Ảnh cũ chuyển vào thùng rác Drive (khôi phục được trong 30 ngày).
  if (oldId) { try { DriveApp.getFileById(oldId).setTrashed(true); } catch (e) {} }
  return {ok:true, url:driveImageUrl_(file.getId()), name};
}

function removeProductImage(productId) {
  const user = requireCap_('manageStock');
  const p = readTable_('Products').find(x => String(x.ProductId) === String(productId));
  if (!p) throw new Error('Không tìm thấy mặt hàng.');
  const oldId = String(p.ImageFileId || '');
  withWriteLock_(() => {
    updateObjectById_('Products', 'ProductId', p.ProductId, {ImageFileId:'', ImageUrl:''});
    audit_('REMOVE_IMAGE', 'Products', p.ProductId, {});
  });
  if (oldId) { try { DriveApp.getFileById(oldId).setTrashed(true); } catch (e) {} }
  return {ok:true};
}
