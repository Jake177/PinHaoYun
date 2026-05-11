# PinHaoYun iOS React Native 应用（上传为主）计划

## Current Status
- Last audited: 2026-05-11.
- 这是后续路线图，不是已实现功能。
- 当前仓库没有 `apps/mobile`。
- 当前 Web API 仍主要依赖 cookie 鉴权；`Authorization: Bearer`、`X-Access-Token`、`/api/auth/refresh` 和登录接口返回移动端 token JSON 尚未实现。
- 当前 Web 已支持视频、照片、Live Photo 风格配对上传、最近媒体列表、预览、删除、位置编辑、地图和会员计费；移动端计划应复用这些 API，但需要先完成 Header 鉴权与 token 刷新。

## Summary
- 保留现有 Web，不改 UI 逻辑。
- 新增 `apps/mobile`（Bare RN, iOS only），提供登录/注册/验证 + 上传视频/Live Photo + 最近上传列表。
- 后端加 Header 鉴权与刷新 token 能力，移动端使用 `Authorization: Bearer`。

## Public APIs / Interfaces 变更
- 统一鉴权读取：新增 `Authorization: Bearer <id_token>` + `X-Access-Token: <access_token>` 作为 cookie 的替代。
- `/api/auth/sign-in` 返回 `idToken / accessToken / refreshToken / expiresIn`（仍保留现有 cookie 行为，Web 不受影响）。
- 新增 `/api/auth/refresh`：传入 refresh token，返回新的 `idToken / accessToken / expiresIn`，可选刷新 cookie。
- 受影响的现有 API（统一改用新鉴权 helper）：
  - `app/api/videos/*`
  - `app/api/user/profile`
  - `app/api/videos/location(s)`
  - `app/api/videos/delete`
  - `app/api/videos/presign`
  - `app/api/videos/multipart/*`
  - `app/api/videos/notify`

## Implementation Steps
1. Backend 鉴权抽象
- 新增 `app/lib/auth.ts`。
- 优先读 `Authorization` header（验证 `idToken`），失败回退到 cookie（兼容现有 Web）。
- 统一返回 `{ idToken, accessToken, payload }`。
- 所有需要用户身份的 Route Handler 替换原先 `cookies().get("id_token")` 逻辑。

2. Auth API 更新
- 修改 `app/api/auth/sign-in/route.ts`：返回 `idToken/accessToken/refreshToken/expiresIn` JSON，同时继续设置 cookie。
- 新增 `app/api/auth/refresh/route.ts`：`REFRESH_TOKEN_AUTH` 换新 token，返回 JSON，可同时更新 cookie（可选）。

3. 新建移动端工程
- 在仓库内创建 `apps/mobile`（Bare RN + TypeScript）。
- 目标 iOS：默认 iOS 15+。
- 关键依赖：
  - `@react-navigation/native`
  - `@react-navigation/native-stack`
  - `@react-navigation/bottom-tabs`
  - `react-native-keychain`
  - `react-native-fs`
  - `react-native-blob-util`
  - `react-native-quick-crypto`

4. Token & API Client
- `src/auth/tokenStore.ts`：Keychain 保存 `idToken/accessToken/refreshToken/exp`。
- `src/api/client.ts`：
  - 自动注入 `Authorization: Bearer <idToken>` + `X-Access-Token: <accessToken>`。
  - 401 自动触发 `/api/auth/refresh`，成功后重试一次请求。

5. 认证 UI
- Auth Stack：`SignIn` / `SignUp` / `ConfirmEmail` / `ResendCode`。
- 走现有后端 `/api/auth/sign-up`、`/api/auth/confirm-sign-up`、`/api/auth/resend-code`、`/api/auth/sign-in`。

6. Live Photo 选择（iOS 原生模块）
- 新增 Swift 原生模块 `LiveMediaPicker`：
  - 使用 `PHPickerViewController` 支持多选。
  - 对 Live Photo：用 `PHAssetResourceManager` 导出 `photo` + `pairedVideo` 到临时目录，返回两个 URI。
  - 对普通视频/照片：导出文件到临时目录并返回 URI。
- JS 侧统一转换成 `UploadTask[]`。

7. 上传管线（Multipart）
- 校验文件类型/大小（与 Web 规则一致：最大 2GB）。
- 内容哈希：
  - 用 `react-native-fs` 的 `read(path, length, position, 'base64')` 读取首 10MB 做 SHA-256。
  - 哈希格式与 Web 一致：`sha256(firstChunk)-fileSize`。
- 分片上传：
  - `init -> part -> PUT -> complete -> notify` 与 Web 完全一致。
  - 分片内容由 `react-native-fs` 读取后使用 `react-native-blob-util.fetch('PUT', url, ...)` 上传，支持 `uploadProgress` 更新进度。
- 并发控制：最多 3 个并发任务。
- Live Photo：
  - 静态图 `mediaType=PHOTO, mediaRole=image` + `photoId`。
  - 配对视频 `mediaType=PHOTO, mediaRole=liveVideo` + 同一 `photoId`。

8. UI 结构
- `Bottom Tabs`
  - `Upload`: 选择媒体 + 队列进度 + 失败重试 + 取消。
  - `Recent`: 调 `/api/videos/list?limit=20`，展示最近上传缩略图/类型/时间。
- 最近列表只读，不做删除/位置编辑（后续版本可加）。

9. 配置与文档
- `apps/mobile/.env`：`PINHAOYUN_API_BASE_URL`, `UPLOAD_PART_SIZE`, `MAX_BYTES`。
- `apps/mobile/README.md`：本地运行、真机调试、iOS 权限说明。

## Test Cases & Scenarios
1. Auth
- 注册 -> 收到验证码 -> 验证成功 -> 登录成功。
- 错误验证码 -> 提示失败。
- token 过期 -> 自动 refresh -> 请求成功。

2. Upload
- 普通视频上传（<2GB）成功，进度正确。
- 普通照片上传成功。
- Live Photo 上传成功（静态图 + 配对视频）。
- 重复文件：后端返回 duplicate 时前端显示“已跳过”。
- 上传中断（断网/取消） -> 触发 abort -> UI 可重试。

3. Recent
- Recent 列表正常显示缩略图 / 类型 / 时间。
- 下拉刷新能更新到最新上传。

## Assumptions / Defaults
- 仅做 iOS，安卓不在范围内。
- iOS 15+ 作为最低版本。
- 仅前台上传，不做后台断点续传。
- 现有 Web 不改 UI；后端扩展保持向后兼容。
