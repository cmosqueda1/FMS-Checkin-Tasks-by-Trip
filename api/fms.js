let cachedJwt = null;        // data.token (short JWT)
let cachedRsa = null;        // data.third_party_token (long RSA)
let lastLoginTime = 0;

// ===========================================================
// LOGIN FUNCTION (CORRECTED FROM YOUR HAR FILE)
// ===========================================================
async function loginToFms() {
  const now = Date.now();
  const expired = now - lastLoginTime > 25 * 60 * 1000; // 25 minutes

  if (cachedJwt && cachedRsa && !expired) {
    return { jwt: cachedJwt, rsa: cachedRsa };
  }

  console.log("🔐 Logging into FMS...");

  const res = await fetch("https://fms.item.com/fms-platform-user/Auth/Login", {
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

  const json = await res.json();

  if (!json?.data?.token || !json?.data?.third_party_token) {
    console.log("❌ LOGIN FAILED RESPONSE:", json);
    throw new Error("Failed to login to FMS");
  }

  // Store both tokens
  cachedJwt = json.data.token;                 // short token (used for fms-token)
  cachedRsa = json.data.third_party_token;     // long RSA (used for authorization)

  lastLoginTime = now;

  console.log("✅ FMS Login Successful");

  return { jwt: cachedJwt, rsa: cachedRsa };
}

// ===========================================================
// MAIN SERVERLESS HANDLER
// ===========================================================
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { action } = req.body;

  // Login first
  let tokens;
  try {
    tokens = await loginToFms();
  } catch (err) {
    return res.status(500).json({ error: "Login failed", details: err.message });
  }

  // ===========================================================
  // 1️⃣ GET TRIP TASKS (using CORRECT API + BOTH TOKENS)
  // ===========================================================
  if (action === "getTasks") {
    const { trip } = req.body;

    try {
      const url =
        `https://fms.item.com/fms-platform-dispatch-management/TripDetail/GetTaskList?tripNo=${trip}`;

      const apiRes = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "authorization": tokens.rsa,    // RSA TOKEN REQUIRED
          "fms-token": tokens.jwt,        // JWT TOKEN REQUIRED
          "company-id": "SBFH",
          "fms-client": "FMS_WEB"
        }
      });

      const json = await apiRes.json();

      console.log("🔥 RAW TASK API RESPONSE:", json);

      // Normalize tasks
      const tasks = (json.data || []).map(t => {
        const statusText = t?.status?.text || "";   // FIX: status is object

        return {
          do: t.order_no || "",
          pro: t.tracking_no || "",
          pu: t.pu_no || "",
          taskNo: t.task_no || "",
          type: t.task_type_text || "",
          status: statusText,
          complete: statusText.toLowerCase() === "complete"
        };
      });

      return res.status(200).json({ tasks });

    } catch (err) {
      console.log("❌ Task Fetch Failed:", err);
      return res.status(500).json({
        error: "Failed to fetch tasks",
        details: err.message
      });
    }
  }

  // ===========================================================
  // 2️⃣ UPDATE TASKS (TEMP: return TEST for now)
  // ===========================================================
  if (action === "update") {
    return res.status(200).json({
      result: "TEST"
    });
  }

  // ===========================================================
  // UNKNOWN ACTION
  // ===========================================================
  return res.status(400).json({ error: "Invalid action" });
}
