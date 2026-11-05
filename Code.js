function doGet() {
  const out = HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Viet School · ' + APP.NAME)
    .addMetaTag('viewport','width=device-width, initial-scale=1');
  // Biểu tượng tab trình duyệt = logo Viet School (bỏ qua nếu chưa tạo được ảnh trên Drive).
  try { const u = logoUrl_(64); if (u) out.setFaviconUrl(u); } catch (e) { Logger.log('favicon: ' + e); }
  return out;
}
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}