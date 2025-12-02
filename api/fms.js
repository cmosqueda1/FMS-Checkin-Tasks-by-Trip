let cachedJwt = null;
let cachedRsa = null;
let lastLoginTime = 0;

// ===========================================================
// LOGIN FUNCTION
// ===========================================================
async function loginToFms() {
  const now = Date.now();
  const expired = now - lastLoginTime > 25 * 60 * 1000;

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

  cachedJwt = json.data.token;
  cachedRsa = json.data.third_party_token;
  lastLoginTime = now;

  console.log("✅ FMS Login Successful");

  return { jwt: cachedJwt, rsa: cachedRsa };
}

// ===========================================================
// MAIN HANDLER
// ===========================================================
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { action } = req.body;

  let tokens;
  try {
    tokens = await loginToFms();
  } catch (err) {
    return res.status(500).json({ error: "Login failed", details: err.message });
  }

  // ===========================================================
  // 1️⃣ GET TASK LIST + STATUS
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
          "authorization": tokens.rsa,
          "fms-token": tokens.jwt,
          "company-id": "SBFH",
          "fms-client": "FMS_WEB"
        }
      });

      const json = await apiRes.json();

      console.log("🔥 RAW TASK API RESPONSE:", json);

      const tasks = (json.data || []).map(t => {
        // Extract inner reference outputs (true status)
        const ref = Array.isArray(t.reference_outputs)
          ? t.reference_outputs[0]
          : null;

        const statusText = ref?.status_text || "";

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
  // 2️⃣ UPDATE (TEMP RETURNS TEST)
  // ===========================================================
  if (action === "update") {
    return res.status(200).json({
      result: "TEST"
    });
  }

  return res.status(400).json({ error: "Invalid action" });
}
