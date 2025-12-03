// /api/fms.js
//
// ✅ Production-safe FMS backend
// ✅ Uses ONLY FMS login endpoint (NOT OAuth)
// ✅ Uses env creds: FMS_USER / FMS_PASS
// ✅ Caches tokens
// ✅ Fully working Trip -> Task pulling

/* =====================================================
   CONFIG
=====================================================*/

const FMS_BASE = "https://fms.item.com";

const LOGIN_URL =
  `${FMS_BASE}/fms-platform-user/Auth/Login`;

const TASKS_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/GetTaskList`;

const CHECKIN_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/TaskCheckIn`;

const UNDO_URL =
  `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/CancelTaskCheckIn`;

const FMS_CLIENT = "FMS_WEB";
const COMPANY_ID = "SBFH";

/* =====================================================
   ENV
=====================================================*/

const FMS_USER = process.env.FMS_USER;
const FMS_PASS = process.env.FMS_PASS;

if (!FMS_USER || !FMS_PASS) {
  throw new Error("Missing env vars FMS_USER / FMS_PASS");
}

/* =====================================================
   TOKEN CACHE
=====================================================*/

let FMS_TOKEN = null;       // small JWT
let AUTH_TOKEN = null;    // large RSA JWT
let TOKEN_TS = 0;

const TOKEN_TTL = 55 * 60 * 1000;  // 55 minutes

/* =====================================================
   LOGIN
=====================================================*/

async function fmsLogin(force = false) {

  const now = Date.now();

  if (
    !force &&
    FMS_TOKEN &&
    AUTH_TOKEN &&
    now - TOKEN_TS < TOKEN_TTL
  ) {
    return {
      fmsToken: FMS_TOKEN,
      authToken: AUTH_TOKEN
    };
  }

  const resp = await fetch(LOGIN_URL, {
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
    throw new Error(`FMS login failed: ${t}`);
  }

  const json = await resp.json().catch(() => null);
  const data = json?.data || json || {};

  const fms = data.token;
  const auth =
    data.third_party_token ||
    data.thirdPartyToken;

  if (!fms || !auth) {
    throw new Error("Login succeeded but tokens missing");
  }

  // Cache tokens
  FMS_TOKEN = fms;
  AUTH_TOKEN = auth;
  TOKEN_TS = now;

  return {
    fmsToken: FMS_TOKEN,
    authToken: AUTH_TOKEN
  };
}

/* =====================================================
   AUTH HEADERS
=====================================================*/

async function getHeaders() {
  const { fmsToken, authToken } = await fmsLogin(false);

  return {
    Accept: "application/json, text/plain, */*",
    Authorization: authToken,
    "fms-token": fmsToken,
    "company-id": COMPANY_ID,
    "fms-client": FMS_CLIENT,
    "Content-Type": "application/json"
  };
}

/* =====================================================
   FETCH WITH RETRY
=====================================================*/

async function fmsFetch(url, options = {}, retry = 0) {

  const headers = await getHeaders();

  const resp = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {})
    }
  });

  // Retry if token expired
  if ((resp.status === 401 || resp.status === 403) && retry < 1) {
    await fmsLogin(true);
    return fmsFetch(url, options, retry + 1);
  }

  return resp;
}

/* =====================================================
   NORMALIZATION
=====================================================*/

const clean = (v) => String(v ?? "").trim();

function normalizeTask(t) {

  return {
    do: clean(t.order_no),
    pro: clean(t.tracking_no),
    pu: clean(t.pu_no),
    taskNo: Number(t.task_no),
    type: clean(t.task_type_text),
    status: clean(t.status_text),
    complete:
      clean(t.status_text).toLowerCase() === "complete"
  };
}

/* =====================================================
   API HANDLER
=====================================================*/

export default async function handler(req, res) {

  try {

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { action, tripNo, task } = req.body || {};

    /* ------------------------------------------------ */

    // ✅ GET TASKS
    if (action === "getTasks") {

      if (!tripNo) {
        return res.status(400).json({ error: "tripNo required" });
      }

      const url =
        `${TASKS_URL}?tripNo=${encodeURIComponent(tripNo)}`;

      const resp = await fmsFetch(url, {
        method: "GET"
      });

      if (!resp.ok) {
        const t = await resp.text();
        return res.status(resp.status).json({
          error: "FMS request failed",
          status: resp.status,
          details: t
        });
      }

      const json = await resp.json();

      const raw = json?.data || [];

      const tasks = raw.map(normalizeTask);

      return res.json({
        tripNo,
        count: tasks.length,
        tasks
      });
    }

    /* ------------------------------------------------ */

    // ✅ CHECK IN TASK
    if (action === "checkin") {

      if (!tripNo || !task?.taskNo) {
        return res.status(400).json({
          error: "tripNo + task.taskNo required"
        });
      }

      const resp = await fmsFetch(CHECKIN_URL, {
        method: "POST",
        body: JSON.stringify({
          tripNo,
          taskNo: task.taskNo
        })
      });

      return res.json({
        success: resp.ok,
        status: resp.status,
        taskNo: task.taskNo
      });
    }

    /* ------------------------------------------------ */

    // ✅ UNDO CHECKIN
    if (action === "undo") {

      if (!tripNo || !task?.taskNo) {
        return res.status(400).json({
          error: "tripNo + task.taskNo required"
        });
      }

      const resp = await fmsFetch(UNDO_URL, {
        method: "POST",
        body: JSON.stringify({
          tripNo,
          taskNo: task.taskNo
        })
      });

      return res.json({
        success: resp.ok,
        status: resp.status,
        taskNo: task.taskNo
      });
    }

    /* ------------------------------------------------ */

    return res.status(400).json({
      error: "Unknown action"
    });

  } catch (err) {

    console.error("🔥 FMS BOT ERROR:", err);

    return res.status(500).json({
      error: "Internal server error",
      message: err.message || String(err)
    });
  }
}
