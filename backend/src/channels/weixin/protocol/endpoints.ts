export const DEFAULT_API_BASE_URL = "https://ilinkai.weixin.qq.com";
/** Phase 4 不处理媒体，这里只记录常量，避免以后忘记它属于哪一层 */
export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export const QR_BOT_TYPE = "3";

export const ENDPOINTS = {
  getBotQrCode: "ilink/bot/get_bot_qrcode",
  getQrCodeStatus: "ilink/bot/get_qrcode_status",
  getUpdates: "ilink/bot/getupdates",
  sendMessage: "ilink/bot/sendmessage",
  getUploadUrl: "ilink/bot/getuploadurl",
  getConfig: "ilink/bot/getconfig",
  sendTyping: "ilink/bot/sendtyping",
  notifyStart: "ilink/bot/msg/notifystart",
  notifyStop: "ilink/bot/msg/notifystop",
} as const;

export function buildUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint}`;
}