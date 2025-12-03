// /api/fms.js
// Trip Check-In Bot backend
// Full OAuth login, FMS login, cookie merging, dual-token authentication

import { parse } from "cookie";

/* ================================
   CONFIG
================================ */
const OAUTH_URL = "https://id.item.com/auth/realms/ITEM/protocol/openid-connect/token";
const FMS_BASE  = "https://fms.item.com";

const FMS_LOGIN_URL      = `${FMS_BASE}/fms-platform-user/Auth/Login`;
const FMS_TRIP_TASKS_URL = `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/GetTaskList`;
const FMS_CHECKIN_URL    = `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/TaskCheckIn`;
const FMS_UNDO_URL       = `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/CancelTaskCheckIn`;

// Static values from HAR
const FMS_CLIENT = "FMS_WEB";
const FMS_COMPANY_ID = "SBFH";

// ENV credentials
const FMS_USER = process.env.FMS_USER;
const FMS_PASS = process.env.FMS_PASS;

// Cached tokens + cookies
let OAUTH_TOKEN = null;
let OAUTH_EXP   = 0;
let FMS_TOKEN   = null;
let FMS_EXP     = 0;
let MERGED_COOKIES = "";

/* ================================
   HELPERS
================================ */
function clean(val) {
  return val == null ? "" : String(val).trim();
}

function extractCookies(resp) {
  const raw = resp.headers.get("set-cookie");
  if (!raw) return [];

  // Split combined cookies safely
  return raw.split(/,(?=\S+=)/g).map(c => c.trim());
}

function mergeCookies(arr1, arr2) {
  const map = new Map();
  [...arr1, ...arr2].forEach(c => {
    const parsed = parse(c);
    const name = Object.keys(parsed)[0];
    if (name) map.set(name, parsed[name]);
  });
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

/* ================================
   OAUTH LOGIN
================================ */
async function loginOAuth(force = false) {
  const now = Date.now();
  if (!force && OAUTH_TOKEN && now < OAUTH_EXP) return { token: OAUTH_TOKEN };

  const params = new URLSearchParams();
  params.set("grant_type", "password");
  params.set("client_id", "7cd6c6e4-ee68-4b8a-aadf-116b81d90bce"); // from HAR
  params.set("username", FMS_USER);
  params.set("password", FMS_PASS);

  const resp = await fetch(OAUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params,
  });

  if (!resp.ok) {
    throw new Error(`OAuth login failed: HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const cookies = extractCookies(resp);

  OAUTH_TOKEN = data.access_token;
  OAUTH_EXP   = Date.now() + (data.expires_in - 60) * 1000; // 1m leeway

  // merge cookies into global pool
  MERGED_COOKIES = mergeCookies(cookies, []);

  return { token: OAUTH_TOKEN, cookies };
}

/* ================================
   FMS LOGIN
================================ */
async function loginFms(force = false) {
  const now = Date.now();
  if (!force && FMS_TOKEN && now < FMS_EXP) return { token: FMS_TOKEN };

  const resp = await fetch(FMS_LOGIN_URL, {
    method: "POST",
    headers: {
      "fms-client": FMS_CLIENT,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      account: FMS_USER,
      password: FMS_PASS
    })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`FMS login failed: HTTP ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const cookies = extractCookies(resp);

  const token =
    data.token ||
    data?.data?.token ||
    data?.result?.token ||
    "";

  if (!token) throw new Error("FMS login returned no token");

  FMS_TOKEN = token;
  FMS_EXP   = Date.now() + 55 * 60 * 1000;

  // merge cookies with OAuth cookies
  MERGED_COOKIES = mergeCookies(MERGED_COOKIES.split("; "), cookies);

  return { token: FMS_TOKEN, cookies };
}

/* ================================
   DISPATCH REQUEST WRAPPER
================================ */
async function dispatchFetch(url, opts = {}, retry = true) {
  await loginOAuth();
  await loginFms();

  const headers = {
    "authorization": `Bearer ${OAUTH_TOKEN}`,
    "fms-token": FMS_TOKEN,
    "fms-client": FMS_CLIENT,
    "company-id": FMS_COMPANY_ID,
    "cookie": MERGED_COOKIES,
    "referer": "https://fms.item.com/",
    "user-agent": "Mozilla/5.0",
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    ...(opts.headers || {})
  };

  const resp = await fetch(url, { ...opts, headers });

  if ((resp.status === 401 || resp.status === 403) && retry) {
    // retry after refreshing both tokens
    await loginOAuth(true);
    await loginFms(true);
    return dispatchFetch(url, opts, false);
  }

  return resp;
}

/* ================================
   TASK NORMALIZER
================================ */
function normalizeTask(t) {
  const status = clean(t.status_text || t.status);
  const typeRaw = clean(t.task_type_text || t.taskType);
  const l = typeRaw.toLowerCase();

  return {
    do: clean(t.order_no || t.do),
    pro: clean(t.tracking_no || t.pro),
    pu: clean(t.pu_no || t.reference5 || t.pu),
    taskNo: t.task_no || t.taskNo || 0,
    taskType:
      l.includes("delivery") ? "Delivery" :
      l.includes("pickup") ? "Pickup" :
      l.includes("linehaul") || l.includes("transfer") ? "Linehaul" :
      typeRaw,
    status
  };
}

/* ================================
   MAIN HANDLER
================================ */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action } = req.body || {};
  try {
    switch (action) {

      /* ---------------------------
         GET TASKS
      -----------------------------*/
      case "getTasks": {
        const { tripNo } = req.body;
        if (!tripNo) return res.status(400).json({ error: "tripNo required" });

        const url = `${FMS_TRIP_TASKS_URL}?tripNo=${encodeURIComponent(tripNo)}`;
        const resp = await dispatchFetch(url, { method: "GET" });
        const text = await resp.text();

        if (!resp.ok) {
          return res.status(500).json({ error: "FMS request failed", details: text });
        }

        let data;
        try { data = JSON.parse(text); }
        catch { return res.status(500).json({ error: "Invalid JSON", raw: text }); }

        const rawTasks = Array.isArray(data?.tasks) ? data.tasks : [];
        const tasks = rawTasks.map(normalizeTask);

        return res.status(200).json({ tripNo, tasks });
      }

      /* ---------------------------
         CHECK-IN
      -----------------------------*/
      case "checkin": {
        const { tripNo, task } = req.body;
        if (!tripNo || !task?.taskNo)
          return res.status(400).json({ error: "tripNo and task.taskNo required" });

        const resp = await dispatchFetch(FMS_CHECKIN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tripNo, taskNo: task.taskNo })
        });

        return res.status(200).json({
          success: resp.ok,
          taskNo: task.taskNo,
          statusCode: resp.status
        });
      }

      /* ---------------------------
         UNDO CHECK-IN
      -----------------------------*/
      case "undo": {
        const { tripNo, task } = req.body;
        if (!tripNo || !task?.taskNo)
          return res.status(400).json({ error: "tripNo and task.taskNo required" });

        const resp = await dispatchFetch(FMS_UNDO_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tripNo, taskNo: task.taskNo })
        });

        return res.status(200).json({
          success: resp.ok,
          taskNo: task.taskNo,
          statusCode: resp.status
        });
      }

      /* ---------------------------
         DEFAULT
      -----------------------------*/
      default:
        return res.status(400).json({ error: "Unknown action" });
    }

  } catch (err) {
    console.error("FMS router error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      details: err.message || String(err)
    });
  }
}
