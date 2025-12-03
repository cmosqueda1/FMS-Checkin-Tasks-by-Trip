// fms.js
// Unified FMS task loader for Trip Check-in Bot
// Uses active browser session cookies / tokens
// Endpoint:
//   GET https://fms.item.com/fms-platform-dispatch-management/TripDetail/GetTaskList?tripNo=XXXX

export default async function handler(req, res) {
  try {

    // ========================
    // METHOD VALIDATION
    // ========================
    if (req.method !== "POST") {
      return res.status(405).json({
        error: "Method not allowed. Use POST.",
        example: { tripNo: "B01KJY" }
      });
    }

    // ========================
    // INPUT VALIDATION
    // ========================
    const { tripNo } = req.body || {};

    if (!tripNo || typeof tripNo !== "string") {
      return res.status(400).json({
        error: "tripNo is required",
        example: { tripNo: "B01KJY" }
      });
    }

    // ========================
    // CALL REAL FMS API
    // ========================
    const FMS_URL =
      "https://fms.item.com/fms-platform-dispatch-management/TripDetail/GetTaskList" +
      `?tripNo=${encodeURIComponent(tripNo.trim())}`;

    const response = await fetch(FMS_URL, {
      method: "GET",

      // ✅ REQUIRED
      // Sends the active browser session cookies:
      // fms-token, authorization, company-id, etc.
      credentials: "include",

      headers: {
        accept: "application/json, text/plain, */*"
      }
    });

    // ========================
    // NETWORK FAIL HANDLING
    // ========================
    if (!response.ok) {
      const text = await response.text();

      return res.status(response.status).json({
        error: "FMS request failed",
        http_status: response.status,
        details: text
      });
    }

    const fms = await response.json();

    // ========================
    // RESPONSE VALIDATION
    // ========================
    if (!fms || fms.is_success !== true || !Array.isArray(fms.data)) {
      return res.status(500).json({
        error: "Invalid FMS response format",
        raw: fms
      });
    }

    // ========================
    // NORMALIZE TASKS
    // ========================
    const tasks = fms.data.map(task => {

      const doNum =
        task.order_no ||
        task.shipment_order_no ||
        "";

      const proNum =
        task.tracking_no ||
        task.invoice_pro ||
        "";

      const puNum =
        task.pu_no ||
        "";

      const taskType =
        task.task_type_text ||
        "";

      const status =
        task.status_text ||
        "";

      return {
        do: doNum,
        pro: proNum,
        pu: puNum,

        // Internal FMS identifiers
        taskNo: task.task_no,

        // Classification
        type: taskType,

        // Completion state
        status: status,
        complete: status.toLowerCase().includes("complete")
      };
    });

    // ========================
    // FINAL RESPONSE
    // ========================
    return res.status(200).json({
      tripNo: tripNo.trim(),
      taskCount: tasks.length,
      tasks
    });

  } catch (err) {
    console.error("FMS HANDLER ERROR:", err);

    return res.status(500).json({
      error: "Internal server error",
      message: err.message
    });
  }
}
