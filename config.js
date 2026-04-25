export const SERVER_URL = "http://localhost:19222";

// Native Messaging host name (must match server/install_native_host.py HOST_NAME).
export const NATIVE_HOST = "io.shopee.cert_keeper";

// HTTP header carrying the shared local-only auth token.
export const TOKEN_HEADER = "X-Cert-Keeper-Token";

export const DEFAULT_SETTINGS = {
  syncIntervalMinutes: 10,
  enforceWorkHours: true,
  workHours: { startMin: 570, endMin: 1140, weekdaysOnly: true },
  useNativeMessaging: false,
  authToken: "",
};

export const DEFAULT_SITES = [
  {
    id: "datasuite",
    name: "DataSuite",
    url: "https://datasuite.shopee.io",
    cookies: true,
    localStorage: false,
    lsKeys: [],
    cookieValidation: "DATA-SUITE-AUTH-userToken",
  },
  {
    id: "wms-data",
    name: "WMS Data",
    url: "https://data.ssc.shopeemobile.com",
    cookies: true,
    localStorage: false,
    lsKeys: [],
    requiredCookies: ["csrfToken", "oa_user_id", "oa_skey"],
  },
  {
    id: "space",
    name: "SPACE",
    url: "https://space.shopee.io",
    cookies: true,
    localStorage: true,
    lsKeys: ["session"],
  },
];

export const SITE_ICONS = {
  datasuite: { cls: "ds", emoji: "\u{1f4ca}" },
  "wms-data": { cls: "wms", emoji: "\u{1f3ed}" },
  space: { cls: "sp", emoji: "\u{1f6f0}" },
};
