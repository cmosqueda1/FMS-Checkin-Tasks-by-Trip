// fms.js
// Unified FMS Task Loader – FULL LOGIN FLOW
//
// Requires environment variables set in Vercel:
//   FMS_USER = your FMS username
//   FMS_PASS = your FMS password
//
// Flow:
//   1) Login to FMS
//   2) Capture JWT + fms-token + company-id
//   3) Call GetTaskList for Trip
//   4) Normalize results

// --------------------------------------------------

async function fmsLogin() {
  const LOGIN_URL = "https://id.item.com/connect/token";

  const params = new URLSearchParams({
    grant_type: "password",
    client_id: "fms all",
    username: process.env.FMS_USER,
    password: process.env.FMS_PASS
  });

  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`FMS login failed: ${txt}`);
  }

  return await res.json();
}


// --------------------------------------------------
// API Handler
// --------------------------------------------------

export default async function handler(req, res) {

  try {

    // -------------------------
    // Validate input
    // -------------------------
    if (req.method !== "POST") {
      return res.status(405).json({
        error: "Method not allowed",
        example: { tripNo: "B01KJY" }
      });
    }

    const { tripNo } = req.body || {};

    if (!tripNo) {
      return res.status(400).json({
        error: "tripNo is required"
      });
    }

    // -------------------------
    // LOGIN
    // -------------------------
    const login = await fmsLogin();

    // Tokens from oauth login
    const AUTH_TOKEN = login.access_token;
    const REFRESH = login.refresh_token; // unused now

    if (!AUTH_TOKEN) {
      throw new Error("Login succeeded but no access token returned.");
    }

    // -------------------------
    // FETCH TASKS
    // -------------------------
    const TASK_URL =
      "https://fms.item.com/fms-platform-dispatch-management/TripDetail/GetTaskList" +
      `?tripNo=${encodeURIComponent(tripNo.trim())}`;

    const fmsRes = await fetch(TASK_URL, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "fms-client": "FMS_WEB"
      }
    });

    if (!fmsRes.ok) {
      const t = await fmsRes.text();

      return res.status(fmsRes.status).json({
        error: "FMS request failed",
        http_status: fmsRes.status,
        details: t
      });
    }

    const data = await fmsRes.json();

    // -------------------------
    // Validate result
    // -------------------------
    if (!data || !data.is_success || !Array.isArray(data.data)) {
      return res.status(500).json({
        error: "Unexpected FMS response",
        raw: data
      });
    }

    // -------------------------
    // Normalize tasks
    // -------------------------
    const tasks = data.data.map(task => ({
      do: task.order_no || "",
      pro: task.tracking_no || "",
      pu: task.pu_no || "",
      taskNo: task.task_no,
      type: task.task_type_text || "",
      status: task.status_text || "",
      complete: String(task.status_text)
        .toLowerCase()
        .includes("complete")
    }));

    // -------------------------
    // Final Response
    // -------------------------
    return res.status(200).json({
      tripNo,
      taskCount: tasks.length,
      tasks
    });

  } catch (err) {

    console.error("FMS BOT ERROR:", err);

    return res.status(500).json({
      error: "Internal server error",
      message: err.message
    });

  }
}
