/**
 * HERO BANNER TRANG PHỤ HUYNH — mỗi trường một banner (ảnh, thông điệp, nút, số liệu nổi bật).
 * SchoolId = '*' là banner mặc định cho mọi trường chưa có banner riêng.
 * Người chỉnh: quản trị, ban lãnh đạo, kế toán trưởng (mọi trường) và hiệu trưởng (trường mình).
 */

const BANNER_ICONS_ = ['cap', 'users', 'shield', 'building', 'star', 'trophy', 'book', 'heart', 'globe', 'smile'];

function bannerDefault_(school) {
  return {SchoolId:'', Eyebrow:'HỆ THỐNG GIÁO DỤC ' + String((school && school.SchoolName) || 'VIET SCHOOL').toUpperCase(),
    Title:'Kiến tạo thế hệ trẻ', TitleAccent:'vững vàng tương lai',
    Description:'Với triết lý giáo dục lấy học sinh làm trung tâm, chúng tôi kiến tạo môi trường học tập hiện đại, nhân văn và sáng tạo, để mỗi em học sinh phát triển toàn diện về trí tuệ, kỹ năng và nhân cách.',
    ImageFileId:'', ImageUrl:defaultBannerUrl_(), DefaultImage:true, CtaLabel:'Khám phá chương trình học', CtaLink:'', VideoLabel:'Xem video giới thiệu', VideoUrl:'',
    Stats:[{icon:'cap', value:'10+', label:'Năm kinh nghiệm trong lĩnh vực giáo dục'}, {icon:'users', value:'15.000+', label:'Học sinh đã và đang theo học'},
      {icon:'shield', value:'98%', label:'Tỷ lệ tốt nghiệp và định hướng nghề nghiệp'}, {icon:'building', value:'10+', label:'Cơ sở đào tạo trên toàn quốc'}],
    Tagline:'Dream · Learn · Grow', Active:true};
}

function bannerView_(row, school) {
  const d = bannerDefault_(school);
  if (!row) return Object.assign(d, {source:'default'});
  let stats = [];
  try { stats = JSON.parse(String(row.Stats || '[]')); } catch (e) {}
  const txt = (k) => row[k] === undefined || row[k] === null ? '' : String(row[k]);
  return {SchoolId:String(row.SchoolId), Eyebrow:txt('Eyebrow'), Title:txt('Title') || d.Title, TitleAccent:txt('TitleAccent'), Description:txt('Description'),
    ImageFileId:txt('ImageFileId'), ImageUrl:txt('ImageUrl') || defaultBannerUrl_(), DefaultImage:!txt('ImageUrl'), CtaLabel:txt('CtaLabel'), CtaLink:txt('CtaLink'), VideoLabel:txt('VideoLabel'), VideoUrl:txt('VideoUrl'),
    Stats:Array.isArray(stats) ? stats.filter(s => s && (s.value || s.label)).slice(0, 4) : [], Tagline:txt('Tagline'),
    Active:row.Active === '' || row.Active === undefined || truthy_(row.Active), UpdatedAt:txt('UpdatedAt'), UpdatedBy:txt('UpdatedBy'),
    source:String(row.SchoolId) === '*' ? 'group' : 'school'};
}

/** Banner hiển thị cho phụ huynh của trường: banner riêng → banner chung '*' → mẫu mặc định. */
function bannerFor_(schoolId) {
  const school = readTable_('Schools').find(s => String(s.SchoolId) === String(schoolId)) || {};
  const rows = readTable_('SchoolBanners');
  const own = rows.find(r => String(r.SchoolId) === String(schoolId));
  const group = rows.find(r => String(r.SchoolId) === '*');
  const pick = [own, group].find(r => r && (r.Active === '' || r.Active === undefined || truthy_(r.Active)));
  return bannerView_(pick || null, school);
}

function assertBannerScope_(user, schoolId) {
  if (schoolId === '*') { if (!isGroupWide_(user)) throw new Error('Chỉ tài khoản cấp hệ thống mới sửa được banner chung cho mọi trường.'); }
  else assertSchoolAccess_(user, schoolId);
}

/** Dữ liệu trang chỉnh banner. params: {schoolId} */
function getBannerAdmin(params) {
  const user = requireCap_('manageBanner');
  const schools = listSchoolsForUser_(user);
  const list = (isGroupWide_(user) ? [{id:'*', name:'Banner chung (mọi trường chưa có banner riêng)'}] : [])
    .concat(schools.map(s => ({id:String(s.SchoolId), name:s.SchoolName})));
  const sid = String((params && params.schoolId) || (list[0] || {}).id || '');
  assertBannerScope_(user, sid);
  const school = schools.find(s => String(s.SchoolId) === sid) || {SchoolName:'Viet School'};
  const row = readTable_('SchoolBanners').find(r => String(r.SchoolId) === sid);
  const has = new Set(readTable_('SchoolBanners').map(r => String(r.SchoolId)));
  return {schools:list.map(s => Object.assign(s, {custom:has.has(s.id)})), schoolId:sid, banner:row ? bannerView_(row, school) : null,
    effective:sid === '*' ? (row ? bannerView_(row, school) : bannerDefault_(null)) : bannerFor_(sid), icons:BANNER_ICONS_, defaults:bannerDefault_(school)};
}

function cleanUrl_(u, label) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\/[^\s]+$/i.test(s)) throw new Error(label + ' phải là đường dẫn bắt đầu bằng http:// hoặc https://');
  return s;
}

/** payload: {SchoolId, Eyebrow, Title, TitleAccent, Description, CtaLabel, CtaLink, VideoLabel, VideoUrl, Tagline, Active, Stats:[{icon,value,label}]} */
function saveSchoolBanner(payload) {
  const user = requireCap_('manageBanner');
  const sid = String(payload.SchoolId || '');
  if (!sid) throw new Error('Chọn trường.');
  assertBannerScope_(user, sid);
  const title = String(payload.Title || '').trim();
  if (!title) throw new Error('Nhập tiêu đề chính.');
  const stats = (payload.Stats || []).slice(0, 4).map(s => ({icon:BANNER_ICONS_.indexOf(String(s.icon)) > -1 ? String(s.icon) : 'star',
    value:String(s.value || '').trim().slice(0, 20), label:String(s.label || '').trim().slice(0, 80)})).filter(s => s.value || s.label);
  const rec = {Eyebrow:String(payload.Eyebrow || '').trim().slice(0, 80), Title:title.slice(0, 80), TitleAccent:String(payload.TitleAccent || '').trim().slice(0, 80),
    Description:String(payload.Description || '').trim().slice(0, 400), CtaLabel:String(payload.CtaLabel || '').trim().slice(0, 40), CtaLink:cleanUrl_(payload.CtaLink, 'Liên kết nút chính'),
    VideoLabel:String(payload.VideoLabel || '').trim().slice(0, 40), VideoUrl:cleanUrl_(payload.VideoUrl, 'Liên kết video'), Tagline:String(payload.Tagline || '').trim().slice(0, 40),
    Stats:JSON.stringify(stats), Active:payload.Active === undefined ? true : truthy_(payload.Active), UpdatedAt:new Date(), UpdatedBy:user.email};
  return withWriteLock_(() => {
    const exists = readTable_('SchoolBanners').some(r => String(r.SchoolId) === sid);
    if (exists) updateObjectById_('SchoolBanners', 'SchoolId', sid, rec);
    else appendObject_('SchoolBanners', Object.assign({SchoolId:asText_(sid), ImageFileId:'', ImageUrl:''}, rec));
    invalidateTable_('SchoolBanners');
    audit_(exists ? 'UPDATE' : 'CREATE', 'SchoolBanners', sid, {title});
    return {ok:true};
  });
}

/** Ảnh nền banner (JPG/PNG/WEBP ≤ 8 MB) → thư mục "Banner trường" trong thư mục hồ sơ. payload: {SchoolId, fileName, mimeType, base64} */
function uploadBannerImage(payload) {
  const user = requireCap_('manageBanner');
  const sid = String(payload.SchoolId || '');
  assertBannerScope_(user, sid);
  const mime = String(payload.mimeType || '').toLowerCase();
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) throw new Error('Chỉ nhận ảnh JPG, PNG hoặc WEBP.');
  const bytes = Utilities.base64Decode(String(payload.base64 || ''));
  if (!bytes.length) throw new Error('Tệp ảnh rỗng.');
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Ảnh vượt quá 8 MB. Hãy nén ảnh (khuyến nghị 1920×900, dưới 1 MB).');
  const school = readTable_('Schools').find(s => String(s.SchoolId) === sid);
  const name = 'Banner - ' + String(school ? school.SchoolName : 'Mọi trường').replace(/[\\/:*?"<>|]/g, '_') + ' - ' +
    Utilities.formatDate(new Date(), APP.TZ, 'yyyyMMdd-HHmm') + '.' + {'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp'}[mime];
  const file = driveFolder_('DOCUMENTS_FOLDER_ID', 'Banner trường').createFile(Utilities.newBlob(bytes, mime, name));
  // Phụ huynh không đăng nhập Google → chia sẻ "Bất kỳ ai có đường liên kết" (chỉ xem) để ảnh hiển thị.
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { Logger.log('setSharing: ' + e); }
  const url = driveImageUrl_(file.getId(), 1920);
  let oldId = '';
  withWriteLock_(() => {
    const row = readTable_('SchoolBanners').find(r => String(r.SchoolId) === sid);
    if (row) { oldId = String(row.ImageFileId || ''); updateObjectById_('SchoolBanners', 'SchoolId', sid, {ImageFileId:file.getId(), ImageUrl:url, UpdatedAt:new Date(), UpdatedBy:user.email}); }
    else {
      const d = bannerDefault_(school);
      appendObject_('SchoolBanners', {SchoolId:asText_(sid), Eyebrow:d.Eyebrow, Title:d.Title, TitleAccent:d.TitleAccent, Description:d.Description,
        ImageFileId:file.getId(), ImageUrl:url, CtaLabel:d.CtaLabel, CtaLink:'', VideoLabel:d.VideoLabel, VideoUrl:'', Stats:JSON.stringify(d.Stats),
        Tagline:d.Tagline, Active:true, UpdatedAt:new Date(), UpdatedBy:user.email});
    }
    invalidateTable_('SchoolBanners');
    audit_('UPLOAD_IMAGE', 'SchoolBanners', sid, {file:name});
  });
  if (oldId) { try { DriveApp.getFileById(oldId).setTrashed(true); } catch (e) {} }
  return {ok:true, url};
}

function removeBannerImage(schoolId) {
  const user = requireCap_('manageBanner');
  const sid = String(schoolId || '');
  assertBannerScope_(user, sid);
  let oldId = '';
  withWriteLock_(() => {
    const row = readTable_('SchoolBanners').find(r => String(r.SchoolId) === sid);
    if (!row) return;
    oldId = String(row.ImageFileId || '');
    updateObjectById_('SchoolBanners', 'SchoolId', sid, {ImageFileId:'', ImageUrl:'', UpdatedAt:new Date(), UpdatedBy:user.email});
    invalidateTable_('SchoolBanners');
    audit_('REMOVE_IMAGE', 'SchoolBanners', sid, {});
  });
  if (oldId) { try { DriveApp.getFileById(oldId).setTrashed(true); } catch (e) {} }
  return {ok:true};
}

/** Xóa banner riêng → trường quay về dùng banner chung / mặc định. */
function resetSchoolBanner(schoolId) {
  const user = requireCap_('manageBanner');
  const sid = String(schoolId || '');
  assertBannerScope_(user, sid);
  let oldId = '';
  withWriteLock_(() => {
    const row = readTable_('SchoolBanners').find(r => String(r.SchoolId) === sid);
    if (!row) return;
    oldId = String(row.ImageFileId || '');
    deleteRowById_('SchoolBanners', 'SchoolId', sid);
    invalidateTable_('SchoolBanners');
    audit_('DELETE', 'SchoolBanners', sid, {});
  });
  if (oldId) { try { DriveApp.getFileById(oldId).setTrashed(true); } catch (e) {} }
  return {ok:true};
}
