let cachedToken = null;
let lastLoginTime = 0;

// =================================================
// LOGIN FUNCTION (CORRECTED FROM HAR FILE)
// =================================================
async function loginToFms() {
  const now = Date.now();
  const expired = now - lastLoginTime > 25 * 60 * 1000;

  if (cachedToken && !expired) return cachedToken;

  console.log("🔐 Logging into FMS...");

  const loginRes = await fetch("https://fms.item.com/fms-platform-user/Auth/Login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "fms-client": "FMS_WEB",
      "Origin": "https://fms.item.com",
      "Referer": "https://fms.item.com/"
    },
    body: JSON.stringify({
      account: "RaulEscobar",
      password: "FMSoffload1!"
    })
  });

  const json = await loginRes.json();

  if (!json?.data?.token) {
    console.error("❌ FMS Login Failed Response:", json);
    throw new Error("Failed to login to FMS");
  }

  cachedToken = json.data.token;
  lastLoginTime = now;

  console.log("✅ FMS Login Successful");

  return cachedToken;
}

// =================================================
// MAIN HANDLER
// =================================================
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { action } = req.body;

  let token;
  try {
    token = await loginToFms();
  } catch (err) {
    return res.status(500).json({ error: "Login failed", details: err.message });
  }

  // =========================================
  // 1️⃣ GET TRIP TASK LIST (correct API)
  // =========================================
  if (action === "getTasks") {
    const { trip } = req.body;

    try {
      const url = `https://fms.item.com/fms-platform-dispatch-management/TripDetail/GetTaskList?tripNo=${trip}`;

      const apiRes = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "authorization": token,
          "company-id": "SBFH",
          "fms-client": "FMS_WEB"
        }
      });

      const json = await apiRes.json();

      // Normalize
      const tasks = (json.data || []).map(t => ({
        do: t.order_no || "",
        pro: t.tracking_no || "",
        pu: t.pu_no || "",
        taskNo: t.task_no || "",
        type: t.task_type_text || "",
        complete: (t.status || "").toLowerCase() === "complete"
      }));

      return res.status(200).json({ tasks });

    } catch (err) {
      return res.status(500).json({
        error: "Failed to fetch tasks",
        details: err.message
      });
    }
  }

  // =========================================
  // 2️⃣ UPDATE TASKS (TEMP RETURNS TEST)
  // =========================================
  if (action === "update") {
    return res.status(200).json({
      result: "TEST"
    });
  }

  return res.status(400).json({ error: "Invalid action" });
}
