// /api/fms.js
// Trip Check-In Bot backend
// OAuth login + FMS login
// Pass raw FMS login cookies EXACTLY as returned. No merging, no filtering.

const OAUTH_URL = "https://id.item.com/auth/realms/ITEM/protocol/openid-connect/token";
const FMS_BASE  = "https://fms.item.com";

const FMS_LOGIN_URL      = `${FMS_BASE}/fms-platform-user/Auth/Login`;
const FMS_TRIP_TASKS_URL = `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/GetTaskList`;
const FMS_CHECKIN_URL    = `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/TaskCheckIn`;
const FMS_UNDO_URL       = `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/CancelTaskCheckIn`;

const FMS_CLIENT = "FMS_WEB";
const FMS_COMPANY_ID = "SBFH";

// ENV CREDS
const FMS_USER = process.env.FMS_USER;
const FMS_PASS = process.env.FMS_PASS;

// Cache
let OAUTH_TOKEN = null;
let OAUTH_EXP   = 0;

let FMS_TOKEN   = null;
let FMS_EXP     = 0;

let RAW_FMS_COOKIES = "";   // <-- store EXACT cookies returned from login

/* ================================
   HELPERS
================================ */
const clean = (v) => (v == null ? "" : String(v).trim());

/* ================================
   OAUTH LOGIN
================================ */
async function loginOAuth(force = false) {
  const now = Date.now();
  if (!force && OAUTH_TOKEN && now < OAUTH_EXP) return OAUTH_TOKEN;

  const params = new URLSearchParams();
  params.set("grant_type", "password");
  params.set("client_id", "7cd6c6e4-ee68-4b8a-aadf-116b81d90bce");
  params.set("username", FMS_USER);
  params.set("password", FMS_PASS);

  const resp = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!resp.ok) throw new Error(`OAuth login failed ${resp.status}`);

  const json = await resp.json();
  OAUTH_TOKEN = json.access_token;
  OAUTH_EXP = Date.now() + (json.expires_in - 60) * 1000;

  return OAUTH_TOKEN;
}

/* ================================
   FMS LOGIN – STORE RAW COOKIES
================================ */
async function loginFms(force = false) {
  const now = Date.now();
  if (!force && FMS_TOKEN && now < FMS_EXP) {
    return { token: FMS_TOKEN, cookies: RAW_FMS_COOKIES };
  }

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

  const rawText = await resp.text();
  if (!resp.ok) {
    throw new Error(`FMS login failed: ${resp.status} ${rawText}`);
  }

  let json;
  try { json = JSON.parse(rawText); }
  catch { throw new Error("FMS login JSON parse error: " + rawText); }

  FMS_TOKEN =
    json.token ||
    json?.data?.token ||
    json?.result?.token ||
    "";

  if (!FMS_TOKEN) throw new Error("FMS login returned no token");

  // Extract raw cookies EXACTLY as returned
  const cookies = resp.headers.raw()["set-cookie"] || [];
  RAW_FMS_COOKIES = cookies.join("; ");   // <-- DO NOT PARSE OR FILTER

  FMS_EXP = Date.now() + 55 * 60 * 1000;

  return {
    token: FMS_TOKEN,
    cookies: RAW_FMS_COOKIES
  };
}

/* ================================
   AUTH WRAPPER FOR ALL CALLS
================================ */
async function dispatchFetch(url, opts = {}, retry = true) {
  const oauth = await loginOAuth();
  const fms   = await loginFms();

  const headers = {
    "authorization": `Bearer ${oauth}`,
    "fms-token": fms.token,
    "fms-client": FMS_CLIENT,
    "company-id": FMS_COMPANY_ID,
    "cookie": RAW_FMS_COOKIES,   // <-- EXACT LOGIN COOKIES PASSED RAW
    "accept": "application/json, text/plain, */*",
    "referer": "https://fms.item.com/",
    "user-agent": "Mozilla/5.0",
    ...(opts.headers || {})
  };

  const resp = await fetch(url, { ...opts, headers });

  // Retry on auth failure
  if ((resp.status === 401 || resp.status === 403) && retry) {
    await loginOAuth(true);
    await loginFms(true);
    return dispatchFetch(url, opts, false);
  }

  return resp;
}

/* ================================
   NORMALIZE TASKS
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

      case "getTasks": {
        const { tripNo } = req.body;
        if (!tripNo) return res.status(400).json({ error: "tripNo required" });

        const url = `${FMS_TRIP_TASKS_URL}?tripNo=${encodeURIComponent(tripNo)}`;
        const resp = await dispatchFetch(url, { method: "GET" });
        const txt = await resp.text();

        if (!resp.ok) {
          return res.status(500).json({ error: "FMS request failed", details: txt });
        }

        let json = {};
        try { json = JSON.parse(txt); }
        catch { return res.status(500).json({ error: "Invalid JSON", raw: txt }); }

        const raw = json?.tasks || [];
        return res.status(200).json({
          tripNo,
          tasks: raw.map(normalizeTask)
        });
      }

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
          statusCode: resp.status,
          taskNo: task.taskNo
        });
      }

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
          statusCode: resp.status,
          taskNo: task.taskNo
        });
      }

      default:
        return res.status(400).json({ error: "Unknown action" });
    }

  } catch (err) {
    console.error("FMS handler error:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      details: err.message || String(err)
    });
  }
}
