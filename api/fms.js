let cachedToken = null;
let cachedUserId = null;
let lastLoginTime = 0;

// Auto-login helper (FMS)
async function ensureFmsLogin() {
  const now = Date.now();
  const tokenExpired = now - lastLoginTime > 25 * 60 * 1000; // 25 minutes

  if (cachedToken && !tokenExpired) {
    return cachedToken;
  }

  console.log("🔐 Logging into FMS…");

  const loginRes = await fetch("https://fms.item.com/fms-platform-user/sys/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "RaulEscobar",
      password: "FMSoffload1!"
    })
  });

  const loginJson = await loginRes.json();

  if (!loginJson?.data?.token) {
    throw new Error("Failed to login to FMS");
  }

  cachedToken = loginJson.data.token;
  cachedUserId = loginJson.data.userInfo?.userId || null;
  lastLoginTime = now;

  console.log("✅ FMS Login Successful");

  return cachedToken;
}

// =============================
// MAIN HANDLER
// =============================
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { action } = req.body;

  // Login before any action
  let token;
  try {
    token = await ensureFmsLogin();
  } catch (err) {
    return res.status(500).json({ error: "Login failed", details: err.message });
  }

  // =======================================================
  // 1️⃣ GET TRIP TASKS
  // =======================================================
  if (action === "getTasks") {
    const { trip } = req.body;

    try {
      const url = `https://fms.item.com/fms-platform-order/driver-app/task/get-tasks/${trip}`;

      const fmsRes = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        }
      });

      const json = await fmsRes.json();

      const tasks = (json.data || []).map(t => ({
        do: t.order_no || "",
        pro: t.tracking_no || "",
        pu: t.pu_no || "",
        complete: t.status === "Complete",
        taskNo: t.task_no,
        type: t.task_type_text || ""
      }));

      return res.status(200).json({ tasks });

    } catch (err) {
      return res.status(500).json({
        error: "Failed to fetch tasks",
        details: err.message
      });
    }
  }

  // =======================================================
  // 2️⃣ UPDATE TASKS (TEMP: TEST)
  // =======================================================
  if (action === "update") {
    return res.status(200).json({ result: "TEST" });
  }

  // =======================================================
  // INVALID ACTION
  // =======================================================
  return res.status(400).json({ error: "Invalid action" });
}
