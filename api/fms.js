// /api/fms.js
// Single serverless router for ALL Trip Check-In Bot backend actions
// Uses the same FMS login/token pattern as check-status-pro.js

/* ========================
   CONFIG
======================== */
const FMS_BASE       = process.env.FMS_BASE_URL   || "https://fms.item.com";
const FMS_COMPANY_ID = process.env.FMS_COMPANY_ID || "SBFH";
const FMS_CLIENT     = process.env.FMS_CLIENT     || "FMS_WEB";
const FMS_USER       = process.env.FMS_USER;
const FMS_PASS       = process.env.FMS_PASS;

const FMS_LOGIN_URL      = `${FMS_BASE}/fms-platform-user/Auth/Login`;
const FMS_TRIP_TASKS_URL = `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/GetTaskList`;
const FMS_CHECKIN_URL    = `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/TaskCheckIn`;
const FMS_UNDO_URL       = `${FMS_BASE}/fms-platform-dispatch-management/TripDetail/CancelTaskCheckIn`;

let FMS_TOKEN = null;
let FMS_TOKEN_EXPIRES_AT = 0; // ms timestamp, simple TTL cache

/* ========================
   HELPERS
======================== */
const clean = (v) => (v == null ? "" : String(v).trim());

async function authFms(force = false) {
  const now = Date.now();

  // If we have a token and it's not expired, reuse it
  if (!force && FMS_TOKEN && now < FMS_TOKEN_EXPIRES_AT) {
    return FMS_TOKEN;
  }

  if (!FMS_USER || !FMS_PASS) {
    throw new Error("Missing FMS_USER / FMS_PASS environment variables");
  }

  const resp = await fetch(FMS_LOGIN_URL, {
    method: "POST",
    headers: {
      "fms-client": FMS_CLIENT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      account: FMS_USER,
      password: FMS_PASS,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`FMS auth HTTP ${resp.status}: ${text}`);
  }

  const data = await resp.json().catch(() => ({}));
  const token =
    data.token ||
    data?.data?.token ||
    data?.result?.token ||
    "";

  if (!token) {
    throw new Error("FMS auth: no token returned");
  }

  FMS_TOKEN = token;
  // simple TTL ~55 minutes
  FMS_TOKEN_EXPIRES_AT = Date.now() + 55 * 60 * 1000;

  return FMS_TOKEN;
}

function buildFmsHeaders(extra = {}) {
  return {
    "accept": "application/json, text/plain, */*",
    "fms-client": FMS_CLIENT,
    "fms-token": FMS_TOKEN || "",
    "Company-Id": FMS_COMPANY_ID,
    ...extra,
  };
}

/**
 * Generic FMS fetch with one retry on 401/403 (token refresh)
 */
async function fmsFetchWithRetry(url, options = {}, retry = true) {
  await authFms(); // ensure we have a token

  let resp = await fetch(url, {
    ...options,
    headers: buildFmsHeaders(options.headers || {}),
  });

  if ((resp.status === 401 || resp.status === 403) && retry) {
    // token might be expired or invalid → force re-auth and retry once
    await authFms(true);
    resp = await fetch(url, {
      ...options,
      headers: buildFmsHeaders(options.headers || {}),
    });
  }

  return resp;
}

/* ========================
   NORMALIZATION
======================== */
function normalizeTask(t) {
  const status  = clean(t.status_text || t.status);
  const typeRaw = clean(t.task_type_text || t.taskType || "");
  const l       = typeRaw.toLowerCase();

  let taskType = "";
  if (l.includes("delivery"))        taskType = "Delivery";
  else if (l.includes("pickup"))     taskType = "Pickup";
  else if (l.includes("linehaul") ||
           l.includes("transfer"))   taskType = "Linehaul";
  else                               taskType = typeRaw || "Other";

  return {
    do:      clean(t.order_no || t.do),
    pro:     clean(t.tracking_no || t.pro),
    pu:      clean(t.pu_no || t.reference5 || t.pu),
    taskNo:  t.task_no || t.taskNo || 0,
    taskType,
    status,
  };
}

/* ========================
   MAIN HANDLER
======================== */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const { action } = body;

  if (!action) {
    return res.status(400).json({ error: "Missing action" });
  }

  try {
    switch (action) {
      // =====================================================
      // 1) FETCH FMS TRIP TASKS
      // =====================================================
      case "getTasks": {
        const { tripNo } = body;
        if (!tripNo) {
          return res.status(400).json({ error: "tripNo required" });
        }

        const url = `${FMS_TRIP_TASKS_URL}?tripNo=${encodeURIComponent(
          tripNo
        )}`;

        const fmsResp = await fmsFetchWithRetry(url, { method: "GET" });
        const text = await fmsResp.text();

        if (!fmsResp.ok) {
          return res.status(500).json({
            error: "FMS request failed",
            details: text,
          });
        }

        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          return res.status(500).json({
            error: "Invalid JSON from FMS",
            raw: text,
          });
        }

        const raw = Array.isArray(data?.tasks)
          ? data.tasks
          : Array.isArray(data)
          ? data
          : [];

        const tasks = raw.map(normalizeTask);

        return res.status(200).json({ tripNo, tasks });
      }

      // =====================================================
      // 2) APPLY CHECK-IN
      // =====================================================
      case "checkin": {
        const { tripNo, task } = body;
        if (!tripNo || !task || !task.taskNo) {
          return res.status(400).json({
            error: "tripNo and task.taskNo required",
          });
        }

        const payload = {
          tripNo,
          taskNo: task.taskNo,
        };

        const resp = await fmsFetchWithRetry(
          FMS_CHECKIN_URL,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          }
        );

        return res.status(200).json({
          success: resp.ok,
          tripNo,
          taskNo: task.taskNo,
          statusCode: resp.status,
        });
      }

      // =====================================================
      // 3) APPLY UNDO CHECK-IN
      // =====================================================
      case "undo": {
        const { tripNo, task } = body;
        if (!tripNo || !task || !task.taskNo) {
          return res.status(400).json({
            error: "tripNo and task.taskNo required",
          });
        }

        const payload = {
          tripNo,
          taskNo: task.taskNo,
        };

        const resp = await fmsFetchWithRetry(
          FMS_UNDO_URL,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          }
        );

        return res.status(200).json({
          success: resp.ok,
          tripNo,
          taskNo: task.taskNo,
          statusCode: resp.status,
        });
      }

      // =====================================================
      // INVALID ACTION
      // =====================================================
      default:
        return res.status(400).json({ error: "Unknown action: " + action });
    }
  } catch (err) {
    console.error("FMS router error:", err);
    res.status(500).json({
      error: "Internal Server Error",
      details: String(err),
    });
  }
}
