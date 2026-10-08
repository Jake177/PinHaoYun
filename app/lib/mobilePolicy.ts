export const POLICY_VERSION = "2026-10-08-beta-1";
export const policies = {
  version: POLICY_VERSION,
  isDraft: process.env.POLICIES_APPROVED !== "true",
  terms: {
    en: "PinHaoYun beta terms\n\nThis invited beta provides private cloud storage for your photos and videos. You retain ownership of your content and grant permission only to store, process and display it to you. Upload content only if you have the necessary rights. Protect your account and do not misuse the service. Keep independent backups of important originals while testing. Storage limits and service availability apply. Camera backup is optional and iOS controls background execution. Account deletion applies to the shared Web and iOS account, begins promptly and completes within 30 days; it does not delete your device's Photos library. Any legally required retention will be separately disclosed. Purchases are not offered in this beta. Operator and support contact details must be confirmed before production distribution.",
    zh: "PinHaoYun 测试版服务条款\n\n本受邀测试服务为你的照片和视频提供私人云存储。内容所有权属于你，你仅授权我们为提供服务而存储、处理并向你展示内容。请仅上传你有权使用的内容，保护账号，勿滥用服务。测试期间请另行备份重要原件。服务受存储额度及可用性限制。自动相册备份由你主动开启，后台执行受 iOS 控制。账号注销作用于 Web 与 iOS 共用账号，确认后尽快开始并最迟在 30 天内完成；不会删除手机相册。如依法必须保留部分资料，将另行明确告知。本测试版不提供购买功能。生产分发前须确认运营主体与支持联系方式。"
  },
  privacy: {
    en: "PinHaoYun beta privacy notice\n\nWe process your email, required account attributes, uploaded originals, thumbnails, EXIF metadata (including embedded GPS when present), storage usage and policy acknowledgement. AWS hosts this development environment in Sydney. Location lookup, when used, sends coordinates or search text to Mapbox. Passwords are handled through Amazon Cognito; tokens are kept in the device Keychain. Photos permissions are requested for the action you choose. Logs must not contain passwords, tokens or media contents. You may retrieve your originals or request account deletion in the app. Account-associated cloud data is erased within 30 days; your local Photos library is unaffected. This is a testing draft, pending operator/contact details and a review of the actual retention and distribution arrangements.",
    zh: "PinHaoYun 测试版隐私说明\n\n我们处理邮箱、现有用户池要求的账号属性、你上传的原始文件、缩略图、EXIF 元数据（文件自带的 GPS 信息如有）、存储用量及条款确认记录。开发环境由 AWS 托管于悉尼。使用位置查询时，会向 Mapbox 发送坐标或搜索文字。密码由 Amazon Cognito 处理，登录凭据保存在设备钥匙串中。相册权限按你选择的操作申请。日志不得包含密码、登录凭据或媒体内容。你可下载原件，也可在 App 内申请注销。账号关联的云端资料在 30 天内删除，手机相册不受影响。本说明为测试草案，运营主体、联系方式、实际保留策略和发行安排须在生产分发前审核确认。"
  }
};
