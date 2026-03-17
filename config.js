export const SERVER_URL = "http://localhost:19222";

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
