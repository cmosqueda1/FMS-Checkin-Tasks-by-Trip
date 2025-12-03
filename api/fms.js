// /api/fms.js
// Trip Check-In Bot backend
// Correct dual-JWT FMS authentication
// Robust task parsing for ALL FMS payload shapes

const FMS_BASE = "https://fms.item.com";

const FMS_LOGIN_URL =
  `${FMS_BASE}/fms-platform-user/Auth/Login`;

const FMS_TRIP_TASKS_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/GetTaskList`;

const FMS_CHECKIN_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/TaskCheckIn`;

const FMS_UNDO_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/CancelTaskCheckIn`;

const FMS_CLIENT = "FMS_WEB";
const FMS_COMPANY_ID = "SBFH";

const FMS_USER = process.env.FMS_USER;
const FMS_PASS = process.env.FMS_PASS;

/* ================================
   TOKEN CACHE
================================ */
let FMS_TOKEN = null;
let FMS_AUTH_TOKEN = null;
let FMS_TOKEN_TS = 0;
const TOKEN_TTL_MS = 55 * 60 * 1000;

const clean = (v) => (v == null ? "" : String(v).trim());

/* ================================
   LOGIN
================================ */
async function loginFms(force = false) {
  const now = Date.now();

  if (
    !force &&
    FMS_TOKEN &&
    FMS_AUTH_TOKEN &&
    now - FMS_TOKEN_TS < TOKEN_TTL_MS
  ) {
    return { fmsToken: FMS_TOKEN, authToken: FMS_AUTH_TOKEN };
  }

  if (!FMS_USER || !FMS_PASS)
    throw new Error("Missing FMS_USER or FMS_PASS environment variables");

  const resp = await fetch(FMS_LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "fms-client": FMS_CLIENT
    },
    body: JSON.stringify({
      account: FMS_USER,
      password: FMS_PASS
    })
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`FMS login failed HTTP ${resp.status}: ${t}`);
  }

  const json = await resp.json().catch(() => ({}));
  const data = json?.data || {};

  const smallToken = data.token || json.token || null;
  const bigToken =
    data.third_party_token ||
    data.thirdPartyToken ||
    null;

  if (!smallToken || !bigToken)
    throw new Error("FMS login missing token or third_party_token");

  FMS_TOKEN = smallToken;
  FMS_AUTH_TOKEN = bigToken;
  FMS_TOKEN_TS = now;

  return { fmsToken: FMS_TOKEN, authToken: FMS_AUTH_TOKEN };
}

/* ================================
   AUTH HEADERS
================================ */
async function authHeaders() {
  const { fmsToken, authToken } = await loginFms(false);

  return {
    "accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "authorization": authToken,
    "fms-token": fmsToken,
    "company-id": FMS_COMPANY_ID,
    "fms-client": FMS_CLIENT
  };
}

/* ================================
   FETCH w/ RETRY
================================ */
async function dispatchFetch(url, options = {}, retry = 0) {
  const headers = await authHeaders();

  const resp = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {})
    }
  });

  if ((resp.status === 401 || resp.status === 403) && retry < 1) {
    await loginFms(true);
    return dispatchFetch(url, options, retry + 1);
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
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { action } = req.body || {};

  try {

    switch (action) {

      /* ================================
         GET TASKS
      ================================ */
      case "getTasks": {
        const { tripNo } = req.body;
        if (!tripNo)
          return res.status(400).json({ error: "tripNo required" });

        const url =
          `${FMS_TRIP_TASKS_URL}?tripNo=${encodeURIComponent(tripNo)}`;

        const resp = await dispatchFetch(url, { method: "GET" });
        const txt = await resp.text();

        if (!resp.ok)
          return res.status(500).json({
            error: "FMS request failed",
            details: txt
          });

        let json = {};
        try { json = JSON.parse(txt); }
        catch {
          return res.status(500).json({
            error: "Invalid JSON",
            raw: txt
          });
        }

        // ✅ Final, correct extraction
        const raw =
          json?.data?.tasks ||
          json?.data?.list ||
          json?.result?.tasks ||
          json?.result?.rows ||
          json?.tasks ||
          json?.rows ||
          json?.list ||
          [];

        return res.status(200).json({
          tripNo,
          tasks: raw.map(normalizeTask)
        });
      }

      /* ================================
         CHECK-IN
      ================================ */
      case "checkin": {
        const { tripNo, task } = req.body;
        if (!tripNo || !task?.taskNo)
          return res.status(400).json({
            error: "tripNo and task.taskNo required"
          });

        const resp = await dispatchFetch(FMS_CHECKIN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tripNo,
            taskNo: task.taskNo
          })
        });

        return res.status(200).json({
          success: resp.ok,
          statusCode: resp.status,
          taskNo: task.taskNo
        });
      }

      /* ================================
         UNDO
      ================================ */
      case "undo": {
        const { tripNo, task } = req.body;
        if (!tripNo || !task?.taskNo)
          return res.status(400).json({
            error: "tripNo and task.taskNo required"
          });

        const resp = await dispatchFetch(FMS_UNDO_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tripNo,
            taskNo: task.taskNo
          })
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
