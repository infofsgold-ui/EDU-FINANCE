/**
 * ẢNH NỀN MẶC ĐỊNH CỦA HERO BANNER: học sinh Viet School trước khuôn viên trường (logo Viet School trên tòa nhà và quyển vở).
 * Ảnh nằm trong AssetBanner.html. Dùng khi trường chưa tải ảnh riêng. Lần đầu dùng sẽ tạo tệp "Banner mặc định Viet School.jpg" trong thư mục Drive "Banner trường".
 */
const DEFAULT_BANNER_VERSION_ = 'vietschool-campus-1';

function defaultBannerUrl_() {
  return driveAsset_('DEFAULT_BANNER', DEFAULT_BANNER_VERSION_, 'AssetBanner', 'image/jpeg', 'Banner mặc định Viet School.jpg', 1600);
}
