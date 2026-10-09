export const POLICY_VERSION = "2026-10-08-beta-1";

const reading = {
  "terms": {
    "en": {
      "title": "PinHaoYun beta terms",
      "sections": [
        {
          "title": "Service and content",
          "text": "This invited beta provides private cloud storage for your photos and videos. You retain ownership of your content and grant permission only to store, process and display it to you. Upload content only if you have the necessary rights. Protect your account and do not misuse the service."
        },
        {
          "title": "Backups and availability",
          "text": "Keep independent backups of important originals while testing. Storage limits and service availability apply."
        },
        {
          "title": "Camera backup",
          "text": "Camera backup is optional and iOS controls background execution."
        },
        {
          "title": "Account deletion",
          "text": "Account deletion applies to the shared Web and iOS account, begins promptly and completes within 30 days; it does not delete your device's Photos library. Any legally required retention will be separately disclosed."
        },
        {
          "title": "Beta distribution",
          "text": "Purchases are not offered in this beta. Operator and support contact details must be confirmed before production distribution."
        }
      ]
    },
    "zh": {
      "title": "PinHaoYun 测试版服务条款",
      "sections": [
        {
          "title": "服务与内容",
          "text": "本受邀测试服务为你的照片和视频提供私人云存储。内容所有权属于你，你仅授权我们为提供服务而存储、处理并向你展示内容。请仅上传你有权使用的内容，保护账号，勿滥用服务。"
        },
        {
          "title": "备份与可用性",
          "text": "测试期间请另行备份重要原件。服务受存储额度及可用性限制。"
        },
        {
          "title": "自动备份",
          "text": "自动相册备份由你主动开启，后台执行受 iOS 控制。"
        },
        {
          "title": "账号注销",
          "text": "账号注销作用于 Web 与 iOS 共用账号，确认后尽快开始并最迟在 30 天内完成；不会删除手机相册。如依法必须保留部分资料，将另行明确告知。"
        },
        {
          "title": "测试分发",
          "text": "本测试版不提供购买功能。生产分发前须确认运营主体与支持联系方式。"
        }
      ]
    }
  },
  "privacy": {
    "en": {
      "title": "PinHaoYun beta privacy notice",
      "sections": [
        {
          "title": "Data we process",
          "text": "We process your email, required account attributes, uploaded originals, thumbnails, EXIF metadata (including embedded GPS when present), storage usage and policy acknowledgement."
        },
        {
          "title": "Hosting and location lookup",
          "text": "AWS hosts this development environment in Sydney. Location lookup, when used, sends coordinates or search text to Mapbox."
        },
        {
          "title": "Account security and permissions",
          "text": "Passwords are handled through Amazon Cognito; tokens are kept in the device Keychain. Photos permissions are requested for the action you choose. Logs must not contain passwords, tokens or media contents."
        },
        {
          "title": "Your originals and account deletion",
          "text": "You may retrieve your originals or request account deletion in the app. Account-associated cloud data is erased within 30 days; your local Photos library is unaffected."
        },
        {
          "title": "Testing draft",
          "text": "This is a testing draft, pending operator/contact details and a review of the actual retention and distribution arrangements."
        }
      ]
    },
    "zh": {
      "title": "PinHaoYun 测试版隐私说明",
      "sections": [
        {
          "title": "处理的资料",
          "text": "我们处理邮箱、现有用户池要求的账号属性、你上传的原始文件、缩略图、EXIF 元数据（文件自带的 GPS 信息如有）、存储用量及条款确认记录。"
        },
        {
          "title": "托管与位置查询",
          "text": "开发环境由 AWS 托管于悉尼。使用位置查询时，会向 Mapbox 发送坐标或搜索文字。"
        },
        {
          "title": "账号安全与权限",
          "text": "密码由 Amazon Cognito 处理，登录凭据保存在设备钥匙串中。相册权限按你选择的操作申请。日志不得包含密码、登录凭据或媒体内容。"
        },
        {
          "title": "原件与账号注销",
          "text": "你可下载原件，也可在 App 内申请注销。账号关联的云端资料在 30 天内删除，手机相册不受影响。"
        },
        {
          "title": "测试草案",
          "text": "本说明为测试草案，运营主体、联系方式、实际保留策略和发行安排须在生产分发前审核确认。"
        }
      ]
    }
  }
};

function plainText(document: { title: string; sections: { title: string; text: string }[] }, language: "en" | "zh") {
  return document.title + "\n\n" + document.sections.map(section => section.text).join(language === "en" ? " " : "");
}

export const policies = {
  version: POLICY_VERSION,
  isDraft: process.env.POLICIES_APPROVED !== "true",
  terms: { en: plainText(reading.terms.en, "en"), zh: plainText(reading.terms.zh, "zh") },
  privacy: { en: plainText(reading.privacy.en, "en"), zh: plainText(reading.privacy.zh, "zh") },
  reading
};
